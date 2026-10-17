import type { SupabaseClient } from '@supabase/supabase-js'
import type { DocumentContext, DocumentVisibility, SearchResult, DocumentReadResult, ComparisonSource, DocumentVersionDetail, DocumentVersionSummary } from './types.js'

export class DocumentRepository {
  constructor(private readonly db: SupabaseClient) {}

  async findActiveUpload(context: DocumentContext, fingerprint: string) {
    const { data, error } = await this.db.from('document_uploads').select('*').eq('workspace_id', context.workspaceId).eq('user_id', context.userId).eq('upload_mode', 'create').eq('fingerprint', fingerprint).in('status', ['initiated', 'uploading', 'completing']).maybeSingle()
    if (error) throw new Error(`Upload lookup failed: ${error.message}`)
    return data
  }

  async findReplaceUpload(context: DocumentContext, documentId: string, fingerprint: string) {
    const { data, error } = await this.db.from('document_uploads').select('*')
      .eq('workspace_id', context.workspaceId).eq('user_id', context.userId)
      .eq('target_document_id', documentId).eq('upload_mode', 'replace').eq('fingerprint', fingerprint)
      .in('status', ['initiated', 'uploading', 'completing']).maybeSingle()
    if (error) throw new Error(`Replace upload lookup failed: ${error.message}`)
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

  async getUploadForWorker(uploadId: string) {
    const { data, error } = await this.db.from('document_uploads').select('*').eq('id', uploadId).maybeSingle()
    if (error) throw new Error(`Upload lookup failed: ${error.message}`)
    return data
  }

  async getVersionSourceForWorker(versionId: string) {
    const { data, error } = await this.db.from('knowledge_document_versions').select('source_storage_bucket,source_storage_key,source_filename,source_file_size,source_mime_type,content_hash').eq('id', versionId).maybeSingle()
    if (error) throw new Error(`Document version lookup failed: ${error.message}`)
    return data
  }

  async latestReplaceUpload(context: DocumentContext, documentId: string) {
    const { data, error } = await this.db.from('document_uploads').select('*').eq('workspace_id', context.workspaceId).eq('target_document_id', documentId).eq('upload_mode', 'replace').eq('status', 'completed').order('completed_at', { ascending: false }).limit(1).maybeSingle()
    if (error) throw new Error(`Replace upload lookup failed: ${error.message}`)
    return data
  }

  async findDocumentByContentHash(context: DocumentContext, contentHash: string, exceptDocumentId?: string) {
    let query = this.db.from('knowledge_documents').select('id,title,content_hash,status').eq('workspace_id', context.workspaceId).eq('content_hash', contentHash).neq('status', 'deleted')
    if (exceptDocumentId) query = query.neq('id', exceptDocumentId)
    const { data, error } = await query.maybeSingle()
    if (error) throw new Error(`Document hash lookup failed: ${error.message}`)
    return data
  }

  async activeVersionHash(documentId: string) {
    const { data, error } = await this.db.from('knowledge_document_versions').select('id,version,content_hash').eq('document_id', documentId).eq('active', true).maybeSingle()
    if (error) throw new Error(`Active document version lookup failed: ${error.message}`)
    return data
  }

  async setIngestIdle(documentId: string) {
    const { error } = await this.db.from('knowledge_documents').update({ ingest_status: 'idle', error_code: null, error_message: null, updated_at: new Date().toISOString() }).eq('id', documentId)
    if (error) throw new Error(`Document state update failed: ${error.message}`)
  }

  async completeReplaceUpload(context: DocumentContext, documentId: string, uploadId: string, stream: string) {
    const { data, error } = await this.db.rpc('complete_document_replace_upload', { p_workspace_id: context.workspaceId, p_document_id: documentId, p_upload_id: uploadId, p_stream: stream })
    if (error) throw new Error(`Document replace enqueue failed: ${error.message}`)
    return data === true
  }

  async completeUnchangedReplaceUpload(context: DocumentContext, documentId: string, uploadId: string, contentHash: string) {
    const { data, error } = await this.db.rpc('complete_unchanged_document_replace_upload', {
      p_workspace_id: context.workspaceId,
      p_document_id: documentId,
      p_upload_id: uploadId,
      p_content_hash: contentHash,
    })
    if (error) throw new Error(`Unchanged document replace completion failed: ${error.message}`)
    return data === true
  }

  async updateResumableUpload(uploadId: string, patch: Record<string, unknown>) {
    const { data, error } = await this.db.from('document_uploads').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', uploadId).select('*').single()
    if (error) throw new Error(`Upload update failed: ${error.message}`)
    return data
  }

  async claimUploadCompletion(context: DocumentContext, uploadId: string) {
    const { data, error } = await this.db.rpc('claim_document_upload_completion', {
      p_workspace_id: context.workspaceId,
      p_user_id: context.userId,
      p_upload_id: uploadId,
    })
    if (error) throw new Error(`Upload completion claim failed: ${error.message}`)
    return data === true
  }

  async createDocumentFromUpload(context: DocumentContext, upload: any, ingestStream: string) {
    const { data, error } = await this.db.rpc('complete_document_create_upload', {
      p_workspace_id: context.workspaceId,
      p_user_id: context.userId,
      p_upload_id: upload.id,
      p_stream: ingestStream,
    })
    if (error) throw new Error(`Document upload registration failed: ${error.message}`)
    if (!data) throw new Error('Document upload completion could not be committed')
    const document = data as Record<string, unknown>
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
      ingest_status: 'queued', storage_bucket: input.storageBucket, storage_key: input.storageKey, original_filename: input.originalFilename,
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
    const { data, error } = await this.db.from('knowledge_documents').select('*').eq('id', documentId).eq('workspace_id', context.workspaceId).neq('status', 'deleted').maybeSingle()
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
    let versionQuery = this.db.from('knowledge_document_versions').select('id,content,active,status').eq('document_id', documentId).eq('status', 'ready')
    versionQuery = versionId ? versionQuery.eq('id', versionId) : versionQuery.eq('active', true)
    const { data: version, error: versionError } = await versionQuery.maybeSingle()
    if (versionError) throw new Error(`Document version lookup failed: ${versionError.message}`)
    if (!version) throw new Error('DOCUMENT_VERSION_NOT_FOUND')
    const { data: chunks, error: chunkError } = await this.db.from('knowledge_chunks').select('id,content,page_number,heading_path,char_start,char_end,metadata').eq('document_id', documentId).eq('version_id', version.id).order('chunk_index', { ascending: true }).limit(1000)
    if (chunkError) throw new Error(`Document chunks lookup failed: ${chunkError.message}`)
    const content = String(version.content ?? document.content ?? '').slice(0, maxBytes)
    return { documentId, versionId: String(version.id), title: String(document.title), content, chunks: (chunks ?? []).map((row: any) => ({ chunkId: String(row.id), content: String(row.content ?? '').slice(0, maxBytes), pageNumber: row.page_number == null ? undefined : Number(row.page_number), headingPath: Array.isArray(row.heading_path) ? row.heading_path.map(String) : undefined, charStart: row.char_start == null ? undefined : Number(row.char_start), charEnd: row.char_end == null ? undefined : Number(row.char_end), metadata: (row.metadata ?? {}) as Record<string, unknown> })) }
  }

  private mapVersion(row: any, chunkCount = 0): DocumentVersionSummary {
    return { id: String(row.id), version: Number(row.version), status: row.status ?? 'ready', active: Boolean(row.active), parserVersion: row.parser_version ?? undefined, chunkingVersion: row.chunking_version ?? undefined, embeddingModel: row.embedding_model ?? undefined, contentLength: String(row.content ?? '').length, chunkCount, createdAt: String(row.created_at), completedAt: row.completed_at ? String(row.completed_at) : undefined, failedAt: row.failed_at ? String(row.failed_at) : undefined, errorCode: row.error_code ?? undefined, errorMessage: row.error_message ?? undefined, metadata: (row.metadata ?? {}) as Record<string, unknown>, contentHash: row.content_hash ?? undefined, sourceFilename: row.source_filename ?? undefined, sourceFileSize: row.source_file_size == null ? undefined : Number(row.source_file_size), sourceMimeType: row.source_mime_type ?? undefined, retryOfVersionId: row.retry_of_version_id ?? undefined }
  }

  async listVersions(context: DocumentContext, documentId: string): Promise<DocumentVersionSummary[]> {
    const document = await this.get(context, documentId)
    if (!document) return []
    const { data, error } = await this.db.from('knowledge_document_versions').select('id,version,status,active,parser_version,chunking_version,embedding_model,content,created_at,completed_at,failed_at,error_code,error_message,metadata,content_hash,source_filename,source_file_size,source_mime_type,retry_of_version_id').eq('document_id', documentId).order('version', { ascending: false })
    if (error) throw new Error(`Document versions lookup failed: ${error.message}`)
    const rows = data ?? []
    return Promise.all(rows.map(async row => {
      const { count } = await this.db.from('knowledge_chunks').select('id', { count: 'exact', head: true }).eq('version_id', row.id)
      return this.mapVersion(row, Number(count ?? 0))
    }))
  }

  async getVersionDetail(context: DocumentContext, documentId: string, versionId: string, maxBytes = 200_000, chunkOffset = 0, chunkLimit = 100): Promise<DocumentVersionDetail | null> {
    const document = await this.get(context, documentId)
    if (!document) return null
    const { data: version, error } = await this.db.from('knowledge_document_versions').select('id,version,status,active,parser_version,chunking_version,embedding_model,content,created_at,completed_at,failed_at,error_code,error_message,metadata,content_hash,source_filename,source_file_size,source_mime_type,retry_of_version_id').eq('document_id', documentId).eq('id', versionId).maybeSingle()
    if (error) throw new Error(`Document version lookup failed: ${error.message}`)
    if (!version) return null
    const { count, error: countError } = await this.db.from('knowledge_chunks').select('id', { count: 'exact', head: true }).eq('version_id', versionId)
    if (countError) throw new Error(`Document chunks count failed: ${countError.message}`)
    const { data: chunks, error: chunkError } = await this.db.from('knowledge_chunks').select('id,chunk_index,content,page_number,heading_path,char_start,char_end,token_count,metadata').eq('document_id', documentId).eq('version_id', versionId).order('chunk_index', { ascending: true }).range(Math.max(0, chunkOffset), Math.max(0, chunkOffset) + Math.min(500, Math.max(1, chunkLimit)) - 1)
    if (chunkError) throw new Error(`Document chunks lookup failed: ${chunkError.message}`)
    const summary = this.mapVersion(version, Number(count ?? 0))
    return { ...summary, content: String(version.content ?? '').slice(0, maxBytes), chunks: (chunks ?? []).map((row: any) => ({ id: String(row.id), index: Number(row.chunk_index), content: String(row.content ?? '').slice(0, maxBytes), pageNumber: row.page_number == null ? undefined : Number(row.page_number), headingPath: Array.isArray(row.heading_path) ? row.heading_path.map(String) : undefined, charStart: row.char_start == null ? undefined : Number(row.char_start), charEnd: row.char_end == null ? undefined : Number(row.char_end), tokenCount: row.token_count == null ? undefined : Number(row.token_count), metadata: (row.metadata ?? {}) as Record<string, unknown> })) }
  }

  async getVersionSource(context: DocumentContext, documentId: string, versionId: string) {
    const document = await this.get(context, documentId)
    if (!document) return null
    const { data, error } = await this.db.from('knowledge_document_versions').select('id,status,source_storage_bucket,source_storage_key,source_filename,source_file_size,source_mime_type,content_hash').eq('id', versionId).eq('document_id', documentId).maybeSingle()
    if (error) throw new Error(`Document version lookup failed: ${error.message}`)
    return data
  }

  async detail(context: DocumentContext, documentId: string) {
    const document = await this.get(context, documentId)
    if (!document) return null
    const versions = await this.listVersions(context, documentId)
    const activeVersion = versions.find(version => version.active)
    return { ...document, ingest_status: document.ingest_status ?? (document.status === 'ready' ? 'idle' : document.status), active_version: activeVersion ?? null }
  }

  async getComparisonSources(context: DocumentContext, documentIds: string[], maxBytes = 200_000): Promise<ComparisonSource[]> {
    const unique = [...new Set(documentIds)]
    if (unique.length < 2 || unique.length > 8) throw new Error('INVALID_COMPARISON_DOCUMENTS')
    return Promise.all(unique.map(id => this.getAuthorized(context, id, undefined, maxBytes)))
  }

  async claimIngest(documentId: string) {
    const { data, error } = await this.db.rpc('claim_document_ingest', { p_document_id: documentId })
    if (error) throw new Error(`Document claim failed: ${error.message}`)
    return Array.isArray(data) ? data[0] ?? null : data
  }

  async markReady(documentId: string, versionId: string) {
    const { error: versionError } = await this.db.from('knowledge_document_versions').update({ status: 'ready', completed_at: new Date().toISOString(), error_code: null, error_message: null }).eq('id', versionId).eq('document_id', documentId)
    if (versionError) throw new Error(`Document version update failed: ${versionError.message}`)
    const { data, error } = await this.db.rpc('activate_document_version', { p_document_id: documentId, p_version_id: versionId })
    if (error || data !== true) throw new Error(`Document version activation failed: ${error?.message ?? 'version not found'}`)
  }

  async markFailed(documentId: string, code: string, message: string) {
    const { count } = await this.db.from('knowledge_document_versions').select('id', { count: 'exact', head: true }).eq('document_id', documentId).eq('active', true).eq('status', 'ready')
    await this.db.from('knowledge_documents').update({ status: Number(count ?? 0) > 0 ? 'ready' : 'failed', ingest_status: 'failed', error_code: code, error_message: message.slice(0, 2000), updated_at: new Date().toISOString() }).eq('id', documentId)
  }

  async retryIngest(documentId: string, stream: string, delayMs: number, payload: Record<string, unknown> = {}, allowProcessing = false) {
    const { data, error } = await this.db.rpc('enqueue_document_ingest', { p_document_id: documentId, p_stream: stream, p_payload: { documentId, attempt: 1, ...payload }, p_delay_ms: delayMs, p_allow_processing: allowProcessing })
    if (error) throw new Error(`Document retry enqueue failed: ${error.message}`)
    return data === true
  }

  async createBuildingVersion(documentId: string, versions: { parser: string; chunking: string; embedding: string }, source?: { contentHash?: string; fileName?: string; fileSize?: number; mimeType?: string; storageBucket?: string; storageKey?: string; retryOfVersionId?: string }) {
    const { data: previous } = await this.db.from('knowledge_document_versions').select('version').eq('document_id', documentId).order('version', { ascending: false }).limit(1).maybeSingle()
    const { data: version, error } = await this.db.from('knowledge_document_versions').insert({ document_id: documentId, version: Number(previous?.version ?? 0) + 1, content: '', parser_version: versions.parser, chunking_version: versions.chunking, embedding_model: versions.embedding, status: 'building', active: false, content_hash: source?.contentHash, source_filename: source?.fileName, source_file_size: source?.fileSize, source_mime_type: source?.mimeType, source_storage_bucket: source?.storageBucket, source_storage_key: source?.storageKey, retry_of_version_id: source?.retryOfVersionId }).select('id').single()
    if (error) throw new Error(`Document version creation failed: ${error.message}`)
    return String(version.id)
  }

  async persistVersionChunks(documentId: string, versionId: string, parsedText: string, chunks: Array<{ index: number; content: string; embedding?: number[]; headingPath: string[]; pageNumber?: number; charStart: number; charEnd: number; tokenCount: number; metadata: Record<string, unknown> }>) {
    const { data: document, error: documentError } = await this.db.from('knowledge_documents').select('workspace_id').eq('id', documentId).single()
    if (documentError || !document) throw new Error('Document workspace lookup failed')
    const rows = chunks.map(chunk => ({ document_id: documentId, version_id: versionId, workspace_id: document.workspace_id, chunk_index: chunk.index, content: chunk.content, metadata: chunk.metadata, heading_path: chunk.headingPath, page_number: chunk.pageNumber ?? null, char_start: chunk.charStart, char_end: chunk.charEnd, token_count: chunk.tokenCount, embedding: chunk.embedding ? JSON.stringify(chunk.embedding) : null }))
    const { error: versionError } = await this.db.from('knowledge_document_versions').update({ content: parsedText }).eq('id', versionId).eq('document_id', documentId).eq('status', 'building')
    if (versionError) throw new Error(`Document version update failed: ${versionError.message}`)
    const { error: chunkError } = await this.db.from('knowledge_chunks').insert(rows)
    if (chunkError) {
      await this.markVersionFailed(versionId, 'CHUNK_PERSIST_FAILED', chunkError.message).catch(() => undefined)
      throw new Error(`Document chunk creation failed: ${chunkError.message}`)
    }
  }

  async markVersionFailed(versionId: string, code: string, message: string) {
    const { error } = await this.db.from('knowledge_document_versions').update({ status: 'failed', error_code: code, error_message: message.slice(0, 2000), failed_at: new Date().toISOString() }).eq('id', versionId)
    if (error) throw new Error(`Document version failure update failed: ${error.message}`)
  }

  async activateVersion(context: DocumentContext, documentId: string, versionId: string) {
    const document = await this.get(context, documentId)
    if (!document) return null
    const { data: version, error } = await this.db.from('knowledge_document_versions').select('id,content,parser_version,chunking_version,embedding_model,status').eq('id', versionId).eq('document_id', documentId).maybeSingle()
    if (error) throw new Error(`Document version lookup failed: ${error.message}`)
    if (!version) return null
    if (version.status !== 'ready') throw new Error('DOCUMENT_VERSION_NOT_READY')
    const { data: activated, error: activateError } = await this.db.rpc('activate_document_version', { p_document_id: documentId, p_version_id: versionId })
    if (activateError || activated !== true) throw new Error(`Document version activation failed: ${activateError?.message ?? 'version is not ready'}`)
    return this.detail(context, documentId)
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
        metadata: input.metadata ?? {}, status: 'ready', ingest_status: 'idle',
      })
      .select('id,title,content,visibility,metadata,created_at')
      .single()
    if (error) throw new Error(`Document creation failed: ${error.message}`)
    const { data: version, error: versionError } = await this.db.from('knowledge_document_versions').insert({
      document_id: document.id, version: 1, content: input.content, parser_version: 'text-v1', chunking_version: 'fixed-v1', embedding_model: 'provided', active: true, status: 'ready', completed_at: new Date().toISOString(),
    }).select('id').single()
    if (versionError || !version) throw new Error(`Document version creation failed: ${versionError?.message ?? 'unknown error'}`)
    const rows = input.chunks.map(chunk => ({
      document_id: document.id,
      workspace_id: context.workspaceId,
      version_id: version.id,
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
      .select('id,title,content,visibility,metadata,status,ingest_status,error_code,error_message,ingest_attempt,original_filename,mime_type,file_size,created_at,updated_at')
      .eq('workspace_id', context.workspaceId)
      .neq('status', 'deleted')
      .or(`visibility.eq.workspace,owner_id.eq.${context.userId}`)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 100))
    if (error) throw new Error(`Document listing failed: ${error.message}`)
    return data ?? []
  }

  async delete(context: DocumentContext, documentId: string) {
    const { data, error } = await this.db
      .from('knowledge_documents')
      .delete()
      .eq('id', documentId)
      .eq('workspace_id', context.workspaceId)
      .neq('status', 'deleted')
      .select('id')
      .maybeSingle()
    if (error) throw new Error(`Document deletion failed: ${error.message}`)
    return Boolean(data)
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
