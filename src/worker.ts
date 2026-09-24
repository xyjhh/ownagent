import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config/env.js'
import { createSupabaseAdmin, createSupabaseSchemaClient } from './infrastructure/supabase.js'
import { RedisStreams } from './queue/redis-streams.js'
import { RunRepository } from './modules/runs/repository.js'
import { createKnowledgeAgentGraph } from './agent/graph.js'
import { createPostgresCheckpointer } from './agent/checkpointer.js'
import { LangfuseTracer } from './observability/langfuse.js'
import { Command } from '@langchain/langgraph'
import type { AgentEvent, AgentEventType } from './modules/runs/events.js'

const config = loadConfig()
const schemaDb = createSupabaseSchemaClient(createSupabaseAdmin(config), config.SUPABASE_DB_SCHEMA)
const repository = new RunRepository(schemaDb)
const queue = new RedisStreams(config)
const tracer = new LangfuseTracer(config)
const checkpointer = await createPostgresCheckpointer(config)
const graph = createKnowledgeAgentGraph(checkpointer)
const consumer = `${process.env.HOSTNAME ?? 'worker'}-${randomUUID()}`
const abortControllers = new Map<string, AbortController>()
const expiryTimer = setInterval(() => {
  void Promise.resolve(schemaDb.rpc('expire_agent_run_approvals')).catch(() => undefined)
}, 60_000)

async function withPendingLease(
  stream: string,
  message: { id: string },
  run: () => Promise<void>,
  leaseConsumer = consumer
) {
  const heartbeatMs = Math.max(10_000, Math.floor(config.REDIS_RECLAIM_IDLE_MS / 3))
  const heartbeat = setInterval(() => {
    void queue
      .touch(stream, config.REDIS_CONSUMER_GROUP, leaseConsumer, message.id)
      .catch(() => undefined)
  }, heartbeatMs)
  try {
    await run()
  } finally {
    clearInterval(heartbeat)
  }
}

async function emitEvent(runId: string, event: AgentEvent) {
  try {
    await queue.publishEvent(runId, event)
  } catch {
    /* database remains source of truth */
  }
}

async function persistAndEmit(
  runId: string,
  workspaceId: string,
  type: AgentEventType,
  payload: Record<string, unknown>
) {
  const stored = await repository.appendEvent(runId, type, payload)
  await emitEvent(runId, { type, runId, sequence: stored.sequence, workspaceId, ...payload })
}

async function publishRunDeadLetter(runId: string, messageId: string) {
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
  return true
}

async function processMessage(
  message: { id: string; values: Record<string, string> },
  resumeValue?: unknown,
  resumeMode?: string,
  initialInput?: string
) {
  const payload = JSON.parse(message.values.payload ?? '{}') as { runId?: string }
  if (!payload.runId) return
  const run = await repository.getById(payload.runId)
  if (!run || !(await repository.markRunning(run.id))) return
  const trace = tracer.startTrace({
    id: run.id,
    name: 'knowledge-agent-run',
    userId: run.requestedBy,
    workspaceId: run.workspaceId,
    model: config.DEEPSEEK_MODEL,
    promptVersion: 'v1',
  })
  const controller = new AbortController()
  try {
    await persistAndEmit(run.id, run.workspaceId, 'started', { attempt: run.attempt + 1, sessionId: run.threadId })
    abortControllers.set(run.id, controller)
    const input = resumeValue === undefined ||
        (resumeMode !== 'waiting_user' && resumeMode !== 'waiting_approval')
        ? {
            userId: run.requestedBy,
            workspaceId: run.workspaceId,
            runId: run.id,
            input: initialInput ?? run.input.question,
            conversationId: run.input.conversationId,
          }
        : new Command({ resume: resumeValue })
    let output: string | undefined
    let interruptValue: Record<string, unknown> | undefined
    const stream = graph.stream(input, {
      configurable: {
        thread_id: run.threadId,
        userId: run.requestedBy,
        workspaceId: run.workspaceId,
        runId: run.id,
      },
      signal: controller.signal,
    }, { streamMode: 'updates' })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      const interrupt = (chunk as any).__interrupt__?.[0]
      if (interrupt) {
        interruptValue = interrupt.value as Record<string, unknown>
        break
      }
      for (const [node, update] of Object.entries(chunk as Record<string, unknown>)) {
        await persistAndEmit(run.id, run.workspaceId, 'node_started', { node })
        const state = update as Record<string, unknown> | undefined
        if (typeof state?.output === 'string') {
          output = state.output
          await persistAndEmit(run.id, run.workspaceId, 'token', { delta: state.output, node })
        }
        await persistAndEmit(run.id, run.workspaceId, 'node_completed', { node })
      }
    }
    abortControllers.delete(run.id)
    if (interruptValue) {
      await persistAndEmit(run.id, run.workspaceId, 'interrupt', { interrupt: interruptValue })
      if (interruptValue.kind === 'approval') {
        await repository.markWaitingApproval(run.id)
        await repository.createApproval(
          { userId: run.requestedBy, workspaceId: run.workspaceId, role: 'owner' },
          run.id,
          String(interruptValue.approvalId ?? randomUUID()),
          String(interruptValue.prompt ?? 'Approval required'),
          Array.isArray(interruptValue.options) ? interruptValue.options : []
        )
      } else {
        await repository.markWaitingUser(run.id)
      }
      return
    }
    await repository.markCompleted(run.id)
    await persistAndEmit(run.id, run.workspaceId, 'completed', { output: output ?? null })
    trace?.update?.({ output: { status: 'completed' } })
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Agent run failed'
    abortControllers.delete(run.id)
    if (controller.signal.aborted) {
      await repository.markInterrupted(run.id)
      await persistAndEmit(run.id, run.workspaceId, 'interrupt', { reason: 'user_cancelled' })
      return
    }
    const next = await repository.markFailed(run.id, 'AGENT_ERROR', messageText, true)
    if (next?.status === 'queued')
      await repository.enqueueRetry(run.id, 2 ** Math.max(0, next.attempt - 1) * 1000)
    else {
      await persistAndEmit(run.id, run.workspaceId, 'failed', { code: 'AGENT_ERROR' })
      await queue.publishDeadLetter({
        runId: run.id,
        messageId: message.id,
        workspaceId: run.workspaceId,
        requestedBy: run.requestedBy,
        status: 'failed',
        attempt: next?.attempt ?? run.attempt + 1,
        errorCode: 'AGENT_ERROR',
      })
    }
    trace?.update?.({ output: { status: 'failed', error: 'AGENT_ERROR' } })
  }
}

