import type { RedisStreams } from '../../queue/redis-streams.js'
import type { WorkspaceContext } from '../workspaces/types.js'
import type { RunRepository } from './repository.js'
import type { RunContext } from './types.js'
import { ApiError } from '../auth/errors.js'
import type { RunControlType } from './types.js'

export class RunService {
  constructor(private readonly repository: RunRepository, private readonly queue: RedisStreams, private readonly config: { stream: string; controlStream?: string; maxAttempts: number }) {}
  async create(context: WorkspaceContext, input: Record<string, unknown>, idempotencyKey: string) { return this.repository.create({ ...context, runId: '' }, input, idempotencyKey, this.config.maxAttempts) }
  get(context: WorkspaceContext, runId: string) { return this.repository.get(context, runId) }
  events(context: WorkspaceContext, runId: string, afterSequence = 0) { return this.repository.listEventsAfter(context, runId, afterSequence) }
  async cancel(context: WorkspaceContext, runId: string) {
    const run = await this.assertController(context, runId)
    await this.repository.markCanceled(runId)
    await this.repository.insertControl(context, runId, crypto.randomUUID(), 'interrupt', { reason: 'user_cancelled' })
    const event = await this.repository.appendEvent(runId, 'canceled', { by: context.userId })
    await this.publish(runId, { type: 'interrupted', runId, sequence: event.sequence, status: 'canceled', workspaceId: context.workspaceId })
    return this.repository.get(context, run.id)
  }
  async approve(context: WorkspaceContext, runId: string, approvalId: string, value: boolean, controlId: string) {
    const run = await this.assertController(context, runId)
    const existing = await this.repository.findControl(context, runId, controlId)
    if (existing) return run
    const approval = await this.repository.resolveApproval(context, runId, approvalId, value)
    if (!approval) throw new ApiError(409, 'APPROVAL_NOT_PENDING', 'Approval is no longer pending')
    const control = await this.repository.insertControl(context, runId, controlId, value ? 'approve' : 'reject', { approvalId, value })
    if (control && run.status === 'waiting_approval') await this.repository.resume(runId)
    if (control) {
      const event = await this.repository.appendEvent(runId, value ? 'approved' : 'rejected', { approvalId, value, by: context.userId })
      await this.publish(runId, { type: 'status', runId, sequence: event.sequence, status: 'queued', workspaceId: context.workspaceId })
      await this.queue.publish(this.config.controlStream ?? this.config.stream, { runId, controlId, controlType: value ? 'approve' : 'reject', value, resumeMode: run.status })
    }
    return this.repository.get(context, runId)
  }
  async control(context: WorkspaceContext, runId: string, type: RunControlType, payload: Record<string, unknown>, controlId: string = String(crypto.randomUUID())) {
    const run = await this.assertController(context, runId)
    if (type === 'follow_up' && ['canceled', 'failed'].includes(run.status)) throw new ApiError(409, 'RUN_NOT_RESUMABLE', 'Run cannot be resumed')
    const control = await this.repository.insertControl(context, runId, controlId, type, payload)
    if (!control) return run
    if (type === 'interrupt') await this.repository.markInterrupted(runId)
    else if (type === 'follow_up') {
      await this.repository.resume(runId)
    }
    const event = await this.repository.appendEvent(runId, type === 'interrupt' ? 'interrupted' : type, { ...payload, by: context.userId })
    await this.publish(runId, { type: type === 'interrupt' ? 'interrupted' : type, runId, sequence: event.sequence, ...payload, workspaceId: context.workspaceId })
    await this.queue.publish(this.config.controlStream ?? this.config.stream, { runId, controlId, controlType: type, resumeMode: run.status, ...payload })
    return this.repository.get(context, runId)
  }
  private async publish(runId: string, event: Record<string, unknown>) { try { await this.queue.publishEvent(runId, event) } catch { /* Postgres event remains durable */ } }
  private async assertController(context: WorkspaceContext, runId: string) {
    const run = await this.repository.get(context, runId)
    if (!run) return Promise.reject(new ApiError(404, 'NOT_FOUND', 'Run not found'))
    if (run.requestedBy !== context.userId && !['owner', 'admin'].includes(context.role)) throw new ApiError(403, 'RUN_CONTROL_FORBIDDEN', 'Insufficient permission to control this run')
    return run
  }
}
