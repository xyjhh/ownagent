import type { Evidence } from '../modules/documents/types.js'

export type UserIntent = 'knowledge_query' | 'document_summary' | 'document_compare' | 'general_chat'
export type PermissionContext = { workspaceId: string; userId: string; role: string }
export type AgentContext = {
  tenantId: string
  workspaceId: string
  userId: string
  runId: string
  intent: UserIntent
  evidence: Evidence[]
  permissions: PermissionContext
  tokenBudget: number
}
