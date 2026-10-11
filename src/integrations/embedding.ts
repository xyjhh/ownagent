import type { AppConfig } from '../config/env.js'
import { fetchJson, probe } from './http.js'
import type { LangfuseTracer, TraceContext } from '../observability/langfuse.js'

export type EmbeddingResponse = {
  object: 'list'
  data: Array<{ object: 'embedding'; index: number; embedding: number[] }>
  model: string
  usage?: { prompt_tokens: number; total_tokens: number }
}

export class EmbeddingClient {
  constructor(private readonly config: AppConfig, private readonly tracer?: LangfuseTracer) {}

  async health(): Promise<'ok' | 'unavailable'> {
    return probe(
      `${this.config.EMBEDDING_BASE_URL.replace(/\/v1\/?$/, '')}/health`,
      this.config.MODEL_TIMEOUT_MS
    )
  }

  async embed(input: string | string[], trace?: TraceContext, operation = 'embedding'): Promise<EmbeddingResponse> {
    const span = trace && this.tracer?.startSpan(trace, operation, { model: this.config.EMBEDDING_MODEL, inputCount: Array.isArray(input) ? input.length : 1 })
    try {
      const result = await fetchJson<EmbeddingResponse>(
        `${this.config.EMBEDDING_BASE_URL}/embeddings`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.config.EMBEDDING_MODEL, input }),
        },
        this.config.MODEL_TIMEOUT_MS
      )
      span?.end({ input, vectorCount: result.data.length, dimension: result.data[0]?.embedding?.length ?? 0 })
      return result
    } catch (error) {
      span?.fail(error)
      throw error
    }
  }
}
