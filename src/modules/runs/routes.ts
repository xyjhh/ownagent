import { Router } from 'express'
import { z } from 'zod'
import type { AuthService } from '../auth/service.js'
import { requireWorkspaceAccess } from '../workspaces/middleware.js'
import type { WorkspaceRepository } from '../workspaces/repository.js'
import type { RunService } from './service.js'
import type { AppConfig } from '../../config/env.js'

export function createRunRouter(
  auth: AuthService,
  workspaceRepository: WorkspaceRepository,
  service: RunService,
  config?: AppConfig
): Router {
  const router = Router()
  const access = requireWorkspaceAccess(auth, workspaceRepository, [
    'owner',
    'admin',
    'editor',
    'viewer',
  ], config)
  router.post('/:workspaceId/runs', access, async (request, response, next) => {
    try {
      const key = request.header('x-idempotency-key')?.trim()
      if (!key || key.length > 200)
        return response
          .status(400)
          .json({
            error: {
              code: 'IDEMPOTENCY_KEY_REQUIRED',
              message: 'X-Idempotency-Key is required',
              requestId: request.requestId,
            },
          })
      const input = z
        .object({
          question: z.string().min(1).max(20_000),
          conversationId: z.string().uuid().optional(),
        })
        .safeParse(request.body)
      if (!input.success)
        return response
          .status(400)
          .json({
            error: {
              code: 'INVALID_INPUT',
              message: 'question is required',
              requestId: request.requestId,
            },
          })
      const run = await service.create(request.workspace!, input.data, key)
      response.status(202).json({ run })
    } catch (error) {
      next(error)
    }
  })
  router.get('/:workspaceId/runs/:runId', access, async (request, response, next) => {
    try {
      const run = await service.get(request.workspace!, String(request.params.runId))
      if (!run)
        return response
          .status(404)
          .json({
            error: { code: 'NOT_FOUND', message: 'Run not found', requestId: request.requestId },
          })
      response.json({ run })
    } catch (error) {
      next(error)
    }
  })
  router.post('/:workspaceId/runs/:runId/cancel', access, async (request, response, next) => {
    try {
      const run = await service.cancel(request.workspace!, String(request.params.runId))
      if (!run)
        return response
          .status(404)
          .json({
            error: { code: 'NOT_FOUND', message: 'Run not found', requestId: request.requestId },
          })
      response.json({ run })
    } catch (error) {
      next(error)
    }
  })
  router.post('/:workspaceId/runs/:runId/approve', access, async (request, response, next) => {
    try { const input = z.object({ approvalId: z.string().min(1).max(120), value: z.boolean().default(true), controlId: z.string().min(1).max(120).optional() }).safeParse(request.body); if (!input.success) return response.status(400).json({ error: { code: 'INVALID_INPUT', message: 'approvalId and value are required', requestId: request.requestId } }); const run = await service.approve(request.workspace!, String(request.params.runId), input.data.approvalId, input.data.value, input.data.controlId ?? crypto.randomUUID()); response.json({ run }) } catch (error) { next(error) }
  })
  router.post('/:workspaceId/runs/:runId/reject', access, async (request, response, next) => {
    try { const input = z.object({ approvalId: z.string().min(1).max(120), reason: z.string().max(2000).optional(), controlId: z.string().min(1).max(120).optional() }).safeParse(request.body); if (!input.success) return response.status(400).json({ error: { code: 'INVALID_INPUT', message: 'approvalId is required', requestId: request.requestId } }); const run = await service.approve(request.workspace!, String(request.params.runId), input.data.approvalId, false, input.data.controlId ?? crypto.randomUUID()); response.json({ run }) } catch (error) { next(error) }
  })
  router.post('/:workspaceId/runs/:runId/interrupt', access, async (request, response, next) => {
    try { const input = z.object({ reason: z.string().max(500).optional(), controlId: z.string().min(1).max(120).optional() }).parse(request.body ?? {}); const run = await service.control(request.workspace!, String(request.params.runId), 'interrupt', { reason: input.reason ?? 'user_cancelled' }, input.controlId ?? String(crypto.randomUUID())); response.json({ run }) } catch (error) { next(error) }
  })
  router.post('/:workspaceId/runs/:runId/follow-up', access, async (request, response, next) => {
    try { const input = z.object({ question: z.string().min(1).max(20_000), controlId: z.string().min(1).max(120).optional() }).safeParse(request.body); if (!input.success) return response.status(400).json({ error: { code: 'INVALID_INPUT', message: 'question is required', requestId: request.requestId } }); const run = await service.control(request.workspace!, String(request.params.runId), 'follow_up', { question: input.data.question }, input.data.controlId ?? String(crypto.randomUUID())); response.status(202).json({ run }) } catch (error) { next(error) }
  })
  router.get('/:workspaceId/runs/:runId/events', access, async (request, response, next) => {
    try {
      const afterSequence = Number(request.query.afterSequence ?? 0)
      const events = await service.events(request.workspace!, String(request.params.runId), Number.isFinite(afterSequence) ? afterSequence : 0)
      if (events === null)
        return response
          .status(404)
          .json({
            error: { code: 'NOT_FOUND', message: 'Run not found', requestId: request.requestId },
          })
      response.json({ events })
    } catch (error) {
      next(error)
    }
  })
  return router
}
