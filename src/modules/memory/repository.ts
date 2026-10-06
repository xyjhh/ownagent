import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

export type MemoryTaskType = 'persist_candidate' | 'review_candidate' | 'summarize_conversation' | 'consolidate_memories' | 'embed_memory' | 'expire_memories'
export type MemoryTask = { id: string; taskType: MemoryTaskType; workspaceId: string; userId?: string; conversationId?: string; runId?: string; memoryItemId?: string; payload: Record<string, unknown>; attempt: number; status: string }

export type MemoryItem = { id: string; workspaceId: string; ownerUserId?: string; scope: 'user' | 'workspace'; type: 'preference' | 'fact' | 'instruction'; key: string; value: Record<string, unknown>; summary: string; confidence: number; status: string; sensitivity: 'normal' | 'sensitive' }
export class MemoryRepository {
  constructor(private readonly db: SupabaseClient) {}
  async list(workspaceId: string, userId: string, limit = 20) {
    const { data, error } = await this.db.from('memory_items').select('*').eq('workspace_id', workspaceId).eq('status', 'active').or(`scope.eq.workspace,owner_user_id.eq.${userId}`).order('updated_at', { ascending: false }).limit(limit)
    if (error) throw new Error(`Memory lookup failed: ${error.message}`)
    return (data ?? []).map(row => this.map(row))
  }
  async create(input: { workspaceId: string; userId?: string; scope: 'user' | 'workspace'; type: 'preference' | 'fact' | 'instruction'; key: string; value: Record<string, unknown>; summary: string; confidence: number; sensitivity: 'normal' | 'sensitive'; status: 'active' | 'pending_confirmation'; sourceConversationId?: string; sourceMessageId?: string; sourceRunId?: string }) {
    await this.db.from('memory_items').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('workspace_id', input.workspaceId).eq('scope', input.scope).eq('key', input.key).eq('status', 'active').eq(input.scope === 'user' ? 'owner_user_id' : 'workspace_id', input.scope === 'user' ? input.userId : input.workspaceId)
    const { data, error } = await this.db.from('memory_items').insert({ workspace_id: input.workspaceId, owner_user_id: input.scope === 'user' ? input.userId : null, scope: input.scope, type: input.type, key: input.key, value: input.value, summary: input.summary, confidence: input.confidence, sensitivity: input.sensitivity, status: input.status, source_conversation_id: input.sourceConversationId, source_message_id: input.sourceMessageId, source_run_id: input.sourceRunId }).select('*').single()
    if (error) throw new Error(`Memory write failed: ${error.message}`)
    return this.map(data)
  }
  async enqueueTask(input: { workspaceId: string; userId?: string; conversationId?: string; runId?: string; memoryItemId?: string; taskType: MemoryTaskType; payload: Record<string, unknown>; stream?: string }) {
    const taskId = randomUUID()
    const { data, error } = await this.db.from('memory_tasks').insert({ id: taskId, workspace_id: input.workspaceId, user_id: input.userId ?? null, conversation_id: input.conversationId ?? null, run_id: input.runId ?? null, memory_item_id: input.memoryItemId ?? null, task_type: input.taskType, payload: input.payload, status: 'queued' }).select('*').single()
    if (error) throw new Error(`Memory task creation failed: ${error.message}`)
    const { error: outboxError } = await this.db.from('task_outbox').insert({ memory_task_id: taskId, workspace_id: input.workspaceId, stream: input.stream ?? 'ownagent:memory-tasks', payload: { taskId, taskType: input.taskType, workspaceId: input.workspaceId, userId: input.userId, conversationId: input.conversationId, runId: input.runId, memoryItemId: input.memoryItemId, ...input.payload } })
    if (outboxError) throw new Error(`Memory task enqueue failed: ${outboxError.message}`)
    return this.mapTask(data)
  }
  async getTask(id: string) { const { data, error } = await this.db.from('memory_tasks').select('*').eq('id', id).maybeSingle(); if (error) throw new Error(`Memory task lookup failed: ${error.message}`); return data ? this.mapTask(data) : null }
  async claimTask(id: string, workerId: string) { const current = await this.getTask(id); if (!current || ['completed','dead_lettered'].includes(current.status)) return null; const { data, error } = await this.db.from('memory_tasks').update({ status: 'processing', attempt: current.attempt + 1, locked_at: new Date().toISOString(), locked_by: workerId, updated_at: new Date().toISOString() }).eq('id', id).in('status', ['queued','retryable','processing']).select('*').maybeSingle(); if (error) throw new Error(`Memory task claim failed: ${error.message}`); return data ? this.mapTask(data) : null }
  async markTaskCompleted(id: string) { const { error } = await this.db.from('memory_tasks').update({ status: 'completed', completed_at: new Date().toISOString(), locked_at: null, locked_by: null, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'processing'); if (error) throw new Error(`Memory task completion failed: ${error.message}`) }
  async retryTask(id: string, message: string, delayMs: number) { const { error } = await this.db.from('memory_tasks').update({ status: 'retryable', last_error: message.slice(0, 2000), available_at: new Date(Date.now() + delayMs).toISOString(), locked_at: null, locked_by: null, updated_at: new Date().toISOString() }).eq('id', id); if (error) throw new Error(`Memory task retry failed: ${error.message}`) }
  async deadLetterTask(id: string, message: string) { const { error } = await this.db.from('memory_tasks').update({ status: 'dead_lettered', last_error: message.slice(0, 2000), locked_at: null, locked_by: null, updated_at: new Date().toISOString() }).eq('id', id); if (error) throw new Error(`Memory task dead-letter failed: ${error.message}`) }
  async persistCandidate(input: { workspaceId: string; userId: string; candidate: { scope: 'user' | 'workspace'; type: 'preference' | 'fact' | 'instruction'; key: string; value: Record<string, unknown>; summary: string; confidence: number; sensitivity: 'normal' | 'sensitive'; autoSave: boolean; sourceMessageId?: string }; conversationId?: string; runId?: string }) {
    const c = input.candidate
    const status = c.autoSave && c.sensitivity === 'normal' && c.confidence >= 0.8 ? 'active' : 'pending_confirmation'
    return this.create({ workspaceId: input.workspaceId, userId: c.scope === 'user' ? input.userId : undefined, scope: c.scope, type: c.type, key: c.key, value: c.value, summary: c.summary, confidence: c.confidence, sensitivity: c.sensitivity, status, sourceConversationId: input.conversationId, sourceMessageId: c.sourceMessageId, sourceRunId: input.runId })
  }
  async activateReviewed(id: string, userId: string, workspaceId: string, confidence: number) {
    const current = await this.get(id, userId, workspaceId)
    if (!current || current.status !== 'pending_confirmation' || current.sensitivity === 'sensitive') return null
    await this.db.from('memory_items').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('scope', current.scope).eq('key', current.key).eq('status', 'active').eq(current.scope === 'user' ? 'owner_user_id' : 'workspace_id', current.scope === 'user' ? userId : workspaceId)
    const { data, error } = await this.db.from('memory_items').update({ status: 'active', confidence, updated_at: new Date().toISOString() }).eq('id', id).eq('workspace_id', workspaceId).eq('status', 'pending_confirmation').select('*').maybeSingle()
    if (error) throw new Error(`Memory review activation failed: ${error.message}`)
    return data ? this.map(data) : null
  }
  async activeForScope(workspaceId: string, userId: string, scope: 'user' | 'workspace') {
    const query = this.db.from('memory_items').select('*').eq('workspace_id', workspaceId).eq('scope', scope).eq('status', 'active')
    const scoped = scope === 'user' ? query.eq('owner_user_id', userId) : query.is('owner_user_id', null)
    const { data, error } = await scoped.order('updated_at', { ascending: false }).limit(100)
    if (error) throw new Error(`Memory scope lookup failed: ${error.message}`)
    return (data ?? []).map(row => this.map(row))
  }
  async archive(ids: string[], workspaceId: string) {
    if (!ids.length) return
    const { error } = await this.db.from('memory_items').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).in('id', ids).eq('status', 'active')
    if (error) throw new Error(`Memory archive failed: ${error.message}`)
  }
  async expire() { const { data, error } = await this.db.from('memory_items').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('status', 'active').lt('expires_at', new Date().toISOString()).select('id'); if (error) throw new Error(`Memory expiry failed: ${error.message}`); return data?.length ?? 0 }
  async updateEmbedding(id: string, embedding: number[], model: string) { const { error } = await this.db.from('memory_items').update({ embedding: JSON.stringify(embedding), embedding_model: model, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'active'); if (error) throw new Error(`Memory embedding update failed: ${error.message}`) }
  async upsertSummary(conversationId: string, summary: string, coveredUntilMessageId?: string, model?: string) { const { error } = await this.db.from('conversation_summaries').upsert({ conversation_id: conversationId, summary, covered_until_message_id: coveredUntilMessageId ?? null, model: model ?? null, prompt_version: 'memory-worker-v1', updated_at: new Date().toISOString() }); if (error) throw new Error(`Conversation summary write failed: ${error.message}`) }
  private mapTask(row: Record<string, unknown>): MemoryTask { return { id: String(row.id), taskType: row.task_type as MemoryTaskType, workspaceId: String(row.workspace_id), userId: row.user_id ? String(row.user_id) : undefined, conversationId: row.conversation_id ? String(row.conversation_id) : undefined, runId: row.run_id ? String(row.run_id) : undefined, memoryItemId: row.memory_item_id ? String(row.memory_item_id) : undefined, payload: (row.payload ?? {}) as Record<string, unknown>, attempt: Number(row.attempt ?? 0), status: String(row.status) } }
  async updateStatus(id: string, status: string, userId: string, workspaceId: string) { const { data, error } = await this.db.from('memory_items').update({ status, updated_at: new Date().toISOString() }).eq('id', id).eq('workspace_id', workspaceId).or(`owner_user_id.eq.${userId},scope.eq.workspace`).select('*').maybeSingle(); if (error) throw new Error(`Memory update failed: ${error.message}`); return data ? this.map(data) : null }
  async get(id: string, userId: string, workspaceId: string) { const { data, error } = await this.db.from('memory_items').select('*').eq('id', id).eq('workspace_id', workspaceId).or(`owner_user_id.eq.${userId},scope.eq.workspace`).maybeSingle(); if (error) throw new Error(`Memory lookup failed: ${error.message}`); return data ? this.map(data) : null }
  private map(row: Record<string, unknown>): MemoryItem { return { id: String(row.id), workspaceId: String(row.workspace_id), ownerUserId: row.owner_user_id ? String(row.owner_user_id) : undefined, scope: row.scope as MemoryItem['scope'], type: row.type as MemoryItem['type'], key: String(row.key), value: (row.value ?? {}) as Record<string, unknown>, summary: String(row.summary), confidence: Number(row.confidence), status: String(row.status), sensitivity: row.sensitivity as MemoryItem['sensitivity'] } }
}
