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
  constructor(
    private readonly config: AppConfig,
    private readonly tracer?: LangfuseTracer
  ) {}

  async health(): Promise<'ok' | 'configured' | 'unavailable'> {
    const isLocal = /^(https?:\/\/)?(127\.0\.0\.1|localhost|host\.docker\.internal)(:\d+)?\b/i.test(
      this.config.EMBEDDING_BASE_URL
    )
    if (!isLocal) return this.apiKey() ? 'configured' : 'unavailable'
    return probe(
      `${this.config.EMBEDDING_BASE_URL.replace(/\/v1\/?$/, '')}/health`,
      this.config.MODEL_TIMEOUT_MS
    )
  }

  private apiKey() {
    return this.config.EMBEDDING_API_KEY || this.config.DASHSCOPE_API_KEY
  }

  async embed(
    input: string | string[],
    trace?: TraceContext,
    operation = 'embedding'
  ): Promise<EmbeddingResponse> {
    const span =
      trace &&
      this.tracer?.startSpan(trace, operation, {
        model: this.config.EMBEDDING_MODEL,
        inputCount: Array.isArray(input) ? input.length : 1,
      })
    try {
      const apiKey = this.apiKey()
      const result = await fetchJson<EmbeddingResponse>(
        `${this.config.EMBEDDING_BASE_URL}/embeddings`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ model: this.config.EMBEDDING_MODEL, input }),
        },
        this.config.MODEL_TIMEOUT_MS
      )
      span?.end({
        input,
        vectorCount: result.data.length,
        dimension: result.data[0]?.embedding?.length ?? 0,
      })
      return result
    } catch (error) {
      span?.fail(error)
      throw error
    }
  }
}
