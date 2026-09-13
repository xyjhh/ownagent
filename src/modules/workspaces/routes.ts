import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { requireWorkspaceAccess } from './middleware.js'
import type { WorkspaceRepository } from './repository.js'
import { WorkspaceService } from './service.js'
import { workspaceRoles } from './types.js'
import { createInviteRouter } from './invite-routes.js'
import type { AppConfig } from '../../config/env.js'

export function createWorkspaceRouter(
  auth: AuthService,
  repository: WorkspaceRepository,
  config?: AppConfig
): Router {
  const router = Router()
  const service = new WorkspaceService(repository)
  router.use('/invites', createInviteRouter(auth, service, config))
  router.get('/', requireAuth(auth, config), async (request, response, next) => {
    try {
      response.json({ workspaces: await service.list(request.auth!.userId) })
    } catch (error) {
      next(error)
    }
  })
  router.post('/', requireAuth(auth, config), async (request, response, next) => {
    try {
      const input = z
        .object({
          name: z.string().min(1).max(120),
          slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
        })
        .safeParse(request.body)
      if (!input.success) throw new Error('name and slug are required')
      response
        .status(201)
        .json({
          workspace: await service.create(request.auth!.userId, input.data.name, input.data.slug),
        })
    } catch (error) {
      next(error)
    }
  })
  router.post(
    '/:workspaceId/invites',
    requireWorkspaceAccess(auth, repository, ['owner', 'admin'], config),
    async (request, response, next) => {
      try {
        const input = z
          .object({ email: z.string().email(), role: z.enum(workspaceRoles).default('viewer') })
          .safeParse(request.body)
        if (!input.success) throw new Error('email and role are required')
        response
          .status(201)
          .json(await service.invite(request.workspace!, input.data.email, input.data.role))
      } catch (error) {
        next(error)
      }
    }
  )
  return router
}
