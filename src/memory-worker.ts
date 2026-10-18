import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config/env.js'
import { createSupabaseAdmin, createSupabaseSchemaClient } from './infrastructure/supabase.js'
import { RedisStreams, type StreamMessage } from './queue/redis-streams.js'
import { MemoryRepository, type MemoryTask } from './modules/memory/repository.js'
import { ConversationRepository } from './modules/conversations/repository.js'
import {
  fallbackConversationTitle,
  normalizeConversationTitle,
  titlePrompt,
} from './modules/conversations/title.js'
import { DeepSeekClient } from './integrations/deepseek.js'
import { EmbeddingClient } from './integrations/embedding.js'
import { LangfuseTracer, type TraceContext } from './observability/langfuse.js'
import {
  limitSummaryTokens,
  SUMMARY_PROMPT_VERSION,
  summaryPrompt,
  takeSummaryBatch,
} from './modules/memory/conversation-summary.js'
import { z } from 'zod'

const config = loadConfig()
const tracer = new LangfuseTracer(config)
const db = createSupabaseSchemaClient(createSupabaseAdmin(config), config.SUPABASE_DB_SCHEMA)
const queue = new RedisStreams(config)
const memories = new MemoryRepository(db)
const conversations = new ConversationRepository(db)
const model = new DeepSeekClient(config, tracer)
const embedding = new EmbeddingClient(config, tracer)
const consumer = `${process.env.HOSTNAME ?? 'memory'}-${randomUUID()}`
const memoryStream = config.REDIS_STREAM_MEMORY ?? 'ownagent:memory-tasks'
const memoryDeadLetter = config.REDIS_STREAM_MEMORY_DEAD_LETTER ?? 'ownagent:memory-dead-letter'
const memoryConcurrency = config.MEMORY_CONCURRENCY ?? 2
const memoryMaxAttempts = config.MEMORY_MAX_ATTEMPTS ?? 5
const memoryTimeoutMs = config.MEMORY_TIMEOUT_MS ?? 120_000
const embeddingEnabled = config.MEMORY_EMBEDDING_ENABLED ?? true
const active = new Set<Promise<void>>()
let stopping = false

