import type { AppConfig } from '../config/env.js'
import { fetchJson } from './http.js'
import type { LangfuseTracer, TraceContext } from '../observability/langfuse.js'

export type RerankDocument = { id: string; content: string }
export type RerankResponse = { results: Array<{ id: string; score: number }> }

type DashScopeRerankResponse = {
  output?: {
    results?: Array<{ index?: number; relevance_score?: number }>
  }
  code?: string
  message?: string
}

export class RerankerClient {
  constructor(
    private readonly config: AppConfig,
    private readonly tracer?: LangfuseTracer
  ) {}

  private endpoint() {
    if (this.config.DASHSCOPE_RERANK_URL) return this.config.DASHSCOPE_RERANK_URL
    if (!this.config.DASHSCOPE_WORKSPACE_ID) return undefined
    return `https://${this.config.DASHSCOPE_WORKSPACE_ID}.${this.config.DASHSCOPE_REGION}.maas.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank`
  }

  async health(): Promise<'configured' | 'unavailable'> {
    return this.config.DASHSCOPE_API_KEY && this.endpoint() ? 'configured' : 'unavailable'
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    topN = 6,
    trace?: TraceContext,
    operation = 'reranker'
  ): Promise<RerankResponse> {
    if (!documents.length) return { results: [] }
    if (!this.config.DASHSCOPE_API_KEY) throw new Error('DASHSCOPE_API_KEY is not configured')
    const endpoint = this.endpoint()
    if (!endpoint)
      throw new Error('DASHSCOPE_WORKSPACE_ID or DASHSCOPE_RERANK_URL is not configured')

    const limit = Math.max(1, Math.min(topN, documents.length))
    const span =
      trace &&
      this.tracer?.startSpan(trace, operation, {
        model: this.config.RERANK_MODEL,
        candidateCount: documents.length,
        topN: limit,
      })
    try {
      const result = await fetchJson<DashScopeRerankResponse>(
        endpoint,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.DASHSCOPE_API_KEY}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.RERANK_MODEL,
            input: {
              query,
              documents: documents.map(document => document.content),
            },
            parameters: {
              top_n: limit,
              instruct: this.config.RERANK_INSTRUCT,
            },
          }),
        },
        this.config.MODEL_TIMEOUT_MS
      )
      if (!Array.isArray(result.output?.results)) {
        throw new Error(
          `DashScope rerank returned an invalid response${result.code ? `: ${result.code}` : ''}`
        )
      }
      const mapped = result.output.results
        .filter(
          item =>
            Number.isInteger(item.index) &&
            Number(item.index) >= 0 &&
            Number(item.index) < documents.length
        )
        .map(item => ({
          id: documents[Number(item.index!)].id,
          score: Number(item.relevance_score ?? 0),
        }))
        .slice(0, limit)
      span?.end({ query, resultCount: mapped.length, topScore: mapped[0]?.score })
      return { results: mapped }
    } catch (error) {
      span?.fail(error)
      throw error
    }
  }
}
