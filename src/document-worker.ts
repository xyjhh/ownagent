import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config/env.js'
import { createSupabaseAdmin, createSupabaseSchemaClient } from './infrastructure/supabase.js'
import { RedisStreams, type StreamMessage } from './queue/redis-streams.js'
import { EmbeddingClient } from './integrations/embedding.js'
import { DocumentRepository } from './modules/documents/repository.js'
import { chunkSections } from './modules/documents/chunk.js'
import { parserFor } from './modules/documents/parsers/index.js'

const config = loadConfig()
const db = createSupabaseAdmin(config)
const schemaDb = createSupabaseSchemaClient(db, config.SUPABASE_DB_SCHEMA)
const queue = new RedisStreams(config)
const repository = new DocumentRepository(schemaDb)
const embedding = new EmbeddingClient(config)
const consumer = `${globalThis.process.env.HOSTNAME ?? 'ingest'}-${randomUUID()}`
const active = new Set<Promise<void>>()
let stopping = false

async function withLease(message: StreamMessage, fn: () => Promise<void>) {
  const timer = setInterval(() => { void queue.touch(config.REDIS_STREAM_DOCUMENT_INGEST, config.REDIS_CONSUMER_GROUP, consumer, message.id).catch(() => undefined) }, Math.max(10_000, Math.floor(config.REDIS_RECLAIM_IDLE_MS / 3)))
  try { await fn() } finally { clearInterval(timer) }
}

async function processDocument(message: StreamMessage) {
  const payload = JSON.parse(message.values.payload ?? '{}') as { documentId?: string }
  if (!payload.documentId) return
  const document = await repository.claimIngest(payload.documentId)
  if (!document) return
  try {
    const storage = db.storage.from(String(document.storage_bucket))
    const downloaded = await storage.download(String(document.storage_key))
    if (downloaded.error || !downloaded.data) throw new Error('FILE_DOWNLOAD_FAILED')
    const buffer = Buffer.from(await downloaded.data.arrayBuffer())
    const parsed = await parserFor(String(document.mime_type), String(document.original_filename)).parse(buffer, { filename: String(document.original_filename), mimeType: String(document.mime_type) })
    const chunks = chunkSections(parsed.sections)
    const embeddings = await embedding.embed(chunks.map(chunk => chunk.content))
    const versionId = await repository.createVersion(payload.documentId, parsed.text, chunks.map((chunk, index) => ({ ...chunk, embedding: embeddings.data[index]?.embedding })), { parser: 'v1', chunking: 'structure-v1', embedding: config.EMBEDDING_MODEL })
    await repository.markReady(payload.documentId, versionId)
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'INGEST_FAILED'
    const attempt = Number(document.ingest_attempt ?? 1)
    if (attempt < config.INGEST_MAX_ATTEMPTS) {
      await repository.retryIngest(payload.documentId, config.REDIS_STREAM_DOCUMENT_INGEST, Math.min(60_000, 2 ** Math.max(0, attempt - 1) * 1000))
      return
    } else {
      await repository.markFailed(payload.documentId, messageText.startsWith('FILE_') ? messageText : 'PARSER_FAILED', messageText)
      await queue.publishToStream(config.REDIS_STREAM_DOCUMENT_DEAD_LETTER, { documentId: payload.documentId, messageId: message.id, error: messageText, attempt })
      return
    }
  }
}

function launch(message: StreamMessage) {
  const task = withLease(message, () => processDocument(message)).then(() => queue.ackAndDelete(config.REDIS_STREAM_DOCUMENT_INGEST, config.REDIS_CONSUMER_GROUP, message.id)).catch(() => undefined).finally(() => active.delete(task))
  active.add(task)
}

async function loop() {
  while (!stopping) {
    while (!stopping && active.size < config.INGEST_CONCURRENCY) {
      const slots = config.INGEST_CONCURRENCY - active.size
      const reclaimed = await queue.reclaim(config.REDIS_STREAM_DOCUMENT_INGEST, config.REDIS_CONSUMER_GROUP, consumer, config.REDIS_RECLAIM_IDLE_MS, slots)
      if (reclaimed.length) { reclaimed.forEach(launch); continue }
      const messages = await queue.read(config.REDIS_STREAM_DOCUMENT_INGEST, config.REDIS_CONSUMER_GROUP, consumer, slots, 1000)
      if (!messages.length) break
      messages.forEach(launch)
    }
    if (active.size) await Promise.race(active)
  }
  await Promise.allSettled(active)
}

function shutdown() { stopping = true }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown)
await queue.ensureGroup(config.REDIS_STREAM_DOCUMENT_INGEST)
console.log(`ownagent document worker ${consumer} listening on ${config.REDIS_STREAM_DOCUMENT_INGEST}`)
await loop()
await queue.close()
