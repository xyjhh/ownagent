import { Router } from 'express'
import { z } from 'zod'
import type { AuthService } from '../auth/service.js'
import type { WorkspaceRepository } from '../workspaces/repository.js'
import { requireWorkspaceAccess } from '../workspaces/middleware.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppConfig } from '../../config/env.js'
import { ConversationRepository } from './repository.js'

export function createConversationRouter(auth: AuthService, workspaces: WorkspaceRepository, db: SupabaseClient, config: AppConfig) {
  const router = Router(); const repository = new ConversationRepository(db); const access = requireWorkspaceAccess(auth, workspaces, ['owner', 'admin', 'editor', 'viewer'], config)
  router.get('/:workspaceId/conversations', access, async (req, res, next) => { try { res.json({ conversations: await repository.list(req.workspace!.workspaceId, Number(req.query.limit ?? 50)) }) } catch (e) { next(e) } })
  router.get('/:workspaceId/conversations/:conversationId', access, async (req, res, next) => { try { const { data, error } = await db.from('conversations').select('*').eq('id', req.params.conversationId).eq('workspace_id', req.workspace!.workspaceId).maybeSingle(); if (error) throw error; if (!data) return res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' }); res.json({ conversation: data, messages: await repository.recent(String(req.params.conversationId), 50) }) } catch (e) { next(e) } })
  router.get('/:workspaceId/conversations/:conversationId/messages', access, async (req, res, next) => { try { if (!(await repository.belongsToWorkspace(String(req.params.conversationId), req.workspace!.workspaceId))) return res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' }); res.json({ messages: await repository.recent(String(req.params.conversationId), 100) }) } catch (e) { next(e) } })
  router.post('/:workspaceId/conversations', requireWorkspaceAccess(auth, workspaces, ['owner', 'admin', 'editor'], config), async (req, res, next) => { try { const input = z.object({ title: z.string().max(200).default('New conversation') }).parse(req.body); const { data, error } = await db.from('conversations').insert({ workspace_id: req.workspace!.workspaceId, created_by: req.workspace!.userId, title: input.title }).select('*').single(); if (error) throw error; res.status(201).json({ conversation: data }) } catch (e) { next(e) } })
  return router
}
