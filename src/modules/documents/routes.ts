import { Router } from 'express'
import { z } from 'zod'
import { requireWorkspaceAccess } from '../workspaces/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { WorkspaceRepository } from '../workspaces/repository.js'
import type { EmbeddingClient } from '../../integrations/embedding.js'
import type { RerankerClient } from '../../integrations/reranker.js'
import { DocumentRepository } from './repository.js'
import { DocumentService } from './service.js'
import type { AppConfig } from '../../config/env.js'

export function createDocumentRouter(
  auth: AuthService,
  workspaceRepository: WorkspaceRepository,
  db: any,
  embedding: EmbeddingClient,
  reranker: RerankerClient,
  config?: AppConfig
): Router {
  const router = Router()
  const service = new DocumentService(new DocumentRepository(db), embedding, reranker)
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
