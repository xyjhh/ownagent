import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceAccess } from '../workspaces/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { WorkspaceRepository } from '../workspaces/repository.js'
import type { EmbeddingClient } from '../../integrations/embedding.js'
import type { RerankerClient } from '../../integrations/reranker.js'
import { DocumentRepository } from './repository.js'
import { DocumentService } from './service.js'
import type { AppConfig } from '../../config/env.js'
import { SupabaseResumableStorage } from './resumable-storage.js'
import { SupabaseMultipartStorage } from './multipart-storage.js'
import { ApiError } from '../auth/errors.js'

export function createDocumentRouter(
  auth: AuthService,
  workspaceRepository: WorkspaceRepository,
  db: any,
  embedding: EmbeddingClient,
  reranker: RerankerClient,
  config?: AppConfig,
  storageDb: any = db
): Router {
  const router = Router()
  const repository = new DocumentRepository(db)
  const service = new DocumentService(repository, embedding, reranker, config?.RETRIEVAL_MODE ?? 'hybrid')
  const resumable = config ? new SupabaseResumableStorage(config) : null
  const multipart = config?.SUPABASE_S3_ENDPOINT && config.SUPABASE_S3_ACCESS_KEY && config.SUPABASE_S3_SECRET_KEY ? new SupabaseMultipartStorage(config) : null
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config?.DOCUMENT_MAX_FILE_SIZE_BYTES ?? 52_428_800 } })
  const access = requireWorkspaceAccess(
    auth,
    workspaceRepository,
    ['owner', 'admin', 'editor', 'viewer'],
    config
  )
  router.get('/:workspaceId/documents', access, async (request, response, next) => {
    try {
      response.json({ documents: await service.list(request.workspace!) })
    } catch (error) {
      next(error)
    }
  })
  router.get('/:workspaceId/documents/:documentId', access, async (request, response, next) => {
    try {
      const document = await repository.detail(request.workspace!, String(request.params.documentId))
      if (!document) return response.status(404).json({ error: 'DOCUMENT_NOT_FOUND' })
      response.json({ document })
    } catch (error) { next(error) }
  })
  router.get('/:workspaceId/documents/:documentId/versions', access, async (request, response, next) => {
    try {
      const document = await repository.get(request.workspace!, String(request.params.documentId))
      if (!document) return response.status(404).json({ error: 'DOCUMENT_NOT_FOUND' })
      response.json({ versions: await repository.listVersions(request.workspace!, String(request.params.documentId)) })
    } catch (error) { next(error) }
  })
  router.get('/:workspaceId/documents/:documentId/versions/:versionId', access, async (request, response, next) => {
    try {
      const input = z.object({ include: z.string().optional(), chunkOffset: z.coerce.number().int().min(0).default(0), chunkLimit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query)
      const include = new Set((input.include ?? 'content,chunks').split(',').map(value => value.trim()))
      const detail = await repository.getVersionDetail(request.workspace!, String(request.params.documentId), String(request.params.versionId), include.has('content') ? 200_000 : 0, include.has('chunks') ? input.chunkOffset : 0, include.has('chunks') ? input.chunkLimit : 1)
      if (!detail) return response.status(404).json({ error: 'DOCUMENT_VERSION_NOT_FOUND' })
      response.json({ version: { ...detail, content: include.has('content') ? detail.content : '', chunks: include.has('chunks') ? detail.chunks : [] } })
    } catch (error) { next(error) }
  })
  router.post('/:workspaceId/documents/:documentId/retry', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    try {
      const documentId = String(request.params.documentId)
      const document = await repository.get(request.workspace!, documentId)
      if (!document) return response.status(404).json({ error: 'DOCUMENT_NOT_FOUND' })
      if (document.status !== 'failed' && document.ingest_status !== 'failed') throw new ApiError(409, 'DOCUMENT_NOT_RETRYABLE', 'Document is not in a failed state')
      const upload = await repository.latestReplaceUpload(request.workspace!, documentId)
      const payload = upload ? { uploadId: upload.id, mode: 'replace' } : { mode: 'reparse' }
      if (!await repository.retryIngest(documentId, config?.REDIS_STREAM_DOCUMENT_INGEST ?? 'ownagent:document-ingest', 0, payload)) throw new ApiError(409, 'DOCUMENT_INGEST_IN_PROGRESS', 'Document ingestion is already in progress')
      response.status(202).json({ documentId, status: 'queued' })
    } catch (error) { next(error) }
  })
  router.post('/:workspaceId/documents/:documentId/reparse', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    try {
      const documentId = String(request.params.documentId)
      const document = await repository.get(request.workspace!, documentId)
      if (!document) return response.status(404).json({ error: 'DOCUMENT_NOT_FOUND' })
      if (['queued', 'processing'].includes(String(document.ingest_status)) || ['queued', 'processing'].includes(String(document.status))) throw new ApiError(409, 'DOCUMENT_INGEST_IN_PROGRESS', 'Document ingestion is already in progress')
      if (!await repository.retryIngest(documentId, config?.REDIS_STREAM_DOCUMENT_INGEST ?? 'ownagent:document-ingest', 0, { mode: 'reparse' })) throw new ApiError(409, 'DOCUMENT_INGEST_IN_PROGRESS', 'Document ingestion is already in progress')
      response.status(202).json({ documentId, status: 'queued' })
    } catch (error) { next(error) }
  })
  router.post('/:workspaceId/documents/:documentId/replace/init', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    try {
      if (!multipart || !config) throw new Error('S3_UPLOAD_NOT_CONFIGURED')
      const documentId = String(request.params.documentId)
      const document = await repository.get(request.workspace!, documentId)
      if (!document) return response.status(404).json({ error: 'DOCUMENT_NOT_FOUND' })
      if (['queued', 'processing'].includes(String(document.ingest_status)) || ['queued', 'processing'].includes(String(document.status))) throw new ApiError(409, 'DOCUMENT_INGEST_IN_PROGRESS', 'Document ingestion is already in progress')
      const input = z.object({ fileName: z.string().min(1).max(255), size: z.number().int().positive().max(config.DOCUMENT_MAX_FILE_SIZE_BYTES), mimeType: z.string().min(1), lastModified: z.number().optional(), fingerprint: z.string().min(8).max(512) }).parse(request.body)
      const allowed = new Set((config.DOCUMENT_UPLOAD_ALLOWED_MIME_TYPES ?? '').split(',').map(value => value.trim()).filter(Boolean))
      if (!allowed.has(input.mimeType)) throw new ApiError(400, 'UNSUPPORTED_FILE_TYPE', 'Unsupported file type')
      if (/[\\/\u0000]/.test(input.fileName)) throw new ApiError(400, 'INVALID_FILE_NAME', 'Invalid file name')
      const existing = await repository.findReplaceUpload(request.workspace!, documentId, input.fingerprint)
      if (existing && Number(existing.file_size) === input.size && existing.mime_type === input.mimeType) return response.json({ uploadId: existing.id, storageBucket: existing.storage_bucket, storageKey: existing.storage_key, offset: existing.uploaded_bytes, size: input.size, totalParts: existing.total_parts, expiresAt: existing.expires_at, documentId })
      if (await repository.countActiveUploads(request.workspace!) >= (config.DOCUMENT_UPLOAD_MAX_ACTIVE_PER_USER ?? 3)) throw new ApiError(429, 'UPLOAD_LIMIT_REACHED', 'Too many active uploads')
      const uploadId = randomUUID()
      const bucket = 'knowledge-documents'
      const key = `${request.workspace!.workspaceId}/${uploadId}/${input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      const providerUploadId = await multipart.initiate(bucket, key, input.mimeType)
      const expiresAt = new Date(Date.now() + (config.DOCUMENT_UPLOAD_EXPIRES_MS ?? 86_400_000)).toISOString()
      const row = await repository.createResumableUpload(request.workspace!, { id: uploadId, target_document_id: documentId, upload_mode: 'replace', storage_bucket: bucket, storage_key: key, original_filename: input.fileName, mime_type: input.mimeType, file_size: input.size, fingerprint: input.fingerprint, upload_protocol: 's3-multipart', provider_upload_id: providerUploadId, status: 'initiated', uploaded_bytes: 0, total_parts: Math.ceil(input.size / (config.DOCUMENT_UPLOAD_CHUNK_SIZE_BYTES ?? 16_777_216)), expires_at: expiresAt })
      response.status(201).json({ uploadId: row.id, storageBucket: bucket, storageKey: key, offset: 0, size: input.size, totalParts: row.total_parts, expiresAt, documentId })
    } catch (error) { next(error) }
  })
  router.post('/:workspaceId/documents/:documentId/replace/:uploadId/complete', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    let claimed = false
    let uploadId = ''
    try {
      if (!multipart || !config) throw new Error('S3_UPLOAD_NOT_CONFIGURED')
      const documentId = String(request.params.documentId)
      uploadId = String(request.params.uploadId)
      const document = await repository.get(request.workspace!, documentId)
      const upload = await repository.getResumableUpload(request.workspace!, uploadId)
      if (!document) return response.status(404).json({ error: 'DOCUMENT_NOT_FOUND' })
      if (!upload || upload.upload_mode !== 'replace' || upload.target_document_id !== documentId) return response.status(404).json({ error: 'UPLOAD_NOT_FOUND' })
      if (upload.status === 'completed') return response.json({ documentId, status: upload.last_error === 'UNCHANGED' ? 'unchanged' : 'queued', contentHash: upload.content_hash })
      if (upload.status === 'failed' && upload.last_error === 'DUPLICATE_DOCUMENT_CONTENT' && upload.content_hash) {
        const duplicate = await repository.findDocumentByContentHash(request.workspace!, String(upload.content_hash), documentId)
        if (duplicate) return response.status(409).json({ code: 'DUPLICATE_DOCUMENT_CONTENT', existingDocumentId: duplicate.id, existingDocumentTitle: duplicate.title, contentHash: upload.content_hash })
      }
      const parts = z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) })).min(1) }).parse(request.body).parts
      claimed = await repository.claimUploadCompletion(request.workspace!, uploadId)
      if (!claimed) throw new ApiError(409, 'UPLOAD_COMPLETION_IN_PROGRESS', 'Upload completion is already in progress')
      await multipart.complete(upload.storage_bucket, upload.storage_key, upload.provider_upload_id, parts)
      const head = await multipart.head(upload.storage_bucket, upload.storage_key)
      if (Number(head.ContentLength) !== Number(upload.file_size)) throw new ApiError(400, 'UPLOAD_SIZE_MISMATCH', 'Uploaded file size does not match')
      const stored = await storageDb.storage.from(upload.storage_bucket).download(upload.storage_key)
      if (stored.error || !stored.data) throw new ApiError(502, 'UPLOAD_HASH_FAILED', 'Could not validate uploaded file')
      const hash = createHash('sha256').update(Buffer.from(await stored.data.arrayBuffer())).digest('hex')
      const active = await repository.activeVersionHash(documentId)
      if (hash === (active?.content_hash ?? document.content_hash)) {
        if (!await repository.completeUnchangedReplaceUpload(request.workspace!, documentId, uploadId, hash)) throw new ApiError(409, 'DOCUMENT_INGEST_IN_PROGRESS', 'Document ingestion is already in progress')
        return response.json({ documentId, status: 'unchanged', contentHash: hash })
      }
      const duplicate = await repository.findDocumentByContentHash(request.workspace!, hash, documentId)
      if (duplicate) {
        await repository.updateResumableUpload(uploadId, { status: 'failed', content_hash: hash, last_error: 'DUPLICATE_DOCUMENT_CONTENT' })
        return response.status(409).json({ code: 'DUPLICATE_DOCUMENT_CONTENT', existingDocumentId: duplicate.id, existingDocumentTitle: duplicate.title, contentHash: hash })
      }
      await repository.updateResumableUpload(uploadId, { content_hash: hash, uploaded_bytes: Number(head.ContentLength) })
      const queued = await repository.completeReplaceUpload(request.workspace!, documentId, uploadId, config.REDIS_STREAM_DOCUMENT_INGEST)
      if (!queued) throw new ApiError(409, 'DOCUMENT_INGEST_IN_PROGRESS', 'Document ingestion is already in progress')
      response.status(202).json({ documentId, status: 'queued', contentHash: hash })
    } catch (error) {
      if (claimed && uploadId) await repository.updateResumableUpload(uploadId, { status: 'failed', last_error: error instanceof Error ? error.message.slice(0, 500) : 'UPLOAD_COMPLETION_FAILED' }).catch(() => undefined)
      next(error)
    }
  })
  router.post('/:workspaceId/documents/:documentId/versions/:versionId/activate', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    try {
      const detail = await repository.activateVersion(request.workspace!, String(request.params.documentId), String(request.params.versionId))
      if (!detail) return response.status(404).json({ error: 'DOCUMENT_VERSION_NOT_FOUND' })
      response.json({ document: detail })
    } catch (error) {
      if (error instanceof Error && /not ready/i.test(error.message)) return next(new ApiError(409, 'DOCUMENT_VERSION_NOT_READY', 'Document version is not ready'))
      next(error)
    }
  })
  router.post('/:workspaceId/documents/:documentId/versions/:versionId/retry', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    try {
      const documentId = String(request.params.documentId)
      const versionId = String(request.params.versionId)
      const source = await repository.getVersionSource(request.workspace!, documentId, versionId)
      if (!source) return response.status(404).json({ error: 'DOCUMENT_VERSION_NOT_FOUND' })
      if (source.status !== 'failed') throw new ApiError(409, 'DOCUMENT_VERSION_NOT_FAILED', 'Only failed versions can be retried')
      const document = await repository.get(request.workspace!, documentId)
      if (!document) return response.status(404).json({ error: 'DOCUMENT_NOT_FOUND' })
      if (['queued', 'processing'].includes(String(document.ingest_status)) || ['queued', 'processing'].includes(String(document.status))) throw new ApiError(409, 'DOCUMENT_INGEST_IN_PROGRESS', 'Document ingestion is already in progress')
      if (!await repository.retryIngest(documentId, config?.REDIS_STREAM_DOCUMENT_INGEST ?? 'ownagent:document-ingest', 0, { mode: 'retry', retryOfVersionId: versionId })) throw new ApiError(409, 'DOCUMENT_INGEST_IN_PROGRESS', 'Document ingestion is already in progress')
      response.status(202).json({ documentId, versionId, status: 'queued' })
    } catch (error) { next(error) }
  })
  router.post('/:workspaceId/uploads/init', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    try {
      if (!multipart || !config) throw new Error('S3_UPLOAD_NOT_CONFIGURED')
      const input = z.object({ fileName: z.string().min(1).max(255), size: z.number().int().positive().max(config.DOCUMENT_MAX_FILE_SIZE_BYTES), mimeType: z.string().min(1), lastModified: z.number().optional(), fingerprint: z.string().min(8).max(512) }).parse(request.body)
      const allowed = new Set((config.DOCUMENT_UPLOAD_ALLOWED_MIME_TYPES ?? 'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain').split(',').map(value => value.trim()).filter(Boolean))
      if (!allowed.has(input.mimeType)) throw new Error('UNSUPPORTED_FILE_TYPE')
      if (/[\\/\u0000]/.test(input.fileName)) throw new Error('INVALID_FILE_NAME')
      const existing = await repository.findActiveUpload(request.workspace!, input.fingerprint)
      if (existing && Number(existing.file_size) === input.size && existing.mime_type === input.mimeType) return response.status(200).json({ uploadId: existing.id, storageBucket: existing.storage_bucket, storageKey: existing.storage_key, offset: existing.uploaded_bytes, size: input.size, totalParts: existing.total_parts, expiresAt: existing.expires_at })
      if (await repository.countActiveUploads(request.workspace!) >= (config.DOCUMENT_UPLOAD_MAX_ACTIVE_PER_USER ?? 3)) throw new Error('UPLOAD_LIMIT_REACHED')
      const uploadId = randomUUID()
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
      const bucket = 'knowledge-documents'
      const key = `${request.workspace!.workspaceId}/${uploadId}/${safeName}`
      const providerUploadId = await multipart.initiate(bucket, key, input.mimeType)
      const expiresAt = new Date(Date.now() + (config.DOCUMENT_UPLOAD_EXPIRES_MS ?? 86_400_000)).toISOString()
      const row = await repository.createResumableUpload(request.workspace!, { id: uploadId, storage_bucket: bucket, storage_key: key, original_filename: input.fileName, mime_type: input.mimeType, file_size: input.size, fingerprint: input.fingerprint, upload_protocol: 's3-multipart', provider_upload_id: providerUploadId, status: 'initiated', uploaded_bytes: 0, total_parts: Math.ceil(input.size / (config.DOCUMENT_UPLOAD_CHUNK_SIZE_BYTES ?? 16_777_216)), expires_at: expiresAt })
      response.status(201).json({ uploadId: row.id, storageBucket: bucket, storageKey: key, offset: 0, size: input.size, totalParts: row.total_parts, expiresAt })
    } catch (error) { next(error) }
  })
  router.get('/:workspaceId/uploads/:uploadId', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    try {
      if (!multipart) throw new Error('S3_UPLOAD_NOT_CONFIGURED')
      const upload = await repository.getResumableUpload(request.workspace!, String(request.params.uploadId))
      if (!upload) return response.status(404).json({ error: 'UPLOAD_NOT_FOUND' })
      let uploadedBytes = Number(upload.uploaded_bytes)
      if (upload.status === 'initiated') {
        await repository.updateResumableUpload(String(upload.id), { status: 'uploading' })
      }
      response.json({ uploadId: upload.id, status: upload.status, uploadedBytes, totalBytes: Number(upload.file_size), progress: Math.min(100, Math.round(uploadedBytes / Number(upload.file_size) * 100)), documentId: upload.document_id, lastError: upload.last_error })
    } catch (error) { next(error) }
  })
  router.get('/:workspaceId/uploads/:uploadId/parts/:partNumber', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    try {
      if (!multipart) throw new Error('S3_UPLOAD_NOT_CONFIGURED')
      const upload = await repository.getResumableUpload(request.workspace!, String(request.params.uploadId))
      if (!upload || !['initiated', 'uploading'].includes(upload.status)) return response.status(404).json({ error: 'UPLOAD_NOT_FOUND' })
      const partNumber = Number(request.params.partNumber)
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > Number(upload.total_parts)) return response.status(400).json({ error: 'INVALID_PART_NUMBER' })
      response.json({ url: await multipart.signPart(upload.storage_bucket, upload.storage_key, upload.provider_upload_id, partNumber), partNumber, expiresIn: 900 })
    } catch (error) { next(error) }
  })
  router.post('/:workspaceId/uploads/:uploadId/complete', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    let claimed = false
    let uploadId = ''
    try {
      if (!multipart || !config) throw new Error('S3_UPLOAD_NOT_CONFIGURED')
      uploadId = String(request.params.uploadId)
      const upload = await repository.getResumableUpload(request.workspace!, uploadId)
      if (!upload) return response.status(404).json({ error: 'UPLOAD_NOT_FOUND' })
      if (upload.upload_mode !== 'create' || upload.target_document_id) return response.status(404).json({ error: 'UPLOAD_NOT_FOUND' })
      if (upload.status === 'completed' && upload.document_id) return response.json({ uploadId: upload.id, documentId: upload.document_id, status: 'queued' })
      if (!['initiated', 'uploading'].includes(upload.status)) throw new ApiError(409, 'UPLOAD_COMPLETION_IN_PROGRESS', 'Upload completion is already in progress')
      const parts = z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) })).min(1) }).parse(request.body).parts
      claimed = await repository.claimUploadCompletion(request.workspace!, uploadId)
      if (!claimed) throw new ApiError(409, 'UPLOAD_COMPLETION_IN_PROGRESS', 'Upload completion is already in progress')
      await multipart.complete(upload.storage_bucket, upload.storage_key, upload.provider_upload_id, parts)
      const head = await multipart.head(upload.storage_bucket, upload.storage_key)
      if (Number(head.ContentLength) !== Number(upload.file_size)) throw new Error('UPLOAD_SIZE_MISMATCH')
      const document = await repository.createDocumentFromUpload(request.workspace!, { ...upload, status: 'completing', file_size: Number(head.ContentLength) }, config.REDIS_STREAM_DOCUMENT_INGEST)
      response.status(202).json({ uploadId: upload.id, documentId: document.id, status: document.status })
    } catch (error) {
      if (claimed && uploadId) await repository.updateResumableUpload(uploadId, { status: 'failed', last_error: error instanceof Error ? error.message.slice(0, 500) : 'UPLOAD_COMPLETION_FAILED' }).catch(() => undefined)
      next(error)
    }
  })
  router.delete('/:workspaceId/uploads/:uploadId', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    try {
      if (!multipart) throw new Error('S3_UPLOAD_NOT_CONFIGURED')
      const upload = await repository.getResumableUpload(request.workspace!, String(request.params.uploadId))
      if (!upload) return response.status(404).json({ error: 'UPLOAD_NOT_FOUND' })
      if (upload.status === 'completed') return response.status(409).json({ error: 'UPLOAD_COMPLETED' })
      if (!['aborted', 'expired'].includes(upload.status)) await multipart.abort(upload.storage_bucket, upload.storage_key, upload.provider_upload_id)
      await repository.updateResumableUpload(String(upload.id), { status: 'aborted' })
      response.status(204).end()
    } catch (error) { next(error) }
  })
  router.get('/:workspaceId/documents/:documentId/download', access, async (request, response, next) => {
    try {
      const document = await repository.get(request.workspace!, String(request.params.documentId))
      if (!document || document.status !== 'ready' || !document.storage_bucket || !document.storage_key) return response.status(404).json({ error: 'DOCUMENT_NOT_READY' })
      const signed = await storageDb.storage.from(document.storage_bucket).createSignedUrl(document.storage_key, config?.DOCUMENT_DOWNLOAD_URL_EXPIRES_SECONDS ?? 600)
      if (signed.error || !signed.data?.signedUrl) throw new Error(`DOWNLOAD_URL_FAILED:${signed.error?.message ?? 'unknown'}`)
      response.json({ url: signed.data.signedUrl, fileName: document.original_filename ?? document.title, size: document.file_size, etag: document.content_hash, expiresIn: config?.DOCUMENT_DOWNLOAD_URL_EXPIRES_SECONDS ?? 600 })
    } catch (error) { next(error) }
  })
  router.delete('/:workspaceId/documents/:documentId', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), async (request, response, next) => {
    try {
      const documentId = String(request.params.documentId)
      const document = await repository.get(request.workspace!, documentId)
      if (!document) return response.status(404).json({ error: 'DOCUMENT_NOT_FOUND' })
      if (document.storage_bucket && document.storage_key) {
        const removed = await storageDb.storage.from(document.storage_bucket).remove([document.storage_key])
        if (removed.error) throw new Error(`DOCUMENT_STORAGE_DELETE_FAILED:${removed.error.message}`)
      }
      const deleted = await repository.delete(request.workspace!, documentId)
      if (!deleted) return response.status(404).json({ error: 'DOCUMENT_NOT_FOUND' })
      response.status(204).end()
    } catch (error) { next(error) }
  })
  router.post('/:workspaceId/documents/upload', requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config), upload.single('file'), async (request, response, next) => {
    try {
      const file = request.file
      if (!file) throw new Error('file is required')
      const allowed = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/markdown', 'text/plain'])
      if (!allowed.has(file.mimetype)) throw new Error('unsupported file type')
      const title = String(request.body.title ?? file.originalname).slice(0, 300)
      const visibility = request.body.visibility === 'private' ? 'private' : 'workspace'
      const hash = createHash('sha256').update(file.buffer).digest('hex')
      const bucket = 'knowledge-documents'
      const key = `${request.workspace!.workspaceId}/${hash}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      const storage = storageDb.storage.from(bucket)
      const stored = await storage.upload(key, file.buffer, { contentType: file.mimetype, upsert: false })
      if (stored.error && !/already exists/i.test(stored.error.message)) throw new Error(`file storage failed: ${stored.error.message}`)
      const document = await repository.createUpload(request.workspace!, { title, visibility, storageBucket: bucket, storageKey: key, originalFilename: file.originalname, mimeType: file.mimetype, fileSize: file.size, contentHash: hash, ingestStream: config?.REDIS_STREAM_DOCUMENT_INGEST ?? 'ownagent:document-ingest' })
      response.status(202).json({ document })
    } catch (error) { next(error) }
  })
  router.post(
    '/:workspaceId/documents',
    requireWorkspaceAccess(auth, workspaceRepository, ['owner', 'admin', 'editor'], config),
    async (request, response, next) => {
      try {
        const input = z
          .object({
            title: z.string().min(1).max(300),
            content: z.string().min(1).max(2_000_000),
            visibility: z.enum(['workspace', 'private']).default('workspace'),
            metadata: z.record(z.string(), z.unknown()).optional(),
          })
          .safeParse(request.body)
        if (!input.success) throw new Error('title and content are required')
        response
          .status(201)
          .json({ document: await service.create(request.workspace!, input.data) })
      } catch (error) {
        next(error)
      }
    }
  )
  router.post('/:workspaceId/search', access, async (request, response, next) => {
    try {
      const input = z
        .object({
          query: z.string().min(1).max(1000),
          limit: z.number().int().min(1).max(50).default(10),
        })
        .safeParse(request.body)
      if (!input.success) throw new Error('query is required')
      response.json({
        results: await service.search(request.workspace!, input.data.query, input.data.limit),
      })
    } catch (error) {
      next(error)
    }
  })
  return router
}
