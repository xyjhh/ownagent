import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { loadConfig } from './config/env.js'
import { createSupabaseAdmin, createSupabaseSchemaClient } from './infrastructure/supabase.js'
import { RedisStreams, type StreamMessage } from './queue/redis-streams.js'
import { EmbeddingClient } from './integrations/embedding.js'
import { DocumentRepository } from './modules/documents/repository.js'
import { chunkSections } from './modules/documents/chunk.js'
import { parserFor } from './modules/documents/parsers/index.js'
import { LangfuseTracer } from './observability/langfuse.js'

const config = loadConfig()
const tracer = new LangfuseTracer(config)
const db = createSupabaseAdmin(config)
const schemaDb = createSupabaseSchemaClient(db, config.SUPABASE_DB_SCHEMA)
const queue = new RedisStreams(config)
const repository = new DocumentRepository(schemaDb)
const embedding = new EmbeddingClient(config, tracer)
const consumer = `${globalThis.process.env.HOSTNAME ?? 'ingest'}-${randomUUID()}`
const active = new Set<Promise<void>>()
let stopping = false

async function withLease(message: StreamMessage, fn: () => Promise<void>) {
  const timer = setInterval(
    () => {
      void queue
        .touch(
          config.REDIS_STREAM_DOCUMENT_INGEST,
          config.REDIS_CONSUMER_GROUP,
          consumer,
          message.id
        )
        .catch(() => undefined)
    },
    Math.max(10_000, Math.floor(config.REDIS_RECLAIM_IDLE_MS / 3))
  )
  try {
    await fn()
  } finally {
    clearInterval(timer)
  }
}

