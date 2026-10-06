import type { EmbeddingClient } from '../../integrations/embedding.js'
import type { DocumentContext, SearchResult } from './types.js'
import type { DocumentRepository } from './repository.js'

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

export function fuseSearchResults(vector: SearchResult[], lexical: SearchResult[], limit: number): SearchResult[] {
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
    .sort((left, right) => right.fusedScore - left.fusedScore || right.bestScore - left.bestScore || left.result.chunkId.localeCompare(right.result.chunkId))
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
): Promise<CandidateSearchResult> {
  const size = candidateLimit(limit)
  const lexicalPromise = mode === 'hybrid'
    ? repository.searchLexical(context, query, size)
    : Promise.resolve([] as SearchResult[])
  const vectorPromise = (async () => {
    const response = await embedding.embed(query)
    const vectorSearch = repository.searchVector?.bind(repository) ?? repository.search.bind(repository)
    return vectorSearch(context, response.data[0]?.embedding ?? [], size)
  })()
  const [lexical, vector] = await Promise.allSettled([lexicalPromise, vectorPromise])
  const lexicalResults = lexical.status === 'fulfilled' ? lexical.value : []
  const vectorResults = vector.status === 'fulfilled' ? vector.value : []
  const failures: SearchFailure[] = []
  if (mode === 'hybrid' && lexical.status === 'rejected') failures.push('lexical')
  if (vector.status === 'rejected') failures.push('vector')
  const results = mode === 'hybrid'
    ? fuseSearchResults(vectorResults, lexicalResults, size)
    : vectorResults.slice(0, size)
  const vectorAvailable = vector.status === 'fulfilled'
  const lexicalAvailable = mode === 'hybrid' && lexical.status === 'fulfilled'
  const executionMode: SearchExecutionMode = vectorAvailable && lexicalAvailable
    ? 'hybrid'
    : vectorAvailable
      ? 'vector'
      : lexicalAvailable
        ? 'lexical'
        : 'none'
  return { results, mode: executionMode, vectorCount: vectorResults.length, lexicalCount: lexicalResults.length, failures }
}
