export type WorkerMetricsSnapshot = {
  activeAgents: number
  activeControls: number
  agentsStarted: number
  agentsCompleted: number
  agentsRetried: number
  agentsFailed: number
  agentsInterrupted: number
  eventPublishFailures: number
  deadLetterWrites: number
  deadLetterFailures: number
  totalAgentDurationMs: number
  graphNodeDurationMs: number
  supervisorCalls: number
  supervisorFailures: number
  supervisorFallbacks: number
  supervisorLowConfidence: number
  planRejections: number
}

const metrics: WorkerMetricsSnapshot = {
  activeAgents: 0,
  activeControls: 0,
  agentsStarted: 0,
  agentsCompleted: 0,
  agentsRetried: 0,
  agentsFailed: 0,
  agentsInterrupted: 0,
  eventPublishFailures: 0,
  deadLetterWrites: 0,
  deadLetterFailures: 0,
  totalAgentDurationMs: 0,
  graphNodeDurationMs: 0,
  supervisorCalls: 0,
  supervisorFailures: 0,
  supervisorFallbacks: 0,
  supervisorLowConfidence: 0,
  planRejections: 0,
}

export function workerMetric<K extends keyof WorkerMetricsSnapshot>(key: K, value = 1) {
  metrics[key] += value as never
}

export function workerMetricsSnapshot(): WorkerMetricsSnapshot {
  return { ...metrics }
}

export function resetWorkerMetrics() {
  for (const key of Object.keys(metrics) as Array<keyof WorkerMetricsSnapshot>) metrics[key] = 0
}