async function processControl(message: { id: string; values: Record<string, string> }) {
  const payload = JSON.parse(message.values.payload ?? '{}') as {
    runId?: string
    controlId?: string
    controlType?: string
    value?: boolean
    question?: string
    resumeMode?: string
  }
  if (!payload.runId) return
  if (payload.controlType === 'interrupt') {
    abortControllers.get(payload.runId)?.abort()
    await repository.markInterrupted(payload.runId)
    if (payload.controlId) await repository.markControlProcessed(payload.runId, payload.controlId)
    return
  }
  const run = await repository.getById(payload.runId)
  if (!run || run.status !== 'queued') return
  await processMessage(
    { id: message.id, values: { payload: JSON.stringify({ runId: run.id }) } },
    payload.controlType === 'follow_up' ? payload.question : payload.value,
    payload.resumeMode,
    payload.controlType === 'follow_up' ? payload.question : undefined
  )
  if (payload.controlId) await repository.markControlProcessed(payload.runId, payload.controlId)
}

await queue.ensureGroup(config.REDIS_STREAM_AGENT)
await queue.ensureGroup(config.REDIS_STREAM_CONTROLS)
console.log(`ownagent worker ${consumer} listening on ${config.REDIS_STREAM_AGENT}`)
async function agentLoop() {
  const activeTasks = new Set<Promise<void>>()
  const launch = (message: { id: string; values: Record<string, string> }) => {
    const task = handleAgentMessage(message).finally(() => activeTasks.delete(task))
    activeTasks.add(task)
  }
  while (!stopping) {
    while (!stopping && activeTasks.size < config.WORKER_CONCURRENCY) {
      const slots = config.WORKER_CONCURRENCY - activeTasks.size
      const reclaimed = await queue.reclaim(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, consumer, config.REDIS_RECLAIM_IDLE_MS, slots)
      if (reclaimed.length) { reclaimed.forEach(launch); continue }
      const messages = await queue.read(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, consumer, slots, 1000)
      if (!messages.length) break
      messages.forEach(launch)
    }
    if (activeTasks.size) await Promise.race(activeTasks)
  }
  await Promise.all(activeTasks)
}
async function controlLoop() {
  const controlConsumer = `${consumer}-controls`
  const activeTasks = new Set<Promise<void>>()
  const launch = (message: { id: string; values: Record<string, string> }) => {
    const task = handleControlMessage(message).finally(() => activeTasks.delete(task))
    activeTasks.add(task)
  }
  while (!stopping) {
    while (!stopping && activeTasks.size < config.CONTROL_CONCURRENCY) {
      const slots = config.CONTROL_CONCURRENCY - activeTasks.size
      const reclaimed = await queue.reclaim(config.REDIS_STREAM_CONTROLS, config.REDIS_CONSUMER_GROUP, controlConsumer, config.REDIS_RECLAIM_IDLE_MS, slots)
      if (reclaimed.length) { reclaimed.forEach(launch); continue }
      const messages = await queue.read(config.REDIS_STREAM_CONTROLS, config.REDIS_CONSUMER_GROUP, controlConsumer, slots, 1000)
      if (!messages.length) break
      messages.forEach(launch)
    }
    if (activeTasks.size) await Promise.race(activeTasks)
  }
  await Promise.all(activeTasks)
}
async function handleAgentMessage(message: { id: string; values: Record<string, string> }) {
  try {
    await withPendingLease(config.REDIS_STREAM_AGENT, message, () => processMessage(message))
    await queue.ackAndDelete(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, message.id)
  } catch {
    try {
      const payload = JSON.parse(message.values.payload ?? '{}') as { runId?: string }
      if (payload.runId && (await publishRunDeadLetter(payload.runId, message.id))) await queue.ackAndDelete(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, message.id)
    } catch { /* leave pending */ }
  }
}
async function handleControlMessage(message: { id: string; values: Record<string, string> }) {
  try {
    await withPendingLease(config.REDIS_STREAM_CONTROLS, message, () => processControl(message), `${consumer}-controls`)
    await queue.ackAndDelete(config.REDIS_STREAM_CONTROLS, config.REDIS_CONSUMER_GROUP, message.id)
  } catch { /* leave pending */ }
}
let stopping = false
process.once('SIGTERM', () => { stopping = true })
process.once('SIGINT', () => { stopping = true })

