import { Router } from 'express'
import { z } from 'zod'
import { badRequest } from './errors.js'
import { AuthService } from './service.js'
import { requireAuth } from './middleware.js'
import type { AppConfig } from '../../config/env.js'
import { clearAuthCookies, refreshCookie, setAuthCookies } from './cookies.js'

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
})
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(512) })

export function createAuthRouter(auth: AuthService, config?: AppConfig): Router {
  const router = Router()
  const protectedRoute = requireAuth(auth, config)

  router.post('/login', async (request, response, next) => {
    try {
      const input = credentialsSchema.safeParse(request.body)
      if (!input.success) throw badRequest('email and password are required')
      const result = await auth.login(input.data.email, input.data.password, {
        userAgent: request.get('user-agent') ?? undefined,
      })
      if (config) setAuthCookies(response, config, result.accessToken, result.refreshToken)
      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/refresh', async (request, response, next) => {
    try {
      const input = refreshSchema.safeParse(request.body)
      const refreshToken = input.success
        ? input.data.refreshToken
        : config
          ? refreshCookie(request, config)
          : undefined
      if (!refreshToken) throw badRequest('refreshToken is required')
      const result = await auth.refresh(refreshToken)
      if (config) setAuthCookies(response, config, result.accessToken, result.refreshToken)
      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/logout', async (request, response, next) => {
    try {
      const input = refreshSchema.safeParse(request.body)
      const refreshToken = input.success
        ? input.data.refreshToken
        : config
          ? refreshCookie(request, config)
          : undefined
      if (refreshToken) await auth.logout(refreshToken)
      if (config) clearAuthCookies(response, config)
      response.status(204).send()
    } catch (error) {
      next(error)
    }
  })

  router.get('/me', protectedRoute, async (request, response, next) => {
    try {
      response.json({ user: await auth.me(request.auth!.userId) })
    } catch (error) {
      next(error)
    }
  })

  return router
}
