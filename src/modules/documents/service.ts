import type { EmbeddingClient } from '../../integrations/embedding.js'
import type { RerankerClient } from '../../integrations/reranker.js'
import type { WorkspaceContext } from '../workspaces/types.js'
import type { DocumentRepository } from './repository.js'
import type { DocumentVisibility } from './types.js'
import { retrieveCandidates, type RetrievalMode } from './search.js'

export class DocumentService {
  constructor(
    private readonly repository: DocumentRepository,
    private readonly embedding: EmbeddingClient,
    private readonly reranker: RerankerClient,
    private readonly retrievalMode: RetrievalMode = 'hybrid'
  ) {}

  async create(
    context: WorkspaceContext,
    input: {
      title: string
      content: string
      visibility: DocumentVisibility
      metadata?: Record<string, unknown>
    }
  ) {
    const chunks = chunkText(input.content)
    const embeddings = await this.embedding.embed(chunks.map(chunk => chunk.content))
    return this.repository.create(context, {
      ...input,
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        embedding: embeddings.data[index]?.embedding,
      })),
    })
  }

  list(context: WorkspaceContext) {
    return this.repository.list(context)
  }

  async search(context: WorkspaceContext, query: string, limit = 20) {
    const candidates = (await retrieveCandidates(this.repository, this.embedding, context, query, limit, this.retrievalMode)).results
    if (!candidates.length) return []
    const reranked = await this.reranker.rerank(
      query,
      candidates.map(item => ({ id: item.chunkId, content: item.content })),
      limit
    )
    const byId = new Map(candidates.map(item => [item.chunkId, item]))
    return reranked.results.map(result => ({ ...byId.get(result.id)!, rerankScore: result.score }))
  }
}

function chunkText(content: string, size = 1200): Array<{ index: number; content: string }> {
  const chunks: Array<{ index: number; content: string }> = []
  for (let start = 0, index = 0; start < content.length; start += size, index += 1)
    chunks.push({ index, content: content.slice(start, start + size) })
  return chunks.length ? chunks : [{ index: 0, content }]
}
