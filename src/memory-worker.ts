import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config/env.js'
import { createSupabaseAdmin, createSupabaseSchemaClient } from './infrastructure/supabase.js'
import { RedisStreams, type StreamMessage } from './queue/redis-streams.js'
import { MemoryRepository, type MemoryTask } from './modules/memory/repository.js'
import { ConversationRepository } from './modules/conversations/repository.js'
import { DeepSeekClient } from './integrations/deepseek.js'
import { EmbeddingClient } from './integrations/embedding.js'
import { z } from 'zod'

const config = loadConfig()
const db = createSupabaseSchemaClient(createSupabaseAdmin(config), config.SUPABASE_DB_SCHEMA)
const queue = new RedisStreams(config)
const memories = new MemoryRepository(db)
const conversations = new ConversationRepository(db)
const model = new DeepSeekClient(config)
const embedding = new EmbeddingClient(config)
const consumer = `${process.env.HOSTNAME ?? 'memory'}-${randomUUID()}`
const memoryStream = config.REDIS_STREAM_MEMORY ?? 'ownagent:memory-tasks'
const memoryDeadLetter = config.REDIS_STREAM_MEMORY_DEAD_LETTER ?? 'ownagent:memory-dead-letter'
const memoryConcurrency = config.MEMORY_CONCURRENCY ?? 2
const memoryMaxAttempts = config.MEMORY_MAX_ATTEMPTS ?? 5
const memoryTimeoutMs = config.MEMORY_TIMEOUT_MS ?? 120_000
const embeddingEnabled = config.MEMORY_EMBEDDING_ENABLED ?? true
const active = new Set<Promise<void>>()
let stopping = false

