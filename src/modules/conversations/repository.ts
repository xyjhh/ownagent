import type { SupabaseClient } from '@supabase/supabase-js'

export type ConversationMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string; citations: Record<string, unknown>[]; createdAt: string }

export class ConversationRepository {
  constructor(private readonly db: SupabaseClient) {}
  async recent(conversationId: string, limit: number) {
    const { data, error } = await this.db.from('conversation_messages').select('id,role,content,citations,created_at').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(limit)
    if (error) throw new Error(`Conversation history failed: ${error.message}`)
    return (data ?? []).reverse().map(row => ({ id: String(row.id), role: row.role as ConversationMessage['role'], content: String(row.content), citations: (row.citations ?? []) as Record<string, unknown>[], createdAt: String(row.created_at) }))
  }
  async append(input: { conversationId: string; workspaceId: string; userId: string; role: ConversationMessage['role']; content: string; citations?: Record<string, unknown>[] }) {
    const { data, error } = await this.db.from('conversation_messages').insert({ conversation_id: input.conversationId, workspace_id: input.workspaceId, user_id: input.userId, role: input.role, content: input.content, citations: input.citations ?? [] }).select('id,role,content,citations,created_at').single()
    if (error) throw new Error(`Conversation message write failed: ${error.message}`)
    return { id: String(data.id), role: data.role as ConversationMessage['role'], content: String(data.content), citations: (data.citations ?? []) as Record<string, unknown>[], createdAt: String(data.created_at) }
  }
  async summary(conversationId: string) {
    const { data, error } = await this.db.from('conversation_summaries').select('summary').eq('conversation_id', conversationId).maybeSingle()
    if (error) throw new Error(`Conversation summary lookup failed: ${error.message}`)
    return data?.summary ? String(data.summary) : undefined
  }
}
