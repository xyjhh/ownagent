import type { RedisStreams } from '../../queue/redis-streams.js'
import type { WorkspaceContext } from '../workspaces/types.js'
import type { RunRepository } from './repository.js'
import { ApiError } from '../auth/errors.js'
import type { RunControlType } from './types.js'
import type { LangfuseTracer } from '../../observability/langfuse.js'

export class RunService {
  constructor(
    private readonly repository: RunRepository,
    private readonly queue: RedisStreams,
    private readonly config: { stream: string; controlStream?: string; maxAttempts: number },
    private readonly tracer?: LangfuseTracer
  ) {}
  async create(context: WorkspaceContext, input: Record<string, unknown>, idempotencyKey: string, requestId?: string) {
    const run = await this.repository.create(
      { ...context, runId: '' },
      input,
      idempotencyKey,
      this.config.maxAttempts
    )
    // The run id is the stable Langfuse trace id, including before the worker starts.
    try { await this.repository.setTraceId?.(run.id, run.id) } catch { /* trace persistence is best effort */ }
    const trace = this.tracer?.startTrace({ id: run.id, name: 'knowledge-agent-run', userId: context.userId, workspaceId: context.workspaceId, conversationId: typeof input.conversationId === 'string' ? input.conversationId : undefined, requestId, metadata: { businessType: 'agent_run', status: run.status } })
    const span = trace?.span('run.create', { requestId, httpMethod: 'POST', workspaceId: context.workspaceId, runId: run.id })
    span?.end({ status: 202, runId: run.id })
    void this.tracer?.flushAsync()
    return { ...run, traceId: run.id }
  }
  get(context: WorkspaceContext, runId: string) {
    return this.repository.get(context, runId)
  }
  async events(context: WorkspaceContext, runId: string, afterSequence = 0, requestId?: string) {
    return this.observe('run.events', context, runId, requestId, () => this.repository.listEventsAfter(context, runId, afterSequence), 'GET')
  }
  async cancel(context: WorkspaceContext, runId: string, requestId?: string) {
    return this.observe('run.cancel', context, runId, requestId, async () => {
    const run = await this.assertController(context, runId)
    await this.repository.markCanceled(runId)
    const controlId = String(crypto.randomUUID())
    await this.repository.insertControl(context, runId, controlId, 'interrupt', {
      reason: 'user_cancelled',
    })
    await this.queue.publish(this.config.controlStream ?? this.config.stream, {
      runId,
      controlId,
      controlType: 'interrupt',
      reason: 'user_cancelled',
    })
    const event = await this.repository.appendEvent(runId, 'canceled', { by: context.userId })
    await this.publish(runId, {
      type: 'interrupted',
      runId,
      sequence: event.sequence,
      status: 'canceled',
      workspaceId: context.workspaceId,
    })
    return this.repository.get(context, run.id)
    })
  }
  async approve(
    context: WorkspaceContext,
    runId: string,
    approvalId: string,
    value: boolean,
    controlId: string,
    reason?: string,
    requestId?: string
  ) {
    return this.observe(value ? 'run.approve' : 'run.reject', context, runId, requestId, async () => {
    const run = await this.assertController(context, runId)
    const existing = await this.repository.findControl(context, runId, controlId)
    if (existing) return run
    const approval = await this.repository.resolveApproval(context, runId, approvalId, value)
    if (!approval) throw new ApiError(409, 'APPROVAL_NOT_PENDING', 'Approval is no longer pending')
    const control = await this.repository.insertControl(
      context,
      runId,
      controlId,
      value ? 'approve' : 'reject',
      { approvalId, value, ...(reason ? { reason } : {}) }
    )
    if (control && run.status === 'waiting_approval') await this.repository.resume(runId)
    if (control) {
      const event = await this.repository.appendEvent(runId, value ? 'approved' : 'rejected', {
        approvalId,
        value,
        ...(reason ? { reason } : {}),
        by: context.userId,
      })
      await this.publish(runId, {
        type: 'status',
        runId,
        sequence: event.sequence,
        status: 'queued',
        workspaceId: context.workspaceId,
      })
      await this.queue.publish(this.config.controlStream ?? this.config.stream, {
        runId,
        controlId,
        controlType: value ? 'approve' : 'reject',
        value,
        resumeMode: run.status,
      })
    }
    return this.repository.get(context, runId)
    })
  }
  async control(
    context: WorkspaceContext,
    runId: string,
    type: RunControlType,
    payload: Record<string, unknown>,
    controlId: string = String(crypto.randomUUID()),
    requestId?: string
  ) {
    return this.observe(type === 'follow_up' ? 'run.follow_up' : type === 'interrupt' ? 'run.interrupt' : `run.${type}`, context, runId, requestId, async () => {
    const run = await this.assertController(context, runId)
    if (type === 'follow_up' && ['canceled', 'failed'].includes(run.status))
      throw new ApiError(409, 'RUN_NOT_RESUMABLE', 'Run cannot be resumed')
    if (type === 'follow_up' && run.status === 'waiting_approval')
      throw new ApiError(409, 'APPROVAL_REQUIRED', 'Resolve the pending approval before continuing')
    const control = await this.repository.insertControl(context, runId, controlId, type, payload)
    if (!control) return run
    if (type === 'interrupt') await this.repository.markInterrupted(runId)
    else if (type === 'follow_up') {
      await this.repository.resume(runId)
    }
    const event = await this.repository.appendEvent(
      runId,
      type === 'interrupt' ? 'interrupted' : type,
      { ...payload, by: context.userId }
    )
    await this.publish(runId, {
      type: type === 'interrupt' ? 'interrupted' : type,
      runId,
      sequence: event.sequence,
      ...payload,
      workspaceId: context.workspaceId,
    })
    await this.queue.publish(this.config.controlStream ?? this.config.stream, {
      runId,
      controlId,
      controlType: type,
      resumeMode: run.status,
      ...payload,
    })
    return this.repository.get(context, runId)
    })
  }
  private async observe<T>(name: string, context: WorkspaceContext, runId: string, requestId: string | undefined, operation: () => Promise<T>, httpMethod = 'POST'): Promise<T> {
    const run = await this.repository.get(context, runId)
    const span = this.tracer?.startSpan({ traceId: run?.traceId ?? runId, runId, workspaceId: context.workspaceId }, name, { requestId, httpMethod, runId, workspaceId: context.workspaceId })
    const started = Date.now()
    try {
      const result = await operation()
      span?.end({ durationMs: Date.now() - started, status: 'ok' })
      void this.tracer?.flushAsync()
      return result
    } catch (error) {
      span?.fail(error, { durationMs: Date.now() - started, status: 'error' })
      void this.tracer?.flushAsync()
      throw error
    }
  }
  private async publish(runId: string, event: Record<string, unknown>) {
    try {
      await this.queue.publishEvent(runId, event)
    } catch {
      /* Postgres event remains durable */
    }
  }
  private async assertController(context: WorkspaceContext, runId: string) {
    const run = await this.repository.get(context, runId)
    if (!run) return Promise.reject(new ApiError(404, 'NOT_FOUND', 'Run not found'))
    if (run.requestedBy !== context.userId && !['owner', 'admin'].includes(context.role))
      throw new ApiError(
        403,
        'RUN_CONTROL_FORBIDDEN',
        'Insufficient permission to control this run'
      )
    return run
  }
}
