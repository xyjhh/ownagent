import type { SupabaseClient } from '@supabase/supabase-js'
import type { DocumentContext, DocumentVisibility, SearchResult } from './types.js'

export class DocumentRepository {
  constructor(private readonly db: SupabaseClient) {}

  async create(context: DocumentContext, input: { title: string; content: string; visibility: DocumentVisibility; metadata?: Record<string, unknown>; chunks: Array<{ index: number; content: string; embedding?: number[] }> }) {
    const { data: document, error } = await this.db.from('knowledge_documents').insert({ workspace_id: context.workspaceId, owner_id: context.userId, title: input.title, content: input.content, visibility: input.visibility, metadata: input.metadata ?? {} }).select('id,title,content,visibility,metadata,created_at').single()
    if (error) throw new Error(`Document creation failed: ${error.message}`)
    const rows = input.chunks.map(chunk => ({ document_id: document.id, workspace_id: context.workspaceId, chunk_index: chunk.index, content: chunk.content, embedding: chunk.embedding ? JSON.stringify(chunk.embedding) : null }))
    const { error: chunkError } = await this.db.from('knowledge_chunks').insert(rows)
    if (chunkError) throw new Error(`Document chunk creation failed: ${chunkError.message}`)
    return { id: String(document.id), title: String(document.title), content: String(document.content), visibility: String(document.visibility) as DocumentVisibility, metadata: document.metadata ?? {}, createdAt: String(document.created_at) }
  }

  async list(context: DocumentContext, limit = 50) {
    const { data, error } = await this.db.from('knowledge_documents').select('id,title,content,visibility,metadata,created_at').eq('workspace_id', context.workspaceId).or(`visibility.eq.workspace,owner_id.eq.${context.userId}`).order('created_at', { ascending: false }).limit(Math.min(limit, 100))
    if (error) throw new Error(`Document listing failed: ${error.message}`)
    return data ?? []
  }

  async search(context: DocumentContext, embedding: number[], limit: number): Promise<SearchResult[]> {
    const { data, error } = await this.db.rpc('search_knowledge_chunks', { p_workspace_id: context.workspaceId, p_user_id: context.userId, p_query_embedding: JSON.stringify(embedding), p_limit: limit })
    if (error) throw new Error(`Knowledge search failed: ${error.message}`)
    return (data ?? []).map((row: Record<string, unknown>) => ({ chunkId: String(row.chunk_id), documentId: String(row.document_id), title: String(row.title), content: String(row.content), metadata: (row.metadata ?? {}) as Record<string, unknown>, score: Number(row.score) }))
  }
}
