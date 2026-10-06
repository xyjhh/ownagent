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

export function createDocumentRouter(
  auth: AuthService,
  workspaceRepository: WorkspaceRepository,
  db: any,
  embedding: EmbeddingClient,
  reranker: RerankerClient,
  config?: AppConfig
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
      const document = await repository.get(request.workspace!, String(request.params.documentId))
      if (!document) return response.status(404).json({ error: 'DOCUMENT_NOT_FOUND' })
      response.json({ document })
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
      if (['initiated', 'uploading', 'completing'].includes(upload.status)) {
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
    try {
      if (!multipart || !config) throw new Error('S3_UPLOAD_NOT_CONFIGURED')
      const upload = await repository.getResumableUpload(request.workspace!, String(request.params.uploadId))
      if (!upload) return response.status(404).json({ error: 'UPLOAD_NOT_FOUND' })
      if (upload.status === 'completed' && upload.document_id) return response.json({ uploadId: upload.id, documentId: upload.document_id, status: 'queued' })
      if (!['initiated', 'uploading', 'completing'].includes(upload.status)) throw new Error(`UPLOAD_${String(upload.status).toUpperCase()}`)
      await repository.updateResumableUpload(String(upload.id), { status: 'completing' })
      const parts = z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) })).min(1) }).parse(request.body).parts
      await multipart.complete(upload.storage_bucket, upload.storage_key, upload.provider_upload_id, parts)
      const head = await multipart.head(upload.storage_bucket, upload.storage_key)
      if (Number(head.ContentLength) !== Number(upload.file_size)) throw new Error('UPLOAD_SIZE_MISMATCH')
      const document = await repository.createDocumentFromUpload(request.workspace!, { ...upload, file_size: Number(head.ContentLength) }, config.REDIS_STREAM_DOCUMENT_INGEST)
      await repository.updateResumableUpload(String(upload.id), { status: 'completed', document_id: document.id, completed_at: new Date().toISOString(), uploaded_bytes: Number(head.ContentLength) })
      response.status(202).json({ uploadId: upload.id, documentId: document.id, status: document.status })
    } catch (error) { next(error) }
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
      const signed = await db.storage.from(document.storage_bucket).createSignedUrl(document.storage_key, config?.DOCUMENT_DOWNLOAD_URL_EXPIRES_SECONDS ?? 600)
      if (signed.error || !signed.data?.signedUrl) throw new Error(`DOWNLOAD_URL_FAILED:${signed.error?.message ?? 'unknown'}`)
      response.json({ url: signed.data.signedUrl, fileName: document.original_filename ?? document.title, size: document.file_size, etag: document.content_hash, expiresIn: config?.DOCUMENT_DOWNLOAD_URL_EXPIRES_SECONDS ?? 600 })
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
      const storage = db.storage.from(bucket)
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
