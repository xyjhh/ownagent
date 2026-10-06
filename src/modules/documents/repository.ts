import type { SupabaseClient } from '@supabase/supabase-js'
import type { DocumentContext, DocumentVisibility, SearchResult, DocumentReadResult, ComparisonSource } from './types.js'

export class DocumentRepository {
  constructor(private readonly db: SupabaseClient) {}

  async findActiveUpload(context: DocumentContext, fingerprint: string) {
    const { data, error } = await this.db.from('document_uploads').select('*').eq('workspace_id', context.workspaceId).eq('user_id', context.userId).eq('fingerprint', fingerprint).in('status', ['initiated', 'uploading', 'completing']).maybeSingle()
    if (error) throw new Error(`Upload lookup failed: ${error.message}`)
    return data
  }

  async countActiveUploads(context: DocumentContext) {
    const { count, error } = await this.db.from('document_uploads').select('id', { count: 'exact', head: true }).eq('workspace_id', context.workspaceId).eq('user_id', context.userId).in('status', ['initiated', 'uploading', 'completing'])
    if (error) throw new Error(`Upload count failed: ${error.message}`)
    return Number(count ?? 0)
  }

  async createResumableUpload(context: DocumentContext, input: Record<string, unknown>) {
    const { data, error } = await this.db.from('document_uploads').insert({ workspace_id: context.workspaceId, user_id: context.userId, ...input }).select('*').single()
    if (error) throw new Error(`Upload creation failed: ${error.message}`)
    return data
  }

  async getResumableUpload(context: DocumentContext, uploadId: string) {
    const { data, error } = await this.db.from('document_uploads').select('*').eq('id', uploadId).eq('workspace_id', context.workspaceId).eq('user_id', context.userId).maybeSingle()
    if (error) throw new Error(`Upload lookup failed: ${error.message}`)
    return data
  }

  async updateResumableUpload(uploadId: string, patch: Record<string, unknown>) {
    const { data, error } = await this.db.from('document_uploads').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', uploadId).select('*').single()
    if (error) throw new Error(`Upload update failed: ${error.message}`)
    return data
  }

  async createDocumentFromUpload(context: DocumentContext, upload: any, ingestStream: string) {
    if (upload.document_id) return { id: String(upload.document_id), status: 'queued' }
    const title = String(upload.original_filename).replace(/\.[^.]+$/, '').slice(0, 300) || 'Uploaded document'
    const { data: document, error } = await this.db.from('knowledge_documents').insert({ workspace_id: context.workspaceId, owner_id: context.userId, title, content: '', visibility: 'workspace', metadata: {}, status: 'queued', source_type: 'upload', storage_bucket: upload.storage_bucket, storage_key: upload.storage_key, original_filename: upload.original_filename, mime_type: upload.mime_type, file_size: upload.file_size, content_hash: upload.content_hash }).select('id,title,status,created_at').single()
    if (error) throw new Error(`Document upload registration failed: ${error.message}`)
    const { error: outboxError } = await this.db.from('task_outbox').insert({ document_id: document.id, document_upload_id: upload.id, workspace_id: context.workspaceId, stream: ingestStream, payload: { documentId: document.id, uploadId: upload.id, attempt: 1 } })
    if (outboxError) throw new Error(`Document ingest enqueue failed: ${outboxError.message}`)
    return { id: String(document.id), title: String(document.title), status: String(document.status), createdAt: String(document.created_at) }
  }

  async createUpload(context: DocumentContext, input: {
    title: string
    visibility: DocumentVisibility
    metadata?: Record<string, unknown>
    storageBucket: string
    storageKey: string
    originalFilename: string
    mimeType: string
    fileSize: number
    contentHash: string
    ingestStream: string
  }) {
    const { data, error } = await this.db.from('knowledge_documents').insert({
      workspace_id: context.workspaceId, owner_id: context.userId, title: input.title,
      content: '', visibility: input.visibility, metadata: input.metadata ?? {}, status: 'queued', source_type: 'upload',
      storage_bucket: input.storageBucket, storage_key: input.storageKey, original_filename: input.originalFilename,
      mime_type: input.mimeType, file_size: input.fileSize, content_hash: input.contentHash,
    }).select('id,title,status,created_at').single()
    if (error) throw new Error(`Document upload registration failed: ${error.message}`)
    const { error: outboxError } = await this.db.from('task_outbox').insert({
      document_id: data.id, workspace_id: context.workspaceId, stream: input.ingestStream,
      payload: { documentId: data.id, contentHash: input.contentHash, attempt: 1 },
    })
    if (outboxError) throw new Error(`Document ingest enqueue failed: ${outboxError.message}`)
    return { id: String(data.id), title: String(data.title), status: String(data.status), createdAt: String(data.created_at) }
  }