const summarySchema = z.object({ summary: z.string().max(12000) })
const reviewSchema = z.object({ approved: z.boolean(), confidence: z.number().min(0).max(1), reason: z.string().max(500).optional() })
const consolidationSchema = z.object({ merged: z.array(z.object({ key: z.string().min(1).max(100), type: z.enum(['preference', 'fact', 'instruction']), value: z.record(z.string(), z.unknown()), summary: z.string().max(500), confidence: z.number().min(0).max(1) })).max(100) })
async function lease(message: StreamMessage, fn: () => Promise<void>) {
  const timer = setInterval(() => void queue.touch(memoryStream, config.REDIS_CONSUMER_GROUP, consumer, message.id).catch(() => undefined), Math.max(10_000, Math.floor(config.REDIS_RECLAIM_IDLE_MS / 3)))
  try { await fn() } finally { clearInterval(timer) }
}
async function execute(task: MemoryTask) {
  const payload = task.payload as Record<string, any>
  if (task.taskType === 'persist_candidate') {
    if (!task.userId || !payload.candidate) throw new Error('INVALID_MEMORY_CANDIDATE_TASK')
    const item = await memories.persistCandidate({ workspaceId: task.workspaceId, userId: task.userId, conversationId: task.conversationId, runId: task.runId, candidate: payload.candidate })
    if (item.status === 'pending_confirmation') await memories.enqueueTask({ workspaceId: task.workspaceId, userId: task.userId, runId: task.runId, memoryItemId: item.id, taskType: 'review_candidate', payload: { memoryItemId: item.id, candidate: payload.candidate } })
    if (item.status === 'active') await memories.enqueueTask({ workspaceId: task.workspaceId, userId: task.userId, runId: task.runId, taskType: 'consolidate_memories', payload: { scope: payload.candidate.scope } })
    if (embeddingEnabled && item.status === 'active') await memories.enqueueTask({ workspaceId: task.workspaceId, userId: task.userId, runId: task.runId, memoryItemId: item.id, taskType: 'embed_memory', payload: { memoryItemId: item.id } })
    return
  }
  if (task.taskType === 'embed_memory') {
    if (!task.memoryItemId) throw new Error('MEMORY_ITEM_REQUIRED')
    const item = await memories.get(task.memoryItemId, task.userId ?? '', task.workspaceId)
    if (!item || item.status !== 'active') return
    const result = await embedding.embed(`${item.key}: ${item.summary}`)
    await memories.updateEmbedding(item.id, result.data[0]?.embedding ?? [], config.EMBEDDING_MODEL)
    return
  }
  if (task.taskType === 'summarize_conversation') {
    if (!task.conversationId) throw new Error('CONVERSATION_REQUIRED')
    const messages = await conversations.recent(task.conversationId, 50)
    if (messages.length < (config.CONVERSATION_SUMMARY_THRESHOLD ?? 30)) return
    if (!model.isConfigured()) throw new Error('MODEL_UNAVAILABLE')
    const result = await model.chatJson([{ role: 'system', content: '请只根据对话生成简洁事实摘要，输出 JSON：{"summary":"..."}，不要添加对话外信息。' }, { role: 'user', content: JSON.stringify(messages.map(m => ({ role: m.role, content: m.content }))) }], summarySchema, { model: config.DEEPSEEK_MODEL, timeoutMs: memoryTimeoutMs, maxRetries: 1 })
    await memories.upsertSummary(task.conversationId, result.summary, messages.at(-1)?.id, config.DEEPSEEK_MODEL)
    return
  }
  if (task.taskType === 'expire_memories') { await memories.expire(); return }
  if (task.taskType === 'review_candidate') {
    if (!task.memoryItemId || !task.userId || !model.isConfigured()) throw new Error('INVALID_MEMORY_REVIEW_TASK')
    const item = await memories.get(task.memoryItemId, task.userId, task.workspaceId)
    if (!item || item.status !== 'pending_confirmation') return
    const decision = await model.chatJson([{ role: 'system', content: '你是记忆安全复核器。只能根据给定记忆判断是否为用户明确表达的、非敏感且可长期保存的信息。敏感信息不得批准。只输出 JSON。' }, { role: 'user', content: JSON.stringify({ summary: item.summary, type: item.type, sensitivity: item.sensitivity, value: item.value }) }], reviewSchema, { model: config.DEEPSEEK_MODEL, timeoutMs: memoryTimeoutMs, maxRetries: 1 })
    if (decision.approved && decision.confidence >= 0.85 && item.sensitivity === 'normal') {
      const activated = await memories.activateReviewed(item.id, task.userId, task.workspaceId, decision.confidence)
      if (activated && embeddingEnabled) await memories.enqueueTask({ workspaceId: task.workspaceId, userId: task.userId, memoryItemId: activated.id, taskType: 'embed_memory', payload: { memoryItemId: activated.id } })
    }
    return
  }
  if (task.taskType === 'consolidate_memories') {
    if (!task.userId || !model.isConfigured()) throw new Error('INVALID_MEMORY_CONSOLIDATION_TASK')
    const scope = payload.scope === 'workspace' ? 'workspace' : 'user'
    const items = await memories.activeForScope(task.workspaceId, task.userId, scope)
    if (items.length < 2) return
    const result = await model.chatJson([{ role: 'system', content: '你是长期记忆合并器。只能合并给定的同一权限范围记忆；不得发明事实。每个 key 最多输出一个结果，只输出 JSON。' }, { role: 'user', content: JSON.stringify(items.map(item => ({ id: item.id, key: item.key, type: item.type, value: item.value, summary: item.summary, confidence: item.confidence }))) }], consolidationSchema, { model: config.DEEPSEEK_MODEL, timeoutMs: memoryTimeoutMs, maxRetries: 1 })
    const byKey = new Map(items.map(item => [item.key, item]))
    for (const merged of result.merged) {
      const source = byKey.get(merged.key)
      if (!source || merged.confidence < 0.85 || merged.type !== source.type) continue
      const created = await memories.create({ workspaceId: task.workspaceId, userId: scope === 'user' ? task.userId : undefined, scope, type: merged.type, key: merged.key, value: merged.value, summary: merged.summary, confidence: merged.confidence, sensitivity: source.sensitivity, status: 'active', sourceRunId: task.runId })
      await memories.archive(items.filter(item => item.key === merged.key && item.id !== created.id).map(item => item.id), task.workspaceId)
      if (embeddingEnabled) await memories.enqueueTask({ workspaceId: task.workspaceId, userId: task.userId, memoryItemId: created.id, taskType: 'embed_memory', payload: { memoryItemId: created.id } })
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
  try {
    await Promise.race([execute(task), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MEMORY_TASK_TIMEOUT')), memoryTimeoutMs))])
    await memories.markTaskCompleted(task.id)
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'MEMORY_TASK_FAILED'
    if (task.attempt < memoryMaxAttempts) {
      const delayMs = Math.min(60_000, 2 ** Math.max(0, task.attempt - 1) * 1000)
      await memories.retryTask(task.id, messageText, delayMs)
      await new Promise(resolve => setTimeout(resolve, delayMs))
      await queue.publish(memoryStream, { taskId: task.id })
    } else {
      await memories.deadLetterTask(task.id, messageText)
      await queue.publishToStream(memoryDeadLetter, { taskId: task.id, workspaceId: task.workspaceId, taskType: task.taskType, error: messageText, attempt: task.attempt })
    }
  }
}
function launch(message: StreamMessage) {
  const task = lease(message, () => processMessage(message)).then(() => queue.ackAndDelete(memoryStream, config.REDIS_CONSUMER_GROUP, message.id)).catch(() => undefined).finally(() => active.delete(task))
  active.add(task)
}
async function loop() {
  while (!stopping) {
    while (!stopping && active.size < memoryConcurrency) {
      const slots = memoryConcurrency - active.size
      const reclaimed = await queue.reclaim(memoryStream, config.REDIS_CONSUMER_GROUP, consumer, config.REDIS_RECLAIM_IDLE_MS, slots)
      if (reclaimed.length) { reclaimed.forEach(launch); continue }
      const messages = await queue.read(memoryStream, config.REDIS_CONSUMER_GROUP, consumer, slots, 1000)
      if (!messages.length) break
      messages.forEach(launch)
    }
    if (active.size) await Promise.race(active)
  }
  await Promise.allSettled(active)
}
function shutdown() { stopping = true }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown)
await queue.ensureGroup(memoryStream)
console.log(`ownagent memory worker ${consumer} listening on ${memoryStream}`)
await loop()
await queue.close()
