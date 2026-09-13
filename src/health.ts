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
      modelServicesAreNonBlocking: true,
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
