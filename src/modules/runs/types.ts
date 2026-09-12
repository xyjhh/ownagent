import type { WorkspaceContext } from '../workspaces/types.js'

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'waiting_user' | 'completed' | 'failed' | 'interrupted' | 'canceled'
export type AgentRun = { id: string; workspaceId: string; requestedBy: string; status: RunStatus; input: Record<string, unknown>; attempt: number; maxAttempts: number; threadId: string; traceId?: string; errorCode?: string; createdAt: string; startedAt?: string; finishedAt?: string }
export type RunContext = WorkspaceContext & { runId: string }
export type RunEvent = { runId: string; sequence: number; type: string; payload: Record<string, unknown>; createdAt: string }
export type RunControlType = 'approve' | 'reject' | 'interrupt' | 'follow_up'
