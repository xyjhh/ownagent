import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { Command } from '@langchain/langgraph'
import { loadConfig } from './config/env.js'
import { createSupabaseAdmin, createSupabaseSchemaClient } from './infrastructure/supabase.js'
import { RedisStreams, type StreamMessage } from './queue/redis-streams.js'
import { RunRepository } from './modules/runs/repository.js'
import { createKnowledgeAgentGraph } from './agent/graph.js'
import { createPostgresCheckpointer } from './agent/checkpointer.js'
import { LangfuseTracer } from './observability/langfuse.js'
import type { AgentEvent, AgentEventType, AgentMessageResult } from './modules/runs/events.js'
import { workerMetric, workerMetricsSnapshot } from './worker-metrics.js'
import { waitForTasks } from './worker-runtime.js'
import { ConversationRepository } from './modules/conversations/repository.js'
import { MemoryRepository } from './modules/memory/repository.js'
import { DocumentRepository } from './modules/documents/repository.js'
import { RetrievalAgent } from './agent/tools/knowledge.js'
import { EmbeddingClient } from './integrations/embedding.js'
import { RerankerClient } from './integrations/reranker.js'
import { DeepSeekClient } from './integrations/deepseek.js'
import { SupervisorAgent } from './agent/supervisor.js'
import { DocumentTools } from './agent/tools/documents.js'

const config = loadConfig()
const db = createSupabaseSchemaClient(createSupabaseAdmin(config), config.SUPABASE_DB_SCHEMA)
const repository = new RunRepository(db)
const queue = new RedisStreams(config)
const conversations = new ConversationRepository(db)
const memories = new MemoryRepository(db)
const documents = new DocumentRepository(db)
const retrieval = new RetrievalAgent(documents, new EmbeddingClient(config), new RerankerClient(config), config.RETRIEVAL_MODE)
const model = new DeepSeekClient(config)
const graph = createKnowledgeAgentGraph(await createPostgresCheckpointer(config), { conversations, memories, retrieval, retrievalMode: config.RETRIEVAL_MODE, documents, documentTools: new DocumentTools(documents), model, supervisor: new SupervisorAgent(model, { confidenceThreshold: config.SUPERVISOR_CONFIDENCE_THRESHOLD, maxRetries: config.SUPERVISOR_MAX_RETRIES, model: config.SUPERVISOR_MODEL, timeoutMs: config.SUPERVISOR_TIMEOUT_MS }) })
const tracer = new LangfuseTracer(config)
const consumer = `${process.env.HOSTNAME ?? 'worker'}-${randomUUID()}`
const controllers = new Map<string, AbortController>()
const expiryTimer = setInterval(() => {
  void Promise.resolve(db.rpc('expire_agent_run_approvals')).catch(() => undefined)
}, 60_000)

async function lease(
  stream: string,
  message: StreamMessage,
  fn: () => Promise<void>,
  leaseConsumer = consumer
) {
  const timer = setInterval(
    () => {
      void queue
        .touch(stream, config.REDIS_CONSUMER_GROUP, leaseConsumer, message.id)
        .catch(() => undefined)
    },
    Math.max(10_000, Math.floor(config.REDIS_RECLAIM_IDLE_MS / 3))
  )
  try {
    await fn()
  } finally {
    clearInterval(timer)
  }
}
async function emit(runId: string, event: AgentEvent) {
  try {
    await queue.publishEvent(runId, event)
  } catch {
    workerMetric('eventPublishFailures')
  }
}
async function event(
  runId: string,
  workspaceId: string,
  type: AgentEventType,
  payload: Record<string, unknown>
) {
  const stored = await repository.appendEvent(runId, type, payload)
  await emit(runId, { type, runId, workspaceId, sequence: stored.sequence, ...payload })
}
async function deadLetter(runId: string, messageId: string) {
  const run = await repository.getById(runId)
  if (!run || run.status !== 'failed') return false
  await queue.publishDeadLetter({
    runId,
    messageId,
    workspaceId: run.workspaceId,
    requestedBy: run.requestedBy,
    status: run.status,
    attempt: run.attempt,
    errorCode: run.errorCode ?? 'AGENT_ERROR',
  })
  workerMetric('deadLetterWrites')
  return true
}

