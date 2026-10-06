import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppConfig } from './config/env.js'
import { EmbeddingClient } from './integrations/embedding.js'
import { RerankerClient } from './integrations/reranker.js'
import { DeepSeekClient } from './integrations/deepseek.js'
import type { RedisStreams } from './queue/redis-streams.js'
import type { LangfuseTracer } from './observability/langfuse.js'

export type DependencyStatus = 'ok' | 'configured' | 'unavailable'

export class HealthService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: SupabaseClient,
    private readonly deepseek = new DeepSeekClient(config),
    private readonly embedding = new EmbeddingClient(config),
    private readonly reranker = new RerankerClient(config),
    private readonly queue?: RedisStreams,
    private readonly tracer?: LangfuseTracer
  ) {}

  async ready() {
    const supabase = await this.supabaseStatus()
    const [embedding, reranker, redis] = await Promise.all([
      this.embedding.health(),
      this.reranker.health(),
      this.queue?.health() ?? Promise.resolve('unavailable' as const),
    ])
    const redisMetrics = this.queue ? await this.redisMetrics() : undefined
    const outboxMetrics = await this.outboxMetrics()
    const dependencies = {
      supabase,
      deepseek: (this.deepseek.isConfigured() ? 'configured' : 'unavailable') as DependencyStatus,
      embedding,
      reranker,
      redis,
      langfuse: this.tracer?.isConfigured() ? 'configured' : 'unavailable',
    }
    return {
      status: supabase === 'ok' ? 'ok' : 'not_ready',
      dependencies,
      ...(redisMetrics ? { redisMetrics } : {}),
      ...(outboxMetrics ? { outboxMetrics } : {}),
      modelServicesAreNonBlocking: true,
    }
  }

  private async redisMetrics() {
    if (!this.queue) return undefined
    try {
      const [memory, agent, controls, deadLetter, memoryTasks] = await Promise.all([
        this.queue.memoryStats(),
        this.queue.streamStats(this.config.REDIS_STREAM_AGENT, this.config.REDIS_CONSUMER_GROUP),
        this.queue.streamStats(this.config.REDIS_STREAM_CONTROLS, this.config.REDIS_CONSUMER_GROUP),
        this.queue.streamStats(this.config.REDIS_STREAM_DEAD_LETTER),
        this.queue.streamStats(this.config.REDIS_STREAM_MEMORY ?? 'ownagent:memory-tasks', this.config.REDIS_CONSUMER_GROUP),
      ])
      return {
        usedMemory: memory.usedMemory,
        maxMemory: memory.maxMemory,
        memoryUsageRatio: memory.usageRatio,
        memoryPressure: pressureLevel(memory.usageRatio),
        agentStreamLength: agent.length,
        controlStreamLength: controls.length,
        deadLetterStreamLength: deadLetter.length,
        memoryStreamLength: memoryTasks.length,
        memoryPendingCount: memoryTasks.pendingCount,
        memoryOldestPendingIdleMs: memoryTasks.oldestPendingIdleMs,
        pendingCount: agent.pendingCount + controls.pendingCount,
        oldestPendingIdleMs: Math.max(agent.oldestPendingIdleMs, controls.oldestPendingIdleMs),
      }
    } catch {
      return undefined
    }
  }

  private async outboxMetrics() {
    try {
      const { data, error, count } = await this.db
        .from('task_outbox')
        .select('id,created_at', { count: 'exact' })
        .is('published_at', null)
        .order('created_at', { ascending: true })
        .limit(1)
      if (error) return undefined
      const oldest = data?.[0]?.created_at
      return {
        unpublishedCount: count ?? 0,
        oldestAgeMs: oldest ? Math.max(0, Date.now() - Date.parse(String(oldest))) : 0,
      }
    } catch {
      return undefined
    }
  }

  private async supabaseStatus(): Promise<'ok' | 'unavailable'> {
    try {
      const { error } = await this.db.from('app_users').select('id').limit(1)
      return error ? 'unavailable' : 'ok'
    } catch {
      return 'unavailable'
    }
  }
}

function pressureLevel(ratio: number | null): 'unknown' | 'normal' | 'notice' | 'warning' | 'critical' {
  if (ratio === null) return 'unknown'
  if (ratio >= 0.95) return 'critical'
  if (ratio >= 0.85) return 'warning'
  if (ratio >= 0.7) return 'notice'
  return 'normal'
}
