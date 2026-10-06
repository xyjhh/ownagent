import { Router } from 'express'
import { z } from 'zod'
import type { AuthService } from '../auth/service.js'
import { requireAuth } from '../auth/middleware.js'
import { MemoryRepository } from './repository.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppConfig } from '../../config/env.js'

export function createMemoryRouter(auth: AuthService, db: SupabaseClient, config: AppConfig) {
  const router = Router(); const repository = new MemoryRepository(db); const access = requireAuth(auth, config)
  router.get('/', access, async (req, res, next) => { try { const workspaceId = String(req.query.workspaceId ?? ''); if (!workspaceId || !req.auth) return res.status(400).json({ error: 'workspaceId is required' }); res.json({ memories: await repository.list(workspaceId, req.auth.userId) }) } catch (e) { next(e) } })
  const workspace = (req: any) => String(req.query.workspaceId ?? req.body?.workspaceId ?? '')
  router.patch('/:id', access, async (req, res, next) => { try { if (!req.auth) return res.status(401).end(); const input = z.object({ status: z.enum(['active', 'deleted', 'archived']) }).parse(req.body); const memory = await repository.updateStatus(String(req.params.id), input.status, req.auth.userId, workspace(req)); if (!memory) return res.status(404).json({ error: 'MEMORY_NOT_FOUND' }); res.json({ memory }) } catch (e) { next(e) } })
  router.post('/:id/confirm', access, async (req, res, next) => { try { if (!req.auth) return res.status(401).end(); const workspaceId = workspace(req); const memory = await repository.updateStatus(String(req.params.id), 'active', req.auth.userId, workspaceId); if (!memory) return res.status(404).json({ error: 'MEMORY_NOT_FOUND' }); try { await repository.enqueueTask({ workspaceId, userId: req.auth.userId, memoryItemId: memory.id, taskType: 'embed_memory', payload: { memoryItemId: memory.id } }) } catch { /* confirmation remains durable even if queue is temporarily unavailable */ } res.json({ memory }) } catch (e) { next(e) } })
  router.post('/:id/reject', access, async (req, res, next) => { try { if (!req.auth) return res.status(401).end(); const memory = await repository.updateStatus(String(req.params.id), 'deleted', req.auth.userId, workspace(req)); if (!memory) return res.status(404).json({ error: 'MEMORY_NOT_FOUND' }); res.json({ memory }) } catch (e) { next(e) } })
  router.delete('/:id', access, async (req, res, next) => { try { if (!req.auth) return res.status(401).end(); const memory = await repository.updateStatus(String(req.params.id), 'deleted', req.auth.userId, workspace(req)); if (!memory) return res.status(404).json({ error: 'MEMORY_NOT_FOUND' }); res.json({ memory }) } catch (e) { next(e) } })
  return router
}
