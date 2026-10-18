import type { SupabaseClient } from '@supabase/supabase-js'
import { selectRecentMessagesByTokenBudget, type TokenWindowResult } from './token-window.js'

export type ConversationMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  citations: Record<string, unknown>[]
  createdAt: string
}
export type ConversationSummaryRecord = {
  summary: string
  coveredUntilMessageId?: string
  model?: string
  promptVersion?: string
  updatedAt: string
}

export class ConversationRepository {
  constructor(private readonly db: SupabaseClient) {}
  async list(workspaceId: string, userId: string, limit = 50, archived = false) {
    const { data, error } = await this.db
      .from('conversations')
      .select('id,workspace_id,created_by,title,created_at,updated_at')
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 100))
    if (error) throw new Error(`Conversation listing failed: ${error.message}`)
    const { data: archiveRows, error: archiveError } = await this.db
      .from('conversation_archives')
      .select('conversation_id,archived_at')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
    if (archiveError) throw new Error(`Conversation archive lookup failed: ${archiveError.message}`)
    const archivedById = new Map(
      (archiveRows ?? []).map(row => [String(row.conversation_id), String(row.archived_at)])
    )
    return (data ?? [])
      .filter(row => archivedById.has(String(row.id)) === archived)
      .map(row => ({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        createdBy: String(row.created_by),
        title: String(row.title),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at ?? row.created_at),
        archivedAt: archivedById.get(String(row.id)),
      }))
  }
  async belongsToWorkspace(conversationId: string, workspaceId: string) {
    const { data, error } = await this.db
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) throw new Error(`Conversation lookup failed: ${error.message}`)
    return Boolean(data)
  }
  async setArchived(
    conversationId: string,
    workspaceId: string,
    userId: string,
    archived: boolean
  ) {
    if (!(await this.belongsToWorkspace(conversationId, workspaceId))) return false
    if (archived) {
      const { error } = await this.db
        .from('conversation_archives')
        .upsert(
          { conversation_id: conversationId, workspace_id: workspaceId, user_id: userId },
          { onConflict: 'user_id,conversation_id' }
        )
      if (error) throw new Error(`Conversation archive update failed: ${error.message}`)
    } else {
      const { error } = await this.db
        .from('conversation_archives')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
      if (error) throw new Error(`Conversation restore failed: ${error.message}`)
    }
    return true
  }
  async recent(conversationId: string, limit: number) {
    const { data, error } = await this.db
      .from('conversation_messages')
      .select('id,role,content,citations,created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(`Conversation history failed: ${error.message}`)
    return (data ?? [])
      .reverse()
      .map(row => ({
        id: String(row.id),
        role: row.role as ConversationMessage['role'],
        content: String(row.content),
        citations: (row.citations ?? []) as Record<string, unknown>[],
        createdAt: String(row.created_at),
      }))
  }
  async recentByTokenBudget(
    conversationId: string,
    tokenBudget: number
  ): Promise<TokenWindowResult> {
    const pageSize = 50
    const rows: Record<string, unknown>[] = []
    let offset = 0
    while (true) {
      const { data, error } = await this.db
        .from('conversation_messages')
        .select('id,role,content,citations,created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + pageSize - 1)
      if (error) throw new Error(`Conversation token window lookup failed: ${error.message}`)
      const page = data ?? []
      rows.push(...page)
      const window = selectRecentMessagesByTokenBudget(this.mapMessages(rows), tokenBudget)
      if (window.truncated || page.length < pageSize) return window
      offset += pageSize
    }
  }
  async append(input: {
    conversationId: string
    workspaceId: string
    userId: string
    role: ConversationMessage['role']
    content: string
    citations?: Record<string, unknown>[]
  }) {
    const { data, error } = await this.db
      .from('conversation_messages')
      .insert({
        conversation_id: input.conversationId,
        workspace_id: input.workspaceId,
        user_id: input.userId,
        role: input.role,
        content: input.content,
        citations: input.citations ?? [],
      })
      .select('id,role,content,citations,created_at')
      .single()
    if (error) throw new Error(`Conversation message write failed: ${error.message}`)
    await this.db
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', input.conversationId)
      .eq('workspace_id', input.workspaceId)
    return {
      id: String(data.id),
      role: data.role as ConversationMessage['role'],
      content: String(data.content),
      citations: (data.citations ?? []) as Record<string, unknown>[],
      createdAt: String(data.created_at),
    }
  }
  async summary(conversationId: string) {
    const record = await this.summaryRecord(conversationId)
    return record?.summary || undefined
  }
  async summaryRecord(conversationId: string): Promise<ConversationSummaryRecord | undefined> {
    const { data, error } = await this.db
      .from('conversation_summaries')
      .select('summary,covered_until_message_id,model,prompt_version,updated_at')
      .eq('conversation_id', conversationId)
      .maybeSingle()
    if (error) throw new Error(`Conversation summary lookup failed: ${error.message}`)
    if (!data) return undefined
    return {
      summary: String(data.summary ?? ''),
      coveredUntilMessageId: data.covered_until_message_id
        ? String(data.covered_until_message_id)
        : undefined,
      model: data.model ? String(data.model) : undefined,
      promptVersion: data.prompt_version ? String(data.prompt_version) : undefined,
      updatedAt: String(data.updated_at),
    }
  }
  async summaryMessages(conversationId: string, afterMessageId?: string, limit = 500) {
    const select = 'id,role,content,citations,created_at'
    if (!afterMessageId) {
      const { data, error } = await this.db
        .from('conversation_messages')
        .select(select)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
      if (error) throw new Error(`Conversation summary messages lookup failed: ${error.message}`)
      return this.mapMessages(data ?? [])
    }

    const { data: marker, error: markerError } = await this.db
      .from('conversation_messages')
      .select('id,created_at')
      .eq('conversation_id', conversationId)
      .eq('id', afterMessageId)
      .maybeSingle()
    if (markerError)
      throw new Error(`Conversation summary marker lookup failed: ${markerError.message}`)
    if (!marker) return undefined

    const { data, error } = await this.db
      .from('conversation_messages')
      .select(select)
      .eq('conversation_id', conversationId)
      .gte('created_at', String(marker.created_at))
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(Math.max(limit + 100, 500))
    if (error) throw new Error(`Conversation summary messages lookup failed: ${error.message}`)
    const rows = data ?? []
    const markerIndex = rows.findIndex(row => String(row.id) === afterMessageId)
    if (markerIndex < 0) return undefined
    return this.mapMessages(rows.slice(markerIndex + 1, markerIndex + 1 + limit))
  }
  async updateTitleIfLatest(conversationId: string, title: string, expectedLastMessageId?: string) {
    if (!expectedLastMessageId) return false
    const { data, error } = await this.db.rpc('update_conversation_title_if_latest', {
      p_conversation_id: conversationId,
      p_title: title,
      p_expected_last_message_id: expectedLastMessageId,
    })
    if (error) throw new Error(`Conversation title update failed: ${error.message}`)
    return Boolean(data)
  }
  private mapMessages(rows: Array<Record<string, unknown>>) {
    return rows.map(row => ({
      id: String(row.id),
      role: row.role as ConversationMessage['role'],
      content: String(row.content ?? ''),
      citations: (row.citations ?? []) as Record<string, unknown>[],
      createdAt: String(row.created_at),
    }))
  }
}
