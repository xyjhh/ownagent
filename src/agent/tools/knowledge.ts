import type { EmbeddingClient } from '../../integrations/embedding.js'
import type { RerankerClient } from '../../integrations/reranker.js'
import type { DocumentRepository } from '../../modules/documents/repository.js'
import type { DocumentContext, Evidence } from '../../modules/documents/types.js'
import { retrieveCandidates, type RetrievalMode, type SearchExecutionMode } from '../../modules/documents/search.js'
import type { LangfuseTracer, TraceContext } from '../../observability/langfuse.js'

export type RetrievalRequest = { query: string; documentIds?: string[]; limit: number; mode: RetrievalMode; trace?: TraceContext }
export type RetrievalResult = {
  evidence: Evidence[]
  sufficient: boolean
  query: string
  reason?: string
  retrieval?: { mode: SearchExecutionMode; vectorCount: number; lexicalCount: number; failures: string[] }
}

export class RetrievalAgent {
  constructor(private readonly repository: DocumentRepository, private readonly embedding: EmbeddingClient, private readonly reranker: RerankerClient, private readonly defaultMode: RetrievalMode = 'hybrid', private readonly tracer?: LangfuseTracer) {}

  async search(context: DocumentContext, request: RetrievalRequest | string, legacyLimit = 8): Promise<RetrievalResult> {
    const normalized = typeof request === 'string' ? { query: request, limit: legacyLimit, mode: this.defaultMode } : request
    const retrievalSpan = normalized.trace && this.tracer?.startSpan(normalized.trace, 'retrieval', { mode: normalized.mode, queryLength: normalized.query.length, limit: normalized.limit })
    const trace = retrievalSpan?.context ?? normalized.trace
    let candidateSearch
    try {
      candidateSearch = await retrieveCandidates(this.repository, this.embedding, context, normalized.query, normalized.limit, normalized.mode, trace, this.tracer)
    } catch (error) {
      retrievalSpan?.fail(error)
      throw error
    }
    const scoped = normalized.documentIds?.length ? candidateSearch.results.filter(item => normalized.documentIds?.includes(item.documentId)) : candidateSearch.results
    const retrieval = { mode: candidateSearch.mode, vectorCount: candidateSearch.vectorCount, lexicalCount: candidateSearch.lexicalCount, failures: candidateSearch.failures }
    if (!scoped.length) {
      retrievalSpan?.end({ query: normalized.query, evidenceCount: 0 }, { mode: retrieval.mode, failures: retrieval.failures })
      return { evidence: [], sufficient: false, query: normalized.query, reason: 'no_evidence', retrieval }
    }
    let ranked
    try {
      ranked = await this.reranker.rerank(normalized.query, scoped.map(item => ({ id: item.chunkId, content: item.content })), normalized.limit, trace, 'retrieval.reranker')
    } catch (error) {
      retrievalSpan?.fail(error)
      throw error
    }
    const byId = new Map(scoped.map(item => [item.chunkId, item]))
    const evidence = ranked.results.map(item => {
      const result = byId.get(item.id)
      return result ? { ...result, rerankScore: item.score, versionId: result.versionId ?? '' } as Evidence : undefined
    }).filter((item): item is Evidence => Boolean(item))
    const uniqueEvidence = [...new Map(evidence.map(item => [item.chunkId, item])).values()]
    retrievalSpan?.end({ query: normalized.query, evidenceCount: uniqueEvidence.length }, { mode: retrieval.mode, vectorCount: retrieval.vectorCount, lexicalCount: retrieval.lexicalCount, failures: retrieval.failures })
    return { evidence: uniqueEvidence, sufficient: evidence.length > 0, query: normalized.query, retrieval }
  }
}