async function processMessage(
  message: StreamMessage,
  resumeValue?: unknown,
  resumeMode?: string,
  initialInput?: string
): Promise<AgentMessageResult> {
  const payload = JSON.parse(message.values.payload ?? '{}') as { runId?: string }
  if (!payload.runId) return 'skipped'
  const run = await repository.getById(payload.runId)
  if (!run || !(await repository.markRunning(run.id))) return 'skipped'
  const started = Date.now()
  workerMetric('agentsStarted')
  const controller = new AbortController()
  controllers.set(run.id, controller)
  const trace = tracer.startTrace({
    id: run.id,
    name: 'knowledge-agent-run',
    userId: run.requestedBy,
    workspaceId: run.workspaceId,
    model: config.DEEPSEEK_MODEL,
    promptVersion: 'v1',
  })
  try {
    if (resumeValue === undefined && run.input.conversationId && typeof run.input.question === 'string') {
      await conversations.append({ conversationId: String(run.input.conversationId), workspaceId: run.workspaceId, userId: run.requestedBy, role: 'user', content: run.input.question })
    }
    await event(run.id, run.workspaceId, 'started', {
      attempt: run.attempt + 1,
      sessionId: run.threadId,
    })
    const input =
      resumeValue === undefined || !['waiting_user', 'waiting_approval'].includes(resumeMode ?? '')
        ? {
            userId: run.requestedBy,
            workspaceId: run.workspaceId,
            runId: run.id,
            input: initialInput ?? run.input.question,
            conversationId: run.input.conversationId,
          }
        : new Command({ resume: resumeValue })
    let output: string | undefined
    let interrupt: Record<string, unknown> | undefined
    const stream = await graph.stream(
      input,
      {
        configurable: {
          thread_id: run.threadId,
          userId: run.requestedBy,
          workspaceId: run.workspaceId,
          runId: run.id,
        },
        signal: controller.signal,
      },
      { streamMode: 'updates' }
    )
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      const signal = (chunk as any).__interrupt__?.[0]
      if (signal) {
        interrupt = signal.value as Record<string, unknown>
        break
      }
      for (const [node, update] of Object.entries(chunk as Record<string, unknown>)) {
        const nodeStarted = Date.now()
        await event(run.id, run.workspaceId, 'node_started', { node })
        const state = update as Record<string, unknown> | undefined
        if (node === 'supervisor_plan' && state?.supervisorDecision) {
          const decision = state.supervisorDecision as Record<string, unknown>
          await event(run.id, run.workspaceId, 'intent_detected', { intent: decision.intent, confidence: decision.confidence, fallback: state.supervisorFallback === true })
          await event(run.id, run.workspaceId, 'plan_created', { plan: decision.plan, needsRetrieval: decision.needsRetrieval, fallback: state.supervisorFallback === true })
          workerMetric('supervisorCalls')
          if (state.supervisorFallback === true) workerMetric('supervisorFallbacks')
          if (Number(decision.confidence) === 0) workerMetric('supervisorLowConfidence')
        }
        if (node === 'validate_plan' && state?.planRejected) { await event(run.id, run.workspaceId, 'plan_rejected', { reason: 'PLAN_VALIDATION_FAILED' }); workerMetric('planRejections') }
        if (node === 'retrieve_evidence') await event(run.id, run.workspaceId, 'retrieval_started', { mode: state?.retrieval && (state.retrieval as any).mode })
        if (node === 'retrieve_evidence') {
          const retrieval = (state?.retrieval ?? {}) as any
          await event(run.id, run.workspaceId, 'retrieval_completed', {
            evidenceCount: Array.isArray(state?.evidence) ? state.evidence.length : 0,
            mode: retrieval.mode,
            vectorCount: retrieval.vectorCount ?? 0,
            lexicalCount: retrieval.lexicalCount ?? 0,
            failures: retrieval.failures ?? [],
          })
        }
        if (node === 'summarize_document' && state?.summary) await event(run.id, run.workspaceId, 'summary_completed', { citationCount: Array.isArray((state.summary as any).citations) ? (state.summary as any).citations.length : 0 })
        if (node === 'compare_documents' && state?.comparison) await event(run.id, run.workspaceId, 'comparison_completed', { topicCount: Array.isArray((state.comparison as any).topics) ? (state.comparison as any).topics.length : 0 })
        if (node === 'persist_response' && Array.isArray(state?.citations)) {
          for (const citation of state.citations) await event(run.id, run.workspaceId, 'citation', { citation })
        }
        if (node === 'extract_memory_candidates' && Array.isArray(state?.memoryCandidates)) {
          for (const candidate of state.memoryCandidates) await event(run.id, run.workspaceId, 'memory_candidate', { summary: (candidate as any).summary, sensitivity: (candidate as any).sensitivity })
        }
        const delta =
          typeof state?.output === 'string'
            ? state.output
            : typeof state?.content === 'string'
              ? state.content
              : undefined
        if (delta) {
          output = delta
          await event(run.id, run.workspaceId, 'token', { node, delta })
        }
        await event(run.id, run.workspaceId, 'node_completed', { node })
        workerMetric('graphNodeDurationMs', Date.now() - nodeStarted)
      }
    }
    if (interrupt) {
      await event(run.id, run.workspaceId, 'interrupt', { interrupt })
      if (interrupt.kind === 'approval') {
        await repository.markWaitingApproval(run.id)
        await repository.createApproval(
          { userId: run.requestedBy, workspaceId: run.workspaceId, role: 'owner' },
          run.id,
          String(interrupt.approvalId ?? randomUUID()),
          String(interrupt.prompt ?? 'Approval required'),
          Array.isArray(interrupt.options) ? interrupt.options : []
        )
      } else await repository.markWaitingUser(run.id)
      workerMetric('agentsInterrupted')
      return 'waiting'
    }
    await repository.markCompleted(run.id)
    await event(run.id, run.workspaceId, 'completed', { output: output ?? null })
    trace?.update?.({ output: { status: 'completed' } })
    workerMetric('agentsCompleted')
    return 'completed'
  } catch (error) {
    if (controller.signal.aborted) {
      await repository.markInterrupted(run.id)
      await event(run.id, run.workspaceId, 'interrupt', { reason: 'user_cancelled' })
      workerMetric('agentsInterrupted')
      return 'interrupted'
    }
    const next = await repository.markFailed(
      run.id,
      'AGENT_ERROR',
      error instanceof Error ? error.message : 'Agent run failed',
      true
    )
    if (next?.status === 'queued') {
      await repository.enqueueRetry(run.id, 2 ** Math.max(0, next.attempt - 1) * 1000)
      workerMetric('agentsRetried')
      return 'retryable'
    }
    await event(run.id, run.workspaceId, 'failed', { code: 'AGENT_ERROR' })
    await deadLetter(run.id, message.id)
    workerMetric('agentsFailed')
    return 'dead_lettered'
  } finally {
    controllers.delete(run.id)
    workerMetric('totalAgentDurationMs', Date.now() - started)
  }
}

