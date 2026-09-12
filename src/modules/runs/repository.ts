import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentRun, RunContext, RunStatus, RunControlType, RunEvent } from './types.js'
import type { WorkspaceContext } from '../workspaces/types.js'

export class RunRepository {
  constructor(private readonly db: SupabaseClient) {}
  async create(context: RunContext, input: Record<string, unknown>, idempotencyKey: string, maxAttempts: number): Promise<AgentRun> {
    const { data, error } = await this.db.rpc('create_agent_run', { p_workspace_id: context.workspaceId, p_requested_by: context.userId, p_input: input, p_idempotency_key: idempotencyKey, p_max_attempts: maxAttempts })
    if (error) throw new Error(`Agent run creation failed: ${error.message}`)
    return this.toRun(data)
  }
  async get(context: WorkspaceContext, runId: string): Promise<AgentRun | null> {
    const { data, error } = await this.db.from('agent_runs').select('*').eq('id', runId).eq('workspace_id', context.workspaceId).maybeSingle()
    if (error) throw new Error(`Agent run lookup failed: ${error.message}`)
    return data ? this.toRun(data) : null
  }
  async markRunning(runId: string): Promise<boolean> { return this.transition(runId, 'running', ['queued']) }
  async markWaitingApproval(runId: string): Promise<boolean> { return this.transition(runId, 'waiting_approval', ['running']) }
  async markWaitingUser(runId: string): Promise<boolean> { return this.transition(runId, 'waiting_user', ['running']) }
  async markInterrupted(runId: string): Promise<boolean> { return this.transition(runId, 'interrupted', ['running', 'waiting_approval', 'waiting_user']) }
  async resume(runId: string): Promise<boolean> { return this.transition(runId, 'queued', ['waiting_approval', 'waiting_user', 'completed', 'interrupted']) }
  async markCompleted(runId: string): Promise<boolean> { return this.transition(runId, 'completed', ['running']) }
  async markCanceled(runId: string): Promise<boolean> { return this.transition(runId, 'canceled', ['queued', 'running', 'waiting_approval', 'waiting_user']) }
  async markFailed(runId: string, errorCode: string, errorMessage: string, retryable: boolean): Promise<AgentRun | null> {
    const current = await this.getById(runId); if (!current) return null
    const nextStatus: RunStatus = retryable && current.attempt + 1 < current.maxAttempts ? 'queued' : 'failed'
    const { data, error } = await this.db.from('agent_runs').update({ status: nextStatus, attempt: current.attempt + 1, error_code: errorCode, error_message: errorMessage, finished_at: nextStatus === 'failed' ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq('id', runId).in('status', ['running', 'queued']).select('*').maybeSingle()
    if (error) throw new Error(`Agent run failure update failed: ${error.message}`)
    return data ? this.toRun(data) : null
  }
  async appendEvent(runId: string, type: string, payload: Record<string, unknown>): Promise<RunEvent> {
    const { data, error } = await this.db.rpc('append_agent_run_event', { p_run_id: runId, p_event_type: type, p_payload: payload })
    if (error) throw new Error(`Agent event write failed: ${error.message}`)
    return { runId: String(data.run_id), sequence: Number(data.sequence_no), type: String(data.event_type), payload: data.payload ?? {}, createdAt: String(data.created_at) }
  }
  async listEvents(context: RunContext, runId: string) {
    const run = await this.get(context, runId); if (!run) return null
    const { data, error } = await this.db.from('agent_run_events').select('run_id,sequence_no,event_type,payload,created_at').eq('run_id', runId).gt('sequence_no', 0).order('sequence_no', { ascending: true })
    if (error) throw new Error(`Agent event listing failed: ${error.message}`)
    return (data ?? []).map(row => ({ runId: String(row.run_id), sequence: Number(row.sequence_no), type: String(row.event_type), payload: row.payload ?? {}, createdAt: String(row.created_at) }))
  }
  async listEventsAfter(context: WorkspaceContext, runId: string, afterSequence = 0, limit = 200): Promise<RunEvent[] | null> {
    const run = await this.get(context, runId); if (!run) return null
    const { data, error } = await this.db.from('agent_run_events').select('run_id,sequence_no,event_type,payload,created_at').eq('run_id', runId).gt('sequence_no', afterSequence).order('sequence_no', { ascending: true }).limit(Math.min(limit, 1000))
    if (error) throw new Error(`Agent event listing failed: ${error.message}`)
    return (data ?? []).map(row => ({ runId: String(row.run_id), sequence: Number(row.sequence_no), type: String(row.event_type), payload: row.payload ?? {}, createdAt: String(row.created_at) }))
  }
  async insertControl(context: WorkspaceContext, runId: string, controlId: string, controlType: RunControlType, payload: Record<string, unknown>) {
    const run = await this.get(context, runId); if (!run) return null
    const { data, error } = await this.db.from('agent_run_controls').insert({ run_id: runId, workspace_id: context.workspaceId, control_id: controlId, control_type: controlType, payload, requested_by: context.userId }).select('*').maybeSingle()
    if (error && !String(error.message).toLowerCase().includes('duplicate')) throw new Error(`Agent control failed: ${error.message}`)
    return data ?? null
  }
  async findControl(context: WorkspaceContext, runId: string, controlId: string) {
    const { data, error } = await this.db.from('agent_run_controls').select('*').eq('run_id', runId).eq('workspace_id', context.workspaceId).eq('control_id', controlId).maybeSingle()
    if (error) throw new Error(`Agent control lookup failed: ${error.message}`)
    return data
  }
  async markControlProcessed(runId: string, controlId: string) {
    const { error } = await this.db.from('agent_run_controls').update({ processed_at: new Date().toISOString() }).eq('run_id', runId).eq('control_id', controlId).is('processed_at', null)
    if (error) throw new Error(`Agent control update failed: ${error.message}`)
  }
  async createApproval(context: WorkspaceContext, runId: string, approvalId: string, prompt: string, options: unknown[] = []) {
    const { data, error } = await this.db.from('agent_run_approvals').upsert({ run_id: runId, workspace_id: context.workspaceId, approval_id: approvalId, prompt, options, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() }, { onConflict: 'run_id,approval_id' }).select('*').single()
    if (error) throw new Error(`Approval creation failed: ${error.message}`); return data
  }
  async resolveApproval(context: WorkspaceContext, runId: string, approvalId: string, approved: boolean) {
    const { data, error } = await this.db.from('agent_run_approvals').update({ status: approved ? 'approved' : 'rejected', resolved_by: context.userId, resolved_at: new Date().toISOString() }).eq('run_id', runId).eq('workspace_id', context.workspaceId).eq('approval_id', approvalId).eq('status', 'pending').gt('expires_at', new Date().toISOString()).select('*').maybeSingle()
    if (error) throw new Error(`Approval resolution failed: ${error.message}`); return data
  }
  async pendingOutbox(limit = 50) {
    const { data, error } = await this.db.from('task_outbox').select('id,run_id,stream,payload,attempts').is('published_at', null).lte('available_at', new Date().toISOString()).order('created_at', { ascending: true }).limit(limit)
    if (error) throw new Error(`Outbox lookup failed: ${error.message}`); return data ?? []
  }
  async markOutboxPublished(id: string) { const { error } = await this.db.from('task_outbox').update({ published_at: new Date().toISOString() }).eq('id', id).is('published_at', null); if (error) throw new Error(`Outbox update failed: ${error.message}`) }
  async enqueueRetry(runId: string, delayMs: number) { const { error } = await this.db.from('task_outbox').insert({ run_id: runId, stream: 'ownagent:agent-runs', payload: { runId }, available_at: new Date(Date.now() + delayMs).toISOString() }); if (error) throw new Error(`Retry enqueue failed: ${error.message}`) }
  async getById(runId: string): Promise<AgentRun | null> { const { data, error } = await this.db.from('agent_runs').select('*').eq('id', runId).maybeSingle(); if (error) throw new Error(`Agent run lookup failed: ${error.message}`); return data ? this.toRun(data) : null }
  private async transition(runId: string, status: RunStatus, from: RunStatus[]) { const terminal = ['completed', 'failed', 'canceled', 'interrupted'].includes(status); const update = { status, ...(status === 'running' ? { started_at: new Date().toISOString(), finished_at: null } : terminal ? { finished_at: new Date().toISOString() } : {}), updated_at: new Date().toISOString() }; const { data, error } = await this.db.from('agent_runs').update(update).eq('id', runId).in('status', from).select('id'); if (error) throw new Error(`Agent run transition failed: ${error.message}`); return Boolean(data?.length) }
  private toRun(row: Record<string, unknown>): AgentRun { return { id: String(row.id), workspaceId: String(row.workspace_id), requestedBy: String(row.requested_by), status: String(row.status) as RunStatus, input: row.input as Record<string, unknown>, attempt: Number(row.attempt), maxAttempts: Number(row.max_attempts), threadId: String(row.langgraph_thread_id), ...(row.langfuse_trace_id ? { traceId: String(row.langfuse_trace_id) } : {}), ...(row.error_code ? { errorCode: String(row.error_code) } : {}), createdAt: String(row.created_at), ...(row.started_at ? { startedAt: String(row.started_at) } : {}), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}) } }
}
