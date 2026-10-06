import type { EmbeddingClient } from '../../integrations/embedding.js'
import type { RerankerClient } from '../../integrations/reranker.js'
import type { DocumentRepository } from '../../modules/documents/repository.js'
import type { DocumentContext, Evidence } from '../../modules/documents/types.js'

export type RetrievalRequest = { query: string; documentIds?: string[]; limit: number; mode: 'vector' | 'hybrid' }
export type RetrievalResult = { evidence: Evidence[]; sufficient: boolean; query: string; reason?: string }

export class RetrievalAgent {
  constructor(private readonly repository: DocumentRepository, private readonly embedding: EmbeddingClient, private readonly reranker: RerankerClient) {}

  async search(context: DocumentContext, request: RetrievalRequest | string, legacyLimit = 8): Promise<RetrievalResult> {
    const normalized = typeof request === 'string' ? { query: request, limit: legacyLimit, mode: 'vector' as const } : request
    const vector = await this.embedding.embed(normalized.query)
    const candidates = await this.repository.search(context, vector.data[0]?.embedding ?? [], Math.min(100, normalized.limit * 4))
    const scoped = normalized.documentIds?.length ? candidates.filter(item => normalized.documentIds?.includes(item.documentId)) : candidates
    if (!scoped.length) return { evidence: [], sufficient: false, query: normalized.query, reason: 'no_evidence' }
    const ranked = await this.reranker.rerank(normalized.query, scoped.map(item => ({ id: item.chunkId, content: item.content })), normalized.limit)
    const byId = new Map(scoped.map(item => [item.chunkId, item]))
    const evidence = ranked.results.map(item => {
      const result = byId.get(item.id)
      return result ? { ...result, rerankScore: item.score, versionId: result.versionId ?? '' } as Evidence : undefined
    }).filter((item): item is Evidence => Boolean(item))
    return { evidence: [...new Map(evidence.map(item => [item.chunkId, item])).values()], sufficient: evidence.length > 0, query: normalized.query }
  }
}