const summarySchema = z.object({ summary: z.string().trim().min(1).max(12000) })
const titleSchema = z.object({ title: z.string().max(120) })
const reviewSchema = z.object({
  approved: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500).optional(),
})
const consolidationSchema = z.object({
  merged: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        type: z.enum(['preference', 'fact', 'instruction']),
        value: z.record(z.string(), z.unknown()),
        summary: z.string().max(500),
        confidence: z.number().min(0).max(1),
      })
    )
    .max(100),
})
async function lease(message: StreamMessage, fn: () => Promise<void>) {
  const timer = setInterval(
    () =>
      void queue
        .touch(memoryStream, config.REDIS_CONSUMER_GROUP, consumer, message.id)
        .catch(() => undefined),
    Math.max(10_000, Math.floor(config.REDIS_RECLAIM_IDLE_MS / 3))
  )
  try {
    await fn()
  } finally {
    clearInterval(timer)
  }
}
async function execute(
  task: MemoryTask,
  trace?: TraceContext
): Promise<Record<string, unknown> | undefined> {
  const payload = task.payload as Record<string, any>
  if (task.taskType === 'persist_candidate') {
    if (!task.userId || !payload.candidate) throw new Error('INVALID_MEMORY_CANDIDATE_TASK')
    const item = await memories.persistCandidate({
      workspaceId: task.workspaceId,
      userId: task.userId,
      conversationId: task.conversationId,
      runId: task.runId,
      candidate: payload.candidate,
    })
    if (item.status === 'pending_confirmation')
      await memories.enqueueTask({
        workspaceId: task.workspaceId,
        userId: task.userId,
        runId: task.runId,
        memoryItemId: item.id,
        taskType: 'review_candidate',
        payload: { memoryItemId: item.id, candidate: payload.candidate },
      })
    if (item.status === 'active')
      await memories.enqueueTask({
        workspaceId: task.workspaceId,
        userId: task.userId,
        runId: task.runId,
        taskType: 'consolidate_memories',
        payload: { scope: payload.candidate.scope },
      })
    if (embeddingEnabled && item.status === 'active')
      await memories.enqueueTask({
        workspaceId: task.workspaceId,
        userId: task.userId,
        runId: task.runId,
        memoryItemId: item.id,
        taskType: 'embed_memory',
        payload: { memoryItemId: item.id },
      })
    return
  }
  if (task.taskType === 'embed_memory') {
    if (!task.memoryItemId) throw new Error('MEMORY_ITEM_REQUIRED')
    const item = await memories.get(task.memoryItemId, task.userId ?? '', task.workspaceId)
    if (!item || item.status !== 'active') return
    const result = await embedding.embed(`${item.key}: ${item.summary}`, trace, 'memory.embedding')
    await memories.updateEmbedding(item.id, result.data[0]?.embedding ?? [], config.EMBEDDING_MODEL)
    return
  }
  if (task.taskType === 'summarize_conversation') {
    if (!task.conversationId) throw new Error('CONVERSATION_REQUIRED')
    if (!model.isConfigured()) throw new Error('MODEL_UNAVAILABLE')
    const inputBudget = config.CONVERSATION_SUMMARY_INPUT_TOKENS ?? 6_000
    const outputBudget = config.CONVERSATION_SUMMARY_OUTPUT_TOKENS ?? 1_600
    let writeRetries = 0
    let batches = 0
    let deltaMessages = 0
    let estimatedInputTokens = 0
    let finalCoveredUntilMessageId: string | undefined
    while (writeRetries <= 2) {
      const current = await conversations.summaryRecord(task.conversationId)
      let messages = current
        ? await conversations.summaryMessages(task.conversationId, current.coveredUntilMessageId)
        : await conversations.summaryMessages(task.conversationId)
      let previousSummary = current?.summary ?? ''
      let expectedPointer: 'value' | 'null' | 'any' = current
        ? current.coveredUntilMessageId
          ? 'value'
          : 'null'
        : 'any'
      if (messages === undefined) {
        // A deleted checkpoint cannot safely identify the delta. Rebuild from
        // the oldest available message and replace the stale summary.
        messages = await conversations.summaryMessages(task.conversationId)
        previousSummary = ''
        expectedPointer = current?.coveredUntilMessageId ? 'value' : current ? 'null' : 'any'
      }
      if (!messages) return { summaryUpdated: false, reason: 'checkpoint_missing' }
      if (!messages.length) return { summaryUpdated: false, reason: 'no_new_messages' }
      if (!current && messages.length < (config.CONVERSATION_SUMMARY_THRESHOLD ?? 30))
        return { summaryUpdated: false, reason: 'below_threshold' }

      const batch = takeSummaryBatch(messages, previousSummary, inputBudget)
      if (!batch.batch.length) return { summaryUpdated: false, reason: 'empty_batch' }
      batches += 1
      deltaMessages += batch.batch.length
      estimatedInputTokens += batch.estimatedTokens
      const result = await model.chatJson(
        [
          {
            role: 'system',
            content: `你是会话摘要合并器。只输出 JSON：{"summary":"..."}。将已有摘要与新增消息合并为完整、简洁、可审计的会话摘要。保留仍有效的事实、实体规范名称、用户偏好、回答要求、已解决结论、未解决问题、文档标题和引用关系；以最新消息纠正旧信息，删除明确被否定的信息。不要添加对话外事实、隐藏推理或模型过程。摘要目标不超过约 ${outputBudget} tokens。`,
          },
          { role: 'user', content: summaryPrompt(previousSummary, batch.batch) },
        ],
        summarySchema,
        {
          model: config.DEEPSEEK_MODEL,
          timeoutMs: memoryTimeoutMs,
          maxRetries: 1,
          trace,
          operation: 'memory.summarize_conversation',
        }
      )
      const summary = limitSummaryTokens(result.summary, outputBudget)
      const lastMessageId = batch.batch.at(-1)?.id
      if (!lastMessageId) return
      const saved = await memories.saveSummaryIfUnchanged({
        conversationId: task.conversationId,
        summary,
        coveredUntilMessageId: lastMessageId,
        model: config.DEEPSEEK_MODEL,
        promptVersion: SUMMARY_PROMPT_VERSION,
        expectedExists: Boolean(current),
        expectedCoveredUntilMessageId:
          expectedPointer === 'value' ? current?.coveredUntilMessageId : undefined,
        expectedPointer,
      })
      if (!saved) {
        writeRetries += 1
        continue
      }
      finalCoveredUntilMessageId = lastMessageId
      // Process another token-bounded batch in the same task. Re-reading the
      // record also makes the next batch use the persisted checkpoint.
      if (batch.remaining.length) continue
      return {
        summaryUpdated: true,
        batches,
        deltaMessages,
        estimatedInputTokens,
        summaryLength: summary.length,
        finalCoveredUntilMessageId,
      }
    }
    throw new Error(`SUMMARY_CONCURRENT_UPDATE after ${writeRetries} retries`)
  }
  if (task.taskType === 'update_conversation_title') {
    if (!task.conversationId) throw new Error('CONVERSATION_REQUIRED')
    const messages = await conversations.recent(task.conversationId, 50)
    if (!messages.length) return
    const expectedLastMessageId =
      typeof payload.lastMessageId === 'string' ? payload.lastMessageId : messages.at(-1)?.id
    const fallback = fallbackConversationTitle(messages)
    let title = fallback
    if (model.isConfigured()) {
      try {
        const result = await model.chatJson(
          [
            {
              role: 'system',
              content:
                '你是会话标题生成器。只根据给定对话输出 JSON，格式必须是 {"title":"..."}。标题要简洁、具体、可扫描，长度约 6-18 个汉字或等价英文长度，跟随对话主要语言，不要添加引号、Markdown、前缀、句号或解释。',
            },
            { role: 'user', content: titlePrompt(messages) },
          ],
          titleSchema,
          {
            model: config.DEEPSEEK_MODEL,
            timeoutMs: memoryTimeoutMs,
            maxRetries: 1,
            trace,
            operation: 'memory.update_title',
          }
        )
        title = normalizeConversationTitle(result.title, fallback)
      } catch {
        title = fallback
      }
    }
    await conversations.updateTitleIfLatest(task.conversationId, title, expectedLastMessageId)
    return
  }
  if (task.taskType === 'expire_memories') {
    await memories.expire()
    return
  }
  if (task.taskType === 'review_candidate') {
    if (!task.memoryItemId || !task.userId || !model.isConfigured())
      throw new Error('INVALID_MEMORY_REVIEW_TASK')
    const item = await memories.get(task.memoryItemId, task.userId, task.workspaceId)
    if (!item || item.status !== 'pending_confirmation') return
    const decision = await model.chatJson(
      [
        {
          role: 'system',
          content:
            '你是记忆安全复核器。只能根据给定记忆判断是否为用户明确表达的、非敏感且可长期保存的信息。敏感信息不得批准。只输出 JSON。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            summary: item.summary,
            type: item.type,
            sensitivity: item.sensitivity,
            value: item.value,
          }),
        },
      ],
      reviewSchema,
      {
        model: config.DEEPSEEK_MODEL,
        timeoutMs: memoryTimeoutMs,
        maxRetries: 1,
        trace,
        operation: 'memory.review_candidate',
      }
    )
    if (decision.approved && decision.confidence >= 0.85 && item.sensitivity === 'normal') {
      const activated = await memories.activateReviewed(
        item.id,
        task.userId,
        task.workspaceId,
        decision.confidence
      )
      if (activated && embeddingEnabled)
        await memories.enqueueTask({
          workspaceId: task.workspaceId,
          userId: task.userId,
          memoryItemId: activated.id,
          taskType: 'embed_memory',
          payload: { memoryItemId: activated.id },
        })
    }
    return
  }
  if (task.taskType === 'consolidate_memories') {
    if (!task.userId || !model.isConfigured()) throw new Error('INVALID_MEMORY_CONSOLIDATION_TASK')
    const scope = payload.scope === 'workspace' ? 'workspace' : 'user'
    const items = await memories.activeForScope(task.workspaceId, task.userId, scope)
    if (items.length < 2) return
    const result = await model.chatJson(
      [
        {
          role: 'system',
          content:
            '你是长期记忆合并器。只能合并给定的同一权限范围记忆；不得发明事实。每个 key 最多输出一个结果，只输出 JSON。',
        },
        {
          role: 'user',
          content: JSON.stringify(
            items.map(item => ({
              id: item.id,
              key: item.key,
              type: item.type,
              value: item.value,
              summary: item.summary,
              confidence: item.confidence,
            }))
          ),
        },
      ],
      consolidationSchema,
      {
        model: config.DEEPSEEK_MODEL,
        timeoutMs: memoryTimeoutMs,
        maxRetries: 1,
        trace,
        operation: 'memory.consolidate',
      }
    )
    const byKey = new Map(items.map(item => [item.key, item]))
    for (const merged of result.merged) {
      const source = byKey.get(merged.key)
      if (!source || merged.confidence < 0.85 || merged.type !== source.type) continue
      const created = await memories.create({
        workspaceId: task.workspaceId,
        userId: scope === 'user' ? task.userId : undefined,
        scope,
        type: merged.type,
        key: merged.key,
        value: merged.value,
        summary: merged.summary,
        confidence: merged.confidence,
        sensitivity: source.sensitivity,
        status: 'active',
        sourceRunId: task.runId,
      })
      await memories.archive(
        items
          .filter(item => item.key === merged.key && item.id !== created.id)
          .map(item => item.id),
        task.workspaceId
      )
      if (embeddingEnabled)
        await memories.enqueueTask({
          workspaceId: task.workspaceId,
          userId: task.userId,
          memoryItemId: created.id,
          taskType: 'embed_memory',
          payload: { memoryItemId: created.id },
        })
    }
    return
  }
  throw new Error('UNKNOWN_MEMORY_TASK')
}
async function processMessage(message: StreamMessage) {
  const payload = JSON.parse(message.values.payload ?? '{}') as { taskId?: string }
  if (!payload.taskId) return
  const task = await memories.claimTask(payload.taskId, consumer)
  if (!task) return
  const trace = tracer.startTrace({
    id: `memory-task-${task.id}-${task.attempt}`,
    name: 'memory-task',
    workspaceId: task.workspaceId,
    conversationId: task.conversationId,
    metadata: {
      taskId: task.id,
      runId: task.runId,
      taskType: task.taskType,
      attempt: task.attempt,
    },
  })
  const claimSpan = trace?.span('memory.claim', {
    taskId: task.id,
    runId: task.runId,
    attempt: task.attempt,
  })
  claimSpan?.end({ claimed: true })
  const taskSpan = trace?.span(`memory.${task.taskType}`, {
    taskId: task.id,
    runId: task.runId,
    attempt: task.attempt,
  })
  try {
    const execution = await Promise.race([
      execute(task, trace?.context),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MEMORY_TASK_TIMEOUT')), memoryTimeoutMs)
      ),
    ])
    await memories.markTaskCompleted(task.id)
    taskSpan?.end({ status: 'completed', taskType: task.taskType, ...(execution ?? {}) })
    trace?.update({ status: 'completed', taskId: task.id, taskType: task.taskType })
  } catch (error) {
    taskSpan?.fail(error, { taskId: task.id, taskType: task.taskType })
    const messageText = error instanceof Error ? error.message : 'MEMORY_TASK_FAILED'
    if (task.attempt < memoryMaxAttempts) {
      const delayMs = Math.min(60_000, 2 ** Math.max(0, task.attempt - 1) * 1000)
      trace?.update({
        status: 'retrying',
        taskId: task.id,
        taskType: task.taskType,
        attempt: task.attempt,
        error: messageText,
      })
      await memories.retryTask(task.id, messageText, delayMs)
      await new Promise(resolve => setTimeout(resolve, delayMs))
      await queue.publish(memoryStream, { taskId: task.id })
    } else {
      await memories.deadLetterTask(task.id, messageText)
      await queue.publishToStream(memoryDeadLetter, {
        taskId: task.id,
        workspaceId: task.workspaceId,
        taskType: task.taskType,
        error: messageText,
        attempt: task.attempt,
      })
      trace?.update({
        status: 'failed',
        taskId: task.id,
        taskType: task.taskType,
        error: messageText,
        deadLetter: true,
      })
    }
  } finally {
    await tracer.flushAsync()
  }
}
function launch(message: StreamMessage) {
  const task = lease(message, () => processMessage(message))
    .then(() => queue.ackAndDelete(memoryStream, config.REDIS_CONSUMER_GROUP, message.id))
    .catch(() => undefined)
    .finally(() => active.delete(task))
  active.add(task)
}
async function loop() {
  while (!stopping) {
    while (!stopping && active.size < memoryConcurrency) {
      const slots = memoryConcurrency - active.size
      const reclaimed = await queue.reclaim(
        memoryStream,
        config.REDIS_CONSUMER_GROUP,
        consumer,
        config.REDIS_RECLAIM_IDLE_MS,
        slots
      )
      if (reclaimed.length) {
        reclaimed.forEach(launch)
        continue
      }
      const messages = await queue.read(
        memoryStream,
        config.REDIS_CONSUMER_GROUP,
        consumer,
        slots,
        1000
      )
      if (!messages.length) break
      messages.forEach(launch)
    }
    if (active.size) await Promise.race(active)
  }
  await Promise.allSettled(active)
}
function shutdown() {
  stopping = true
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
await queue.ensureGroup(memoryStream)
console.log(`ownagent memory worker ${consumer} listening on ${memoryStream}`)
await loop()
await tracer.shutdownAsync()
await queue.close()
