import type { AppConfig } from '../config/env.js'
import { fetchJson, probe } from './http.js'
import type { LangfuseTracer, TraceContext } from '../observability/langfuse.js'

export type RerankDocument = { id: string; content: string }
export type RerankResponse = { results: Array<{ id: string; score: number }> }

export class RerankerClient {
  constructor(private readonly config: AppConfig, private readonly tracer?: LangfuseTracer) {}

  async health(): Promise<'ok' | 'unavailable'> {
    return probe(`${this.config.RERANK_URL}/health`, this.config.MODEL_TIMEOUT_MS)
  }

  async rerank(query: string, documents: RerankDocument[], topN = 6, trace?: TraceContext, operation = 'reranker'): Promise<RerankResponse> {
    const span = trace && this.tracer?.startSpan(trace, operation, { candidateCount: documents.length, topN })
    try {
      const result = await fetchJson<RerankResponse>(
        `${this.config.RERANK_URL}/rerank`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, documents, top_n: topN }),
        },
        this.config.MODEL_TIMEOUT_MS
      )
      span?.end({ query, documents, resultCount: result.results.length, topScore: result.results[0]?.score })
      return result
    } catch (error) {
      span?.fail(error)
      throw error
    }
  }
}
