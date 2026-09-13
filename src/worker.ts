import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config/env.js'
import { createSupabaseAdmin, createSupabaseSchemaClient } from './infrastructure/supabase.js'
import { RedisStreams } from './queue/redis-streams.js'
import { RunRepository } from './modules/runs/repository.js'
import { createKnowledgeAgentGraph } from './agent/graph.js'
import { createPostgresCheckpointer } from './agent/checkpointer.js'
import { LangfuseTracer } from './observability/langfuse.js'
import { Command, isInterrupted } from '@langchain/langgraph'

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

async function emitEvent(runId: string, event: Record<string, unknown>) {
  try {
    await queue.publishEvent(runId, event)
  } catch {
    /* database remains source of truth */
  }
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
  if (!run) return
  if (!(await repository.markRunning(run.id))) return
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
    const startedEvent = await repository.appendEvent(run.id, 'started', {
      attempt: run.attempt + 1,
    })
    await emitEvent(run.id, {
      type: 'status',
      runId: run.id,
      sequence: startedEvent.sequence,
      status: 'running',
      workspaceId: run.workspaceId,
    })
    abortControllers.set(run.id, controller)
    const result = await graph.invoke(
      resumeValue === undefined ||
        (resumeMode !== 'waiting_user' && resumeMode !== 'waiting_approval')
        ? {
            userId: run.requestedBy,
            workspaceId: run.workspaceId,
            runId: run.id,
            input: initialInput ?? run.input.question,
            conversationId: run.input.conversationId,
          }
        : new Command({ resume: resumeValue }),
      {
        configurable: {
          thread_id: run.threadId,
          userId: run.requestedBy,
          workspaceId: run.workspaceId,
          runId: run.id,
        },
        signal: controller.signal,
      }
    )
    abortControllers.delete(run.id)
    if (isInterrupted(result)) {
      const interruptValue = result.__interrupt__?.[0]?.value as Record<string, unknown> | undefined
      const waitingApproval = interruptValue?.kind === 'approval'
      if (waitingApproval) {
        await repository.markWaitingApproval(run.id)
        await repository.createApproval(
          { userId: run.requestedBy, workspaceId: run.workspaceId, role: 'owner' },
          run.id,
          String(interruptValue?.approvalId ?? randomUUID()),
          String(interruptValue?.prompt ?? 'Approval required'),
          Array.isArray(interruptValue?.options) ? interruptValue.options : []
        )
        const event = await repository.appendEvent(run.id, 'approval_required', {
          approval: interruptValue,
        })
        await emitEvent(run.id, {
          type: 'approval_required',
          runId: run.id,
          sequence: event.sequence,
          approval: interruptValue,
          workspaceId: run.workspaceId,
        })
      } else {
        await repository.markWaitingUser(run.id)
        const event = await repository.appendEvent(run.id, 'question_required', {
          question: interruptValue?.question ?? 'Please provide more details.',
        })
        await emitEvent(run.id, {
          type: 'question_required',
          runId: run.id,
          sequence: event.sequence,
          question: interruptValue?.question,
          workspaceId: run.workspaceId,
        })
      }
      return
    }
    if (typeof result?.output === 'string' && result.output) {
      const tokenEvent = await repository.appendEvent(run.id, 'token', { delta: result.output })
      await emitEvent(run.id, {
        type: 'token',
        runId: run.id,
        sequence: tokenEvent.sequence,
        delta: result.output,
        workspaceId: run.workspaceId,
      })
    }
    await repository.markCompleted(run.id)
    const event = await repository.appendEvent(run.id, 'completed', {
      output: result?.output ?? null,
    })
    await emitEvent(run.id, {
      type: 'completed',
      runId: run.id,
      sequence: event.sequence,
      output: result?.output ?? null,
      workspaceId: run.workspaceId,
    })
    trace?.update?.({ output: { status: 'completed' } })
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Agent run failed'
    abortControllers.delete(run.id)
    if (controller.signal.aborted) {
      const current = await repository.getById(run.id)
      const eventType = current?.status === 'canceled' ? 'canceled' : 'interrupted'
      const event = await repository.appendEvent(run.id, eventType, { reason: 'user_cancelled' })
      await emitEvent(run.id, {
        type: eventType === 'canceled' ? 'interrupted' : 'interrupted',
        runId: run.id,
        sequence: event.sequence,
        status: current?.status ?? 'interrupted',
        workspaceId: run.workspaceId,
      })
      return
    }
    const next = await repository.markFailed(run.id, 'AGENT_ERROR', messageText, true)
    if (next?.status === 'queued')
      await repository.enqueueRetry(run.id, 2 ** Math.max(0, next.attempt - 1) * 1000)
    else {
      const event = await repository.appendEvent(run.id, 'failed', { code: 'AGENT_ERROR' })
      await emitEvent(run.id, {
        type: 'error',
        runId: run.id,
        sequence: event.sequence,
        code: 'AGENT_ERROR',
        workspaceId: run.workspaceId,
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
  while (true) {
    const reclaimed = await queue.reclaim(
      config.REDIS_STREAM_AGENT,
      config.REDIS_CONSUMER_GROUP,
      consumer
    )
    for (const message of reclaimed) {
      await processMessage(message)
      await queue.ack(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, message.id)
    }
    const messages = await queue.read(
      config.REDIS_STREAM_AGENT,
      config.REDIS_CONSUMER_GROUP,
      consumer,
      config.WORKER_CONCURRENCY,
      5000
    )
    for (const message of messages) {
      await processMessage(message)
      await queue.ack(config.REDIS_STREAM_AGENT, config.REDIS_CONSUMER_GROUP, message.id)
    }
  }
}
async function controlLoop() {
  while (true) {
    const messages = await queue.read(
      config.REDIS_STREAM_CONTROLS,
      config.REDIS_CONSUMER_GROUP,
      `${consumer}-controls`,
      config.WORKER_CONCURRENCY,
      5000
    )
    for (const message of messages) {
      try {
        await processControl(message)
      } finally {
        await queue.ack(config.REDIS_STREAM_CONTROLS, config.REDIS_CONSUMER_GROUP, message.id)
      }
    }
  }
}
await Promise.all([agentLoop(), controlLoop()])
clearInterval(expiryTimer)
