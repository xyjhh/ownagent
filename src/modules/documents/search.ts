import type { EmbeddingClient } from '../../integrations/embedding.js'
import type { DocumentContext, SearchResult } from './types.js'
import type { DocumentRepository } from './repository.js'
import type { LangfuseTracer, TraceContext } from '../../observability/langfuse.js'

export type RetrievalMode = 'vector' | 'hybrid'
export type SearchExecutionMode = 'vector' | 'lexical' | 'hybrid' | 'none'
export type SearchFailure = 'vector' | 'lexical'

export type CandidateSearchResult = {
  results: SearchResult[]
  mode: SearchExecutionMode
  vectorCount: number
  lexicalCount: number
  failures: SearchFailure[]
}

export const RRF_K = 60

export function candidateLimit(limit: number) {
  return Math.min(100, Math.max(20, limit * 4))
}

export function fuseSearchResults(
  vector: SearchResult[],
  lexical: SearchResult[],
  limit: number
): SearchResult[] {
  const byId = new Map<string, { result: SearchResult; fusedScore: number; bestScore: number }>()
  const add = (items: SearchResult[]) => {
    items.forEach((result, index) => {
      const rank = index + 1
      const current = byId.get(result.chunkId)
      if (current) {
        current.fusedScore += 1 / (RRF_K + rank)
        current.bestScore = Math.max(current.bestScore, result.score)
      } else {
        byId.set(result.chunkId, {
          result,
          fusedScore: 1 / (RRF_K + rank),
          bestScore: result.score,
        })
      }
    })
  }
  add(vector)
  add(lexical)
  return [...byId.values()]
    .sort(
      (left, right) =>
        right.fusedScore - left.fusedScore ||
        right.bestScore - left.bestScore ||
        left.result.chunkId.localeCompare(right.result.chunkId)
    )
    .slice(0, limit)
    .map(item => ({ ...item.result, score: item.fusedScore }))
}

export async function retrieveCandidates(
  repository: DocumentRepository,
  embedding: EmbeddingClient,
  context: DocumentContext,
  query: string,
  limit: number,
  mode: RetrievalMode,
  trace?: TraceContext,
  tracer?: LangfuseTracer
): Promise<CandidateSearchResult> {
  const size = candidateLimit(limit)
  const lexicalPromise =
    mode === 'hybrid'
      ? observedSearch(
          tracer,
          trace,
          'retrieval.lexical_search',
          { queryLength: query.length, limit: size },
          () => repository.searchLexical(context, query, size)
        )
      : Promise.resolve([] as SearchResult[])
  const vectorPromise = (async () => {
    try {
      const response = await embedding.embed(query, trace, 'retrieval.embedding')
      const vectorSearch =
        repository.searchVector?.bind(repository) ?? repository.search.bind(repository)
      return observedSearch(tracer, trace, 'retrieval.vector_search', { limit: size }, () =>
        vectorSearch(context, response.data[0]?.embedding ?? [], size)
      )
    } catch (error) {
      throw error
    }
  })()
  const [lexical, vector] = await Promise.allSettled([lexicalPromise, vectorPromise])
  const lexicalResults = lexical.status === 'fulfilled' ? lexical.value : []
  const vectorResults = vector.status === 'fulfilled' ? vector.value : []
  const failures: SearchFailure[] = []
  if (mode === 'hybrid' && lexical.status === 'rejected') failures.push('lexical')
  if (vector.status === 'rejected') failures.push('vector')
  const results =
    mode === 'hybrid'
      ? fuseSearchResults(vectorResults, lexicalResults, size)
      : vectorResults.slice(0, size)
  const vectorAvailable = vector.status === 'fulfilled'
  const lexicalAvailable = mode === 'hybrid' && lexical.status === 'fulfilled'
  const executionMode: SearchExecutionMode =
    vectorAvailable && lexicalAvailable
      ? 'hybrid'
      : vectorAvailable
        ? 'vector'
        : lexicalAvailable
          ? 'lexical'
          : 'none'
  return {
    results,
    mode: executionMode,
    vectorCount: vectorResults.length,
    lexicalCount: lexicalResults.length,
    failures,
  }
}

async function observedSearch<T>(
  tracer: LangfuseTracer | undefined,
  trace: TraceContext | undefined,
  name: string,
  metadata: Record<string, unknown>,
  fn: () => Promise<T>
) {
  const span = trace && tracer?.startSpan(trace, name, metadata)
  try {
    const result = await fn()
    span?.end(Array.isArray(result) ? { resultCount: result.length } : undefined)
    return result
  } catch (error) {
    span?.fail(error)
    throw error
  }
}