async function processControl(message: StreamMessage): Promise<AgentMessageResult> {
  const payload = JSON.parse(message.values.payload ?? '{}') as {
    runId?: string
    controlId?: string
    controlType?: string
    value?: boolean
    question?: string
    resumeMode?: string
  }
  if (!payload.runId) return 'skipped'
  if (payload.controlType === 'interrupt') {
    controllers.get(payload.runId)?.abort()
    await repository.markInterrupted(payload.runId)
    if (payload.controlId) await repository.markControlProcessed(payload.runId, payload.controlId)
    return 'interrupted'
  }
  const run = await repository.getById(payload.runId)
  if (!run || run.status !== 'queued') return 'skipped'
  const result = await processMessage(
    { id: message.id, values: { payload: JSON.stringify({ runId: run.id }) } },
    payload.controlType === 'follow_up' ? payload.question : payload.value,
    payload.resumeMode,
    payload.controlType === 'follow_up' ? payload.question : undefined
  )
  if (payload.controlId) await repository.markControlProcessed(payload.runId, payload.controlId)
  return result
}

async function handleAgent(message: StreamMessage) {
  try {
    let result: AgentMessageResult = 'unhandled'
    await lease(config.REDIS_STREAM_AGENT, message, async () => {
      result = await processMessage(message)
    })
    if (result !== 'unhandled')
      await queue.ackAndDelete(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, message.id)
  } catch {
    try {
      const p = JSON.parse(message.values.payload ?? '{}') as { runId?: string }
      if (p.runId && (await deadLetter(p.runId, message.id)))
        await queue.ackAndDelete(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, message.id)
    } catch {
      /* pending */
    }
  }
}
async function handleControl(message: StreamMessage) {
  try {
    let result: AgentMessageResult = 'unhandled'
    await lease(
      config.REDIS_STREAM_CONTROLS,
      message,
      async () => {
        result = await processControl(message)
      },
      `${consumer}-controls`
    )
    if (result !== 'unhandled')
      await queue.ackAndDelete(
        config.REDIS_STREAM_CONTROLS,
        config.REDIS_CONSUMER_GROUP,
        message.id
      )
  } catch {
    /* pending */
  }
}