async function processDocument(message: StreamMessage) {
  const payload = JSON.parse(message.values.payload ?? '{}') as {
    documentId?: string
    uploadId?: string
    mode?: 'create' | 'replace' | 'reparse' | 'retry'
    retryOfVersionId?: string
  }
  if (!payload.documentId) return
  const document = await repository.claimIngest(payload.documentId)
  if (!document) return
  const attempt = Number(document.ingest_attempt ?? 1)
  const trace = tracer.startTrace({
    id: `document-ingest-${payload.documentId}-${attempt}`,
    name: 'document-ingest',
    workspaceId: String(document.workspace_id),
    metadata: { documentId: payload.documentId, attempt, taskType: 'document_ingest' },
  })
  const ingestSpan = trace?.span('document.ingest', {
    documentId: payload.documentId,
    attempt: document.ingest_attempt,
  })
  let versionId: string | undefined
  try {
    const upload = payload.uploadId ? await repository.getUploadForWorker(payload.uploadId) : null
    const retrySource = payload.retryOfVersionId
      ? await repository.getVersionSourceForWorker(payload.retryOfVersionId)
      : null
    let buffer: Buffer
    const sourceBucket =
      upload?.storage_bucket ?? retrySource?.source_storage_bucket ?? document.storage_bucket
    const sourceKey = upload?.storage_key ?? retrySource?.source_storage_key ?? document.storage_key
    const sourceFileName =
      upload?.original_filename ??
      retrySource?.source_filename ??
      document.original_filename ??
      `${document.title ?? 'document'}.txt`
    const sourceMimeType =
      upload?.mime_type ?? retrySource?.source_mime_type ?? document.mime_type ?? 'text/plain'
    if (sourceBucket && sourceKey) {
      const storage = db.storage.from(String(sourceBucket))
      const downloadSpan = trace?.span('document.download', {
        documentId: payload.documentId,
        fileSize: document.file_size,
      })
      const downloaded = await storage.download(String(sourceKey))
      if (downloaded.error || !downloaded.data) throw new Error('FILE_DOWNLOAD_FAILED')
      buffer = Buffer.from(await downloaded.data.arrayBuffer())
      downloadSpan?.end({ bytes: buffer.length })
    } else {
      buffer = Buffer.from(String(document.content ?? ''), 'utf8')
    }
    const contentHash = createHash('sha256').update(buffer).digest('hex')
    const mimeType = String(sourceMimeType)
    const fileName = String(sourceFileName)
    const activeVersion = await repository.activeVersionHash(payload.documentId)
    if (activeVersion?.content_hash && activeVersion.content_hash === contentHash) {
      await repository.setIngestIdle(payload.documentId)
      return
    }
    if (payload.mode === 'replace') {
      const duplicate = await repository.findDocumentByContentHash(
        {
          workspaceId: String(document.workspace_id),
          userId: String(document.owner_id ?? ''),
          role: 'owner',
        },
        contentHash,
        payload.documentId
      )
      if (duplicate) throw new Error(`DUPLICATE_DOCUMENT_CONTENT:${duplicate.id}`)
    }
    versionId = await repository.createBuildingVersion(
      payload.documentId,
      { parser: 'v1', chunking: 'structure-v1', embedding: config.EMBEDDING_MODEL },
      {
        contentHash,
        fileName,
        fileSize: buffer.length,
        mimeType,
        storageBucket: sourceBucket ? String(sourceBucket) : undefined,
        storageKey: sourceKey ? String(sourceKey) : undefined,
        retryOfVersionId: payload.retryOfVersionId,
      }
    )
    const parseSpan = trace?.span('document.parse', { mimeType, fileName })
    const parsed = await parserFor(mimeType, fileName).parse(buffer, {
      filename: fileName,
      mimeType,
    })
    parseSpan?.end({ textLength: parsed.text.length, sectionCount: parsed.sections.length })
    const chunkSpan = trace?.span('document.chunk', {})
    const chunks = chunkSections(parsed.sections)
    chunkSpan?.end({ chunkCount: chunks.length })
    const embeddings = await embedding.embed(
      chunks.map(chunk => chunk.content),
      trace?.context,
      'document.embedding'
    )
    const persistSpan = trace?.span('document.persist', {
      chunkCount: chunks.length,
      embeddingCount: embeddings.data.length,
    })
    await repository.persistVersionChunks(
      payload.documentId,
      versionId,
      parsed.text,
      chunks.map((chunk, index) => ({ ...chunk, embedding: embeddings.data[index]?.embedding }))
    )
    persistSpan?.end({ versionId })
    const readySpan = trace?.span('document.mark_ready', { documentId: payload.documentId })
    await repository.markReady(payload.documentId, versionId)
    readySpan?.end({ versionId })
    ingestSpan?.end({ status: 'ready', versionId, chunkCount: chunks.length })
    trace?.update({
      status: 'completed',
      documentId: payload.documentId,
      versionId,
      chunkCount: chunks.length,
    })
  } catch (error) {
    ingestSpan?.fail(error)
    const messageText = error instanceof Error ? error.message : 'INGEST_FAILED'
    const errorCode = messageText.startsWith('FILE_')
      ? messageText.split(':', 1)[0]
      : messageText.startsWith('DUPLICATE_DOCUMENT_CONTENT')
        ? 'DUPLICATE_DOCUMENT_CONTENT'
        : 'PARSER_FAILED'
    if (versionId)
      await repository.markVersionFailed(versionId, errorCode, messageText).catch(() => undefined)
    const retryable = errorCode !== 'DUPLICATE_DOCUMENT_CONTENT'
    if (retryable && attempt < config.INGEST_MAX_ATTEMPTS) {
      trace?.update({
        status: 'retrying',
        documentId: payload.documentId,
        attempt,
        error: messageText,
      })
      await repository.retryIngest(
        payload.documentId,
        config.REDIS_STREAM_DOCUMENT_INGEST,
        Math.min(60_000, 2 ** Math.max(0, attempt - 1) * 1000),
        {
          uploadId: payload.uploadId,
          mode: payload.mode ?? 'reparse',
          retryOfVersionId: payload.retryOfVersionId,
        },
        true
      )
      return
    } else {
      trace?.update({
        status: 'failed',
        documentId: payload.documentId,
        attempt,
        error: messageText,
        deadLetter: true,
      })
      const failedSpan = trace?.span('document.mark_failed', {
        documentId: payload.documentId,
        attempt,
      })
      await repository.markFailed(payload.documentId, errorCode, messageText)
      failedSpan?.end({ status: 'failed', errorCode })
      await queue.publishToStream(config.REDIS_STREAM_DOCUMENT_DEAD_LETTER, {
        documentId: payload.documentId,
        messageId: message.id,
        error: messageText,
        attempt,
      })
      return
    }
  } finally {
    await tracer.flushAsync()
  }
}

function launch(message: StreamMessage) {
  const task = withLease(message, () => processDocument(message))
    .then(() =>
      queue.ackAndDelete(
        config.REDIS_STREAM_DOCUMENT_INGEST,
        config.REDIS_CONSUMER_GROUP,
        message.id
      )
    )
    .catch(() => undefined)
    .finally(() => active.delete(task))
  active.add(task)
}

async function loop() {
  while (!stopping) {
    while (!stopping && active.size < config.INGEST_CONCURRENCY) {
      const slots = config.INGEST_CONCURRENCY - active.size
      const reclaimed = await queue.reclaim(
        config.REDIS_STREAM_DOCUMENT_INGEST,
        config.REDIS_CONSUMER_GROUP,
        consumer,
        config.REDIS_RECLAIM_IDLE_MS,
        slots
      )
      if (reclaimed.length) {
        reclaimed.forEach(launch)
        continue
      }
      const messages = await queue.read(
        config.REDIS_STREAM_DOCUMENT_INGEST,
        config.REDIS_CONSUMER_GROUP,
        consumer,
        slots,
        1000
      )
      if (!messages.length) break
      messages.forEach(launch)
    }
    if (active.size) await Promise.race(active)
  }
  await Promise.allSettled(active)
}

function shutdown() {
  stopping = true
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
await queue.ensureGroup(config.REDIS_STREAM_DOCUMENT_INGEST)
console.log(
  `ownagent document worker ${consumer} listening on ${config.REDIS_STREAM_DOCUMENT_INGEST}`
)
await loop()
await tracer.shutdownAsync()
await queue.close()
