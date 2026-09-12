import { Router } from 'express'
import type { AuthService } from '../auth/service.js'
import { requireAuth } from '../auth/middleware.js'
import { WorkspaceService } from './service.js'
import type { AppConfig } from '../../config/env.js'

export function createInviteRouter(auth: AuthService, service: WorkspaceService, config?: AppConfig): Router {
  const router = Router()
  router.post('/:token/accept', requireAuth(auth, config), async (request, response, next) => {
    try { response.json(await service.acceptInvite(request.auth!.userId, request.auth!.email, String(request.params.token ?? ''))) } catch (error) { next(error) }
  })
  return router
}
