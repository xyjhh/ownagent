import cors from 'cors'
import express, { type Express } from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import pino from 'pino'
import { randomUUID } from 'node:crypto'
import type { AppConfig } from './config/env.js'
import { splitOrigins } from './config/env.js'
import { HealthService } from './health.js'
import { errorHandler } from './http/error-handler.js'
import { AuthService } from './modules/auth/service.js'
import { createAuthRouter } from './modules/auth/routes.js'
import { createWorkspaceRouter } from './modules/workspaces/routes.js'
import type { WorkspaceRepository } from './modules/workspaces/repository.js'
import { WorkspaceService } from './modules/workspaces/service.js'
import { createInviteRouter } from './modules/workspaces/invite-routes.js'
import { createDocumentRouter } from './modules/documents/routes.js'
import type { EmbeddingClient } from './integrations/embedding.js'
import type { RerankerClient } from './integrations/reranker.js'
import { createRunRouter } from './modules/runs/routes.js'
import type { RunService } from './modules/runs/service.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { RedisStreams } from './queue/redis-streams.js'

export type AppDependencies = {
  config: AppConfig
  auth: AuthService
  health: HealthService
  workspaceRepository: WorkspaceRepository
  runService: RunService
  schemaDb: SupabaseClient
  embedding: EmbeddingClient
  reranker: RerankerClient
  queue?: RedisStreams
}

export function createApp(deps: AppDependencies): Express {
  const app = express()
  const origins = splitOrigins(deps.config.WEB_ORIGIN)
  const logger = pino({ redact: ['req.headers.authorization', 'req.headers.cookie'] })
  app.locals.logger = logger

  app.disable('x-powered-by')
  app.use(helmet())
  app.use(cors({ origin: origins, credentials: true }))
  app.use((request, response, next) => {
    request.requestId = request.headers['x-request-id']?.toString() ?? randomUUID()
    response.setHeader('x-request-id', request.requestId)
    const startedAt = Date.now()
    response.on('finish', () => logger.info({ requestId: request.requestId, method: request.method, path: request.path, status: response.statusCode, durationMs: Date.now() - startedAt }, 'request completed'))
    next()
  })
  app.use(express.json({ limit: '100kb' }))

  app.get('/health/live', (_request, response) => response.json({ status: 'ok' }))
  app.get('/health/ready', async (_request, response, next) => {
    try {
      const result = await deps.health.ready()
      response.status(result.status === 'ok' ? 200 : 503).json(result)
    } catch (error) {
      next(error)
    }
  })

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false })
  app.use('/api/auth/login', authLimiter)
  app.use('/api/auth/refresh', authLimiter)
  app.use('/api/auth', createAuthRouter(deps.auth, deps.config))
  app.use('/api/workspaces', createWorkspaceRouter(deps.auth, deps.workspaceRepository, deps.config))
  app.use('/api/invites', createInviteRouter(deps.auth, new WorkspaceService(deps.workspaceRepository), deps.config))
  app.use('/api/workspaces', createDocumentRouter(deps.auth, deps.workspaceRepository, deps.schemaDb, deps.embedding, deps.reranker, deps.config))
  app.use('/api/workspaces', createRunRouter(deps.auth, deps.workspaceRepository, deps.runService, deps.config))
  app.use(errorHandler)
  return app
}
