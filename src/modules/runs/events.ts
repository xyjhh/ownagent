export type AgentEventType =
  | 'started'
  | 'node_started'
  | 'node_completed'
  | 'token'
  | 'interrupt'
  | 'completed'
  | 'failed'

export type AgentEvent = {
  type: AgentEventType
  runId: string
  sequence?: number
  workspaceId: string
  sessionId?: string
  [key: string]: unknown
}
