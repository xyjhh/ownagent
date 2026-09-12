import type { AppConfig } from '../config/env.js'
import { fetchJson, probe } from './http.js'

export type EmbeddingResponse = {
  object: 'list'
  data: Array<{ object: 'embedding'; index: number; embedding: number[] }>
  model: string
  usage?: { prompt_tokens: number; total_tokens: number }
}

export class EmbeddingClient {
  constructor(private readonly config: AppConfig) {}

  async health(): Promise<'ok' | 'unavailable'> {
    return probe(
      `${this.config.EMBEDDING_BASE_URL.replace(/\/v1\/?$/, '')}/health`,
      this.config.MODEL_TIMEOUT_MS
    )
  }

  async embed(input: string | string[]): Promise<EmbeddingResponse> {
    return fetchJson<EmbeddingResponse>(
      `${this.config.EMBEDDING_BASE_URL}/embeddings`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.config.EMBEDDING_MODEL, input }),
      },
      this.config.MODEL_TIMEOUT_MS
    )
  }
}