  async get(context: DocumentContext, documentId: string) {
    const { data, error } = await this.db.from('knowledge_documents').select('*').eq('id', documentId).eq('workspace_id', context.workspaceId).maybeSingle()
    if (error) throw new Error(`Document lookup failed: ${error.message}`)
    if (data && data.visibility === 'private' && data.owner_id !== context.userId) {
      const { data: member, error: memberError } = await this.db.from('knowledge_document_members').select('document_id').eq('document_id', documentId).eq('user_id', context.userId).maybeSingle()
      if (memberError) throw new Error(`Document ACL lookup failed: ${memberError.message}`)
      if (!member) return null
    }
    return data
  }

  async getAuthorized(context: DocumentContext, documentId: string, versionId?: string, maxBytes = 200_000): Promise<DocumentReadResult> {
    const document = await this.get(context, documentId)
    if (!document || document.status !== 'ready') throw new Error('DOCUMENT_NOT_READY')
    const { data: version, error: versionError } = await this.db.from('knowledge_document_versions').select('id,content,active').eq('document_id', documentId).eq(versionId ? 'id' : 'active', versionId ?? true).eq('active', true).maybeSingle()
    if (versionError) throw new Error(`Document version lookup failed: ${versionError.message}`)
    if (!version) throw new Error('DOCUMENT_VERSION_NOT_FOUND')
    const { data: chunks, error: chunkError } = await this.db.from('knowledge_chunks').select('id,content,page_number,heading_path,char_start,char_end,metadata').eq('document_id', documentId).eq('version_id', version.id).order('chunk_index', { ascending: true }).limit(1000)
    if (chunkError) throw new Error(`Document chunks lookup failed: ${chunkError.message}`)
    const content = String(version.content ?? document.content ?? '').slice(0, maxBytes)
    return { documentId, versionId: String(version.id), title: String(document.title), content, chunks: (chunks ?? []).map((row: any) => ({ chunkId: String(row.id), content: String(row.content ?? '').slice(0, maxBytes), pageNumber: row.page_number == null ? undefined : Number(row.page_number), headingPath: Array.isArray(row.heading_path) ? row.heading_path.map(String) : undefined, charStart: row.char_start == null ? undefined : Number(row.char_start), charEnd: row.char_end == null ? undefined : Number(row.char_end), metadata: (row.metadata ?? {}) as Record<string, unknown> })) }
  }

  async getComparisonSources(context: DocumentContext, documentIds: string[], maxBytes = 200_000): Promise<ComparisonSource[]> {
    const unique = [...new Set(documentIds)]
    if (unique.length < 2 || unique.length > 8) throw new Error('INVALID_COMPARISON_DOCUMENTS')
    return Promise.all(unique.map(id => this.getAuthorized(context, id, undefined, maxBytes)))
  }

  async claimIngest(documentId: string) {
    const current = await this.db.from('knowledge_documents').select('ingest_attempt').eq('id', documentId).single()
    const attempt = Number(current.data?.ingest_attempt ?? 0) + 1
    const { data, error } = await this.db.from('knowledge_documents').update({ status: 'processing', ingest_attempt: attempt, updated_at: new Date().toISOString() }).eq('id', documentId).in('status', ['queued', 'processing']).select('*').maybeSingle()
    if (error) throw new Error(`Document claim failed: ${error.message}`)
    return data
  }

  async markReady(documentId: string, versionId: string) {
    const { error } = await this.db.from('knowledge_documents').update({ status: 'ready', error_code: null, error_message: null, updated_at: new Date().toISOString() }).eq('id', documentId)
    if (error) throw new Error(`Document ready update failed: ${error.message}`)
    await this.db.from('knowledge_document_versions').update({ active: false }).eq('document_id', documentId).neq('id', versionId)
    const { error: versionError } = await this.db.from('knowledge_document_versions').update({ active: true }).eq('id', versionId)
    if (versionError) throw new Error(`Document version activation failed: ${versionError.message}`)
  }

  async markFailed(documentId: string, code: string, message: string) {
    await this.db.from('knowledge_documents').update({ status: 'failed', error_code: code, error_message: message.slice(0, 2000), updated_at: new Date().toISOString() }).eq('id', documentId)
  }

  async retryIngest(documentId: string, stream: string, delayMs: number) {
    await this.db.from('knowledge_documents').update({ status: 'queued', error_code: 'RETRYABLE', error_message: null, updated_at: new Date().toISOString() }).eq('id', documentId)
    const { error } = await this.db.from('task_outbox').insert({ document_id: documentId, stream, payload: { documentId, attempt: 1 }, available_at: new Date(Date.now() + delayMs).toISOString() })
    if (error) throw new Error(`Document retry enqueue failed: ${error.message}`)
  }