let stopping = false
const agents = new Set<Promise<void>>()
const controls = new Set<Promise<void>>()
function launch(
  set: Set<Promise<void>>,
  task: Promise<void>,
  metric: 'activeAgents' | 'activeControls'
) {
  workerMetric(metric)
  const tracked = task.finally(() => {
    set.delete(tracked)
    workerMetric(metric, -1)
  })
  set.add(tracked)
}
async function loop(
  stream: string,
  consumerId: string,
  limit: number,
  set: Set<Promise<void>>,
  handler: (m: StreamMessage) => Promise<void>,
  metric: 'activeAgents' | 'activeControls'
) {
  while (!stopping) {
    while (!stopping && set.size < limit) {
      const slots = limit - set.size
      const reclaimed = await queue.reclaim(
        stream,
        config.REDIS_CONSUMER_GROUP,
        consumerId,
        config.REDIS_RECLAIM_IDLE_MS,
        slots
      )
      if (reclaimed.length) {
        reclaimed.forEach(m => launch(set, handler(m), metric))
        continue
      }
      const messages = await queue.read(
        stream,
        config.REDIS_CONSUMER_GROUP,
        consumerId,
        slots,
        1000
      )
      if (!messages.length) break
      messages.forEach(m => launch(set, handler(m), metric))
    }
    if (set.size) await Promise.race(set)
  }
}
function shutdown() {
  stopping = true
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
await queue.ensureGroup(config.REDIS_STREAM_AGENT)
await queue.ensureGroup(config.REDIS_STREAM_CONTROLS)
await Promise.all([
  loop(
    config.REDIS_STREAM_AGENT,
    consumer,
    config.WORKER_CONCURRENCY,
    agents,
    handleAgent,
    'activeAgents'
  ),
  loop(
    config.REDIS_STREAM_CONTROLS,
    `${consumer}-controls`,
    config.CONTROL_CONCURRENCY,
    controls,
    handleControl,
    'activeControls'
  ),
])
await waitForTasks([...agents, ...controls], config.WORKER_SHUTDOWN_TIMEOUT_MS, () => {
  for (const c of controllers.values()) c.abort()
})
console.log({ workerMetrics: workerMetricsSnapshot() }, 'worker stopped')
clearInterval(expiryTimer)
await queue.close()