/*
  while (false) {
    const reclaimed = await queue.reclaim(
      config.REDIS_STREAM_AGENT,
      config.REDIS_CONSUMER_GROUP,
      consumer,
      config.REDIS_RECLAIM_IDLE_MS
    )
    for (const message of reclaimed) {
      try {
        await withPendingLease(config.REDIS_STREAM_AGENT, message, () => processMessage(message))
        await queue.ackAndDelete(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, message.id)
      } catch {
        // If DB state is already terminal but DLQ publishing failed, retry DLQ before acking.
        try {
          const payload = JSON.parse(message.values.payload ?? '{}') as { runId?: string }
          if (payload.runId && (await publishRunDeadLetter(payload.runId, message.id)))
            await queue.ackAndDelete(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, message.id)
        } catch {
          // Keep unhandled failures pending so another Worker can reclaim them.
        }
      }
    }
    const messages = await queue.read(
      config.REDIS_STREAM_AGENT,
      config.REDIS_CONSUMER_GROUP,
      consumer,
      config.WORKER_CONCURRENCY,
      5000
    )
    for (const message of messages) {
      try {
        await withPendingLease(config.REDIS_STREAM_AGENT, message, () => processMessage(message))
        await queue.ackAndDelete(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, message.id)
      } catch {
        try {
          const payload = JSON.parse(message.values.payload ?? '{}') as { runId?: string }
          if (payload.runId && (await publishRunDeadLetter(payload.runId, message.id)))
            await queue.ackAndDelete(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, message.id)
        } catch {
          // Keep unhandled failures pending so another Worker can reclaim them.
        }
      }
    }
  }
}
async function legacyControlLoop() {
  while (true) {
    const controlConsumer = `${consumer}-controls`
    const reclaimed = await queue.reclaim(
      config.REDIS_STREAM_CONTROLS,
      config.REDIS_CONSUMER_GROUP,
      controlConsumer,
      config.REDIS_RECLAIM_IDLE_MS
    )
    for (const message of reclaimed) {
      try {
        await withPendingLease(config.REDIS_STREAM_CONTROLS, message, () => processControl(message))
        await queue.ackAndDelete(
          config.REDIS_STREAM_CONTROLS,
          config.REDIS_CONSUMER_GROUP,
          message.id
        )
      } catch {
        // Keep unhandled control failures pending for reclaim.
      }
    }
    const messages = await queue.read(
      config.REDIS_STREAM_CONTROLS,
      config.REDIS_CONSUMER_GROUP,
      controlConsumer,
      config.WORKER_CONCURRENCY,
      5000
    )
    for (const message of messages) {
      try {
        await withPendingLease(config.REDIS_STREAM_CONTROLS, message, () => processControl(message))
        await queue.ackAndDelete(
          config.REDIS_STREAM_CONTROLS,
          config.REDIS_CONSUMER_GROUP,
          message.id
        )
      } catch {
        // Keep unhandled control failures pending for reclaim.
      }
    }
  }
}
*/
await Promise.all([agentLoop(), controlLoop()])
clearInterval(expiryTimer)
await queue.close()
