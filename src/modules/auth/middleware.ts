import type { NextFunction, Request, Response } from 'express'
import { AuthService } from './service.js'
import { unauthorized } from './errors.js'
import { accessCookie } from './cookies.js'
import type { AppConfig } from '../../config/env.js'

export function requireAuth(auth: AuthService, config?: AppConfig) {
  return async (request: Request, _response: Response, next: NextFunction) => {
    try {
      const header = request.header('authorization')
      const token = header?.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : config
          ? accessCookie(request, config)
          : undefined
      if (!token) throw unauthorized()
      request.auth = await auth.authenticateAccessToken(token)
      next()
    } catch (error) {
      next(error)
    }
  }
}
