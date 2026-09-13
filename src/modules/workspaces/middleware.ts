import type { NextFunction, Request, Response } from 'express'
import { ApiError } from '../auth/errors.js'
import { requireAuth } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { WorkspaceRepository } from './repository.js'
import type { WorkspaceRole } from './types.js'
import type { AppConfig } from '../../config/env.js'

export function requireWorkspaceAccess(
  auth: AuthService,
  repository: WorkspaceRepository,
  allowedRoles?: WorkspaceRole[],
  config?: AppConfig
) {
  const authenticate = requireAuth(auth, config)
  return async (request: Request, response: Response, next: NextFunction) => {
    authenticate(request, response, async error => {
      if (error) return next(error)
      try {
        const workspaceId = String(request.params.workspaceId ?? '')
        if (!workspaceId || !request.auth)
          throw new ApiError(400, 'WORKSPACE_REQUIRED', 'workspaceId is required')
        const membership = await repository.findMembership(request.auth.userId, workspaceId)
        if (!membership)
          throw new ApiError(403, 'WORKSPACE_FORBIDDEN', 'You are not a member of this workspace')
        if (allowedRoles && !allowedRoles.includes(membership.role))
          throw new ApiError(403, 'ROLE_FORBIDDEN', 'Insufficient workspace role')
        request.workspace = membership
        next()
      } catch (membershipError) {
        next(membershipError)
      }
    })
  }
}
