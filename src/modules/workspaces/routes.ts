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
  router.get('/:workspaceId/members', requireWorkspaceAccess(auth, repository, ['owner', 'admin', 'editor', 'viewer'], config), async (request, response, next) => {
    try { response.json({ members: await repository.listMembers(request.workspace!.workspaceId) }) } catch (error) { next(error) }
  })
  router.patch('/:workspaceId/members/:userId', requireWorkspaceAccess(auth, repository, ['owner', 'admin'], config), async (request, response, next) => {
    try {
      const input = z.object({ role: z.enum(['admin', 'editor', 'viewer']) }).safeParse(request.body)
      if (!input.success) return response.status(400).json({ error: 'INVALID_ROLE' })
      if (String(request.params.userId) === request.workspace!.userId && request.workspace!.role !== 'owner') return response.status(403).json({ error: 'OWNER_REQUIRED' })
      const target = await repository.findMembership(String(request.params.userId), request.workspace!.workspaceId)
      if (!target) return response.status(404).json({ error: 'MEMBER_NOT_FOUND' })
      if (target.role === 'owner') return response.status(403).json({ error: 'OWNER_PROTECTED' })
      if (request.workspace!.role === 'admin' && input.data.role === 'admin') return response.status(403).json({ error: 'OWNER_REQUIRED' })
      const member = await repository.updateMemberRole(request.workspace!.workspaceId, String(request.params.userId), input.data.role)
      response.json({ member })
    } catch (error) { next(error) }
  })
  router.delete('/:workspaceId/members/:userId', requireWorkspaceAccess(auth, repository, ['owner', 'admin'], config), async (request, response, next) => {
    try {
      const target = await repository.findMembership(String(request.params.userId), request.workspace!.workspaceId)
      if (!target) return response.status(404).json({ error: 'MEMBER_NOT_FOUND' })
      if (target.role === 'owner' || String(request.params.userId) === request.workspace!.userId) return response.status(403).json({ error: 'OWNER_PROTECTED' })
      if (request.workspace!.role === 'admin' && target.role === 'admin') return response.status(403).json({ error: 'OWNER_REQUIRED' })
      await repository.removeMember(request.workspace!.workspaceId, String(request.params.userId))
      response.status(204).end()
    } catch (error) { next(error) }
  })
  return router
}
