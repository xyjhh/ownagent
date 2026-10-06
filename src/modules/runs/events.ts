export type AgentEventType =
  | 'started'
  | 'node_started'
  | 'node_completed'
  | 'token'
  | 'interrupt'
  | 'completed'
  | 'failed'
  | 'intent_detected'
  | 'retrieval_started'
  | 'retrieval_completed'
  | 'citation'
  | 'memory_candidate'
  | 'plan_created'
  | 'plan_rejected'
  | 'clarification_required'
  | 'summary_completed'
  | 'comparison_completed'
  | 'memory_task_queued'
  | 'memory_saved'
  | 'memory_confirmed'
  | 'memory_rejected'
  | 'memory_archived'
  | 'memory_consolidated'
  | 'memory_embedded'
  | 'memory_expired'
  | 'memory_task_failed'

export type AgentEvent = {
  type: AgentEventType
  runId: string
  sequence?: number
  workspaceId: string
  sessionId?: string
  [key: string]: unknown
}

export type AgentMessageResult =
  | 'completed'
  | 'waiting'
  | 'interrupted'
  | 'retryable'
  | 'dead_lettered'
  | 'skipped'
  | 'unhandled'