  async createVersion(documentId: string, parsedText: string, chunks: Array<{ index: number; content: string; embedding?: number[]; headingPath: string[]; pageNumber?: number; charStart: number; charEnd: number; tokenCount: number; metadata: Record<string, unknown> }>, versions: { parser: string; chunking: string; embedding: string }) {
    const { data: previous } = await this.db.from('knowledge_document_versions').select('version').eq('document_id', documentId).order('version', { ascending: false }).limit(1).maybeSingle()
    const { data: version, error } = await this.db.from('knowledge_document_versions').insert({ document_id: documentId, version: Number(previous?.version ?? 0) + 1, content: parsedText, parser_version: versions.parser, chunking_version: versions.chunking, embedding_model: versions.embedding }).select('id').single()
    if (error) throw new Error(`Document version creation failed: ${error.message}`)
    const { data: document, error: documentError } = await this.db.from('knowledge_documents').select('workspace_id').eq('id', documentId).single()
    if (documentError || !document) throw new Error('Document workspace lookup failed')
    const rows = chunks.map(chunk => ({ document_id: documentId, version_id: version.id, workspace_id: document.workspace_id, chunk_index: chunk.index, content: chunk.content, metadata: chunk.metadata, heading_path: chunk.headingPath, page_number: chunk.pageNumber ?? null, char_start: chunk.charStart, char_end: chunk.charEnd, token_count: chunk.tokenCount, embedding: chunk.embedding ? JSON.stringify(chunk.embedding) : null }))
    const { error: chunkError } = await this.db.from('knowledge_chunks').insert(rows)
    if (chunkError) throw new Error(`Document chunk creation failed: ${chunkError.message}`)
    await this.db.from('knowledge_documents').update({ content: parsedText, parser_version: versions.parser, chunking_version: versions.chunking, embedding_model: versions.embedding }).eq('id', documentId)
    return String(version.id)
  }

  async create(
    context: DocumentContext,
    input: {
      title: string
      content: string
      visibility: DocumentVisibility
      metadata?: Record<string, unknown>
      chunks: Array<{ index: number; content: string; embedding?: number[] }>
    }
  ) {
    const { data: document, error } = await this.db
      .from('knowledge_documents')
      .insert({
        workspace_id: context.workspaceId,
        owner_id: context.userId,
        title: input.title,
        content: input.content,
        visibility: input.visibility,
        metadata: input.metadata ?? {},
      })
      .select('id,title,content,visibility,metadata,created_at')
      .single()
    if (error) throw new Error(`Document creation failed: ${error.message}`)
    const rows = input.chunks.map(chunk => ({
      document_id: document.id,
      workspace_id: context.workspaceId,
      chunk_index: chunk.index,
      content: chunk.content,
      embedding: chunk.embedding ? JSON.stringify(chunk.embedding) : null,
    }))
    const { error: chunkError } = await this.db.from('knowledge_chunks').insert(rows)
    if (chunkError) throw new Error(`Document chunk creation failed: ${chunkError.message}`)
    return {
      id: String(document.id),
      title: String(document.title),
      content: String(document.content),
      visibility: String(document.visibility) as DocumentVisibility,
      metadata: document.metadata ?? {},
      createdAt: String(document.created_at),
    }
  }

  async list(context: DocumentContext, limit = 50) {
    const { data, error } = await this.db
      .from('knowledge_documents')
      .select('id,title,content,visibility,metadata,created_at')
      .eq('workspace_id', context.workspaceId)
      .or(`visibility.eq.workspace,owner_id.eq.${context.userId}`)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 100))
    if (error) throw new Error(`Document listing failed: ${error.message}`)
    return data ?? []
  }

  async search(
    context: DocumentContext,
    embedding: number[],
    limit: number
  ): Promise<SearchResult[]> {
    return this.searchVector(context, embedding, limit)
  }

  async searchVector(
    context: DocumentContext,
    embedding: number[],
    limit: number
  ): Promise<SearchResult[]> {
    const { data, error } = await this.db.rpc('search_knowledge_chunks', {
      p_workspace_id: context.workspaceId,
      p_user_id: context.userId,
      p_query_embedding: JSON.stringify(embedding),
      p_limit: limit,
    })
    if (error) throw new Error(`Knowledge search failed: ${error.message}`)
    return (data ?? []).map((row: Record<string, unknown>) => ({
      chunkId: String(row.chunk_id),
      documentId: String(row.document_id),
      title: String(row.title),
      content: String(row.content),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      score: Number(row.score),
      versionId: row.version_id ? String(row.version_id) : undefined,
      pageNumber: row.page_number ? Number(row.page_number) : undefined,
      headingPath: Array.isArray(row.heading_path) ? row.heading_path.map(String) : undefined,
    }))
  }

  async searchLexical(context: DocumentContext, query: string, limit: number): Promise<SearchResult[]> {
    const { data, error } = await this.db.rpc('search_knowledge_chunks_lexical', {
      p_workspace_id: context.workspaceId,
      p_user_id: context.userId,
      p_query: query,
      p_limit: limit,
    })
    if (error) throw new Error(`Knowledge lexical search failed: ${error.message}`)
    return (data ?? []).map((row: Record<string, unknown>) => ({
      chunkId: String(row.chunk_id),
      documentId: String(row.document_id),
      title: String(row.title),
      content: String(row.content),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      score: Number(row.score),
      versionId: row.version_id ? String(row.version_id) : undefined,
      pageNumber: row.page_number ? Number(row.page_number) : undefined,
      headingPath: Array.isArray(row.heading_path) ? row.heading_path.map(String) : undefined,
    }))
  }
}
