import type { AppConfig } from '../config/env.js'
import { fetchJson, probe } from './http.js'

export type RerankDocument = { id: string; content: string }
export type RerankResponse = { results: Array<{ id: string; score: number }> }

export class RerankerClient {
  constructor(private readonly config: AppConfig) {}

  async health(): Promise<'ok' | 'unavailable'> {
    return probe(`${this.config.RERANK_URL}/health`, this.config.MODEL_TIMEOUT_MS)
  }

  async rerank(query: string, documents: RerankDocument[], topN = 6): Promise<RerankResponse> {
    return fetchJson<RerankResponse>(
      `${this.config.RERANK_URL}/rerank`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, documents, top_n: topN }),
      },
      this.config.MODEL_TIMEOUT_MS
    )
  }
}
