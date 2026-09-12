import 'dotenv/config'
import { loadConfig } from './config/env.js'
import { createSupabaseAdmin, createSupabaseSchemaClient } from './infrastructure/supabase.js'
import { HealthService } from './health.js'
import { createApp } from './app.js'
import { AuthService } from './modules/auth/service.js'
import { SupabaseAuthRepository } from './modules/auth/repository.js'
import { WorkspaceRepository } from './modules/workspaces/repository.js'
import { EmbeddingClient } from './integrations/embedding.js'
import { RerankerClient } from './integrations/reranker.js'
import { RedisStreams } from './queue/redis-streams.js'
import { OutboxDispatcher } from './queue/outbox.js'
import { RunRepository } from './modules/runs/repository.js'
import { RunService } from './modules/runs/service.js'
import { LangfuseTracer } from './observability/langfuse.js'
import { createServer } from 'node:http'
import { RealtimeWebSocketServer } from './websocket.js'

const config = loadConfig()
const db = createSupabaseAdmin(config)
const schemaDb = createSupabaseSchemaClient(db, config.SUPABASE_DB_SCHEMA)
const repository = new SupabaseAuthRepository(schemaDb)
const auth = new AuthService(repository, config)
const workspaceRepository = new WorkspaceRepository(schemaDb)
const embedding = new EmbeddingClient(config)
const reranker = new RerankerClient(config)
const queue = new RedisStreams(config)
const runRepository = new RunRepository(schemaDb)
const runService = new RunService(runRepository, queue, {
  stream: config.REDIS_STREAM_AGENT,
  controlStream: config.REDIS_STREAM_CONTROLS,
  maxAttempts: config.WORKER_MAX_ATTEMPTS,
})
const outbox = new OutboxDispatcher(runRepository, queue, config.DATABASE_URL)
outbox.start()
const tracer = new LangfuseTracer(config)
const health = new HealthService(config, schemaDb, undefined, undefined, undefined, queue, tracer)
const app = createApp({
  config,
  auth,
  health,
  workspaceRepository,
  runService,
  schemaDb,
  embedding,
  reranker,
  queue,
})
const httpServer = createServer(app)
new RealtimeWebSocketServer(httpServer, config, auth, workspaceRepository, runService, queue)

httpServer.listen(config.API_PORT, () => {
  console.log(`ownagent API listening on http://127.0.0.1:${config.API_PORT}`)
})

const shutdown = async () => {
  await outbox.stop()
  httpServer.close()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
