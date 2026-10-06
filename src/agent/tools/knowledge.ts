import type { EmbeddingClient } from '../../integrations/embedding.js'
import type { RerankerClient } from '../../integrations/reranker.js'
import type { DocumentRepository } from '../../modules/documents/repository.js'
import type { DocumentContext, Evidence } from '../../modules/documents/types.js'
import { retrieveCandidates, type RetrievalMode, type SearchExecutionMode } from '../../modules/documents/search.js'

export type RetrievalRequest = { query: string; documentIds?: string[]; limit: number; mode: RetrievalMode }
export type RetrievalResult = {
  evidence: Evidence[]
  sufficient: boolean
  query: string
  reason?: string
  retrieval?: { mode: SearchExecutionMode; vectorCount: number; lexicalCount: number; failures: string[] }
}

export class RetrievalAgent {
  constructor(private readonly repository: DocumentRepository, private readonly embedding: EmbeddingClient, private readonly reranker: RerankerClient, private readonly defaultMode: RetrievalMode = 'hybrid') {}

  async search(context: DocumentContext, request: RetrievalRequest | string, legacyLimit = 8): Promise<RetrievalResult> {
    const normalized = typeof request === 'string' ? { query: request, limit: legacyLimit, mode: this.defaultMode } : request
    const candidateSearch = await retrieveCandidates(this.repository, this.embedding, context, normalized.query, normalized.limit, normalized.mode)
    const scoped = normalized.documentIds?.length ? candidateSearch.results.filter(item => normalized.documentIds?.includes(item.documentId)) : candidateSearch.results
    const retrieval = { mode: candidateSearch.mode, vectorCount: candidateSearch.vectorCount, lexicalCount: candidateSearch.lexicalCount, failures: candidateSearch.failures }
    if (!scoped.length) return { evidence: [], sufficient: false, query: normalized.query, reason: 'no_evidence', retrieval }
    const ranked = await this.reranker.rerank(normalized.query, scoped.map(item => ({ id: item.chunkId, content: item.content })), normalized.limit)
    const byId = new Map(scoped.map(item => [item.chunkId, item]))
    const evidence = ranked.results.map(item => {
      const result = byId.get(item.id)
      return result ? { ...result, rerankScore: item.score, versionId: result.versionId ?? '' } as Evidence : undefined
    }).filter((item): item is Evidence => Boolean(item))
    return { evidence: [...new Map(evidence.map(item => [item.chunkId, item])).values()], sufficient: evidence.length > 0, query: normalized.query, retrieval }
  }
}
