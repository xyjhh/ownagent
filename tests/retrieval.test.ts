import { describe, expect, it, vi } from 'vitest'
import { fuseSearchResults } from '../src/modules/documents/search.js'
import { RetrievalAgent } from '../src/agent/tools/knowledge.js'
import type { SearchResult } from '../src/modules/documents/types.js'

const result = (chunkId: string, score: number): SearchResult => ({
  chunkId,
  documentId: `document-${chunkId}`,
  versionId: `version-${chunkId}`,
  title: chunkId,
  content: `content-${chunkId}`,
  metadata: {},
  score,
})

describe('hybrid retrieval', () => {
  it('fuses ranked lists with RRF and removes duplicate chunks', () => {
    const fused = fuseSearchResults(
      [result('shared', 0.7), result('vector-only', 0.6)],
      [result('shared', 0.9), result('lexical-only', 0.8)],
      3,
    )
    expect(fused).toHaveLength(3)
    expect(fused.map(item => item.chunkId)).toEqual(['shared', 'lexical-only', 'vector-only'])
    expect(new Set(fused.map(item => item.chunkId)).size).toBe(3)
  })

  it('falls back to lexical results when embedding fails', async () => {
    const repository = {
      searchLexical: vi.fn().mockResolvedValue([result('lexical', 0.8)]),
      searchVector: vi.fn().mockRejectedValue(new Error('embedding unavailable')),
    }
    const embedding = { embed: vi.fn().mockRejectedValue(new Error('embedding unavailable')) }
    const reranker = { rerank: vi.fn().mockResolvedValue({ results: [{ id: 'lexical', score: 0.95 }] }) }
    const agent = new RetrievalAgent(repository as any, embedding as any, reranker as any)
    const output = await agent.search({ workspaceId: 'w', userId: 'u', role: 'viewer' }, { query: '编号 123', limit: 4, mode: 'hybrid' })
    expect(output.evidence.map(item => item.chunkId)).toEqual(['lexical'])
    expect(output.retrieval).toMatchObject({ mode: 'lexical', vectorCount: 0, lexicalCount: 1, failures: ['vector'] })
  })

  it('calls both candidate sources in hybrid mode before reranking', async () => {
    const repository = {
      searchLexical: vi.fn().mockResolvedValue([result('lexical', 0.8)]),
      searchVector: vi.fn().mockResolvedValue([result('vector', 0.9)]),
    }
    const embedding = { embed: vi.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] }) }
    const reranker = { rerank: vi.fn().mockResolvedValue({ results: [{ id: 'vector', score: 0.95 }] }) }
    const agent = new RetrievalAgent(repository as any, embedding as any, reranker as any)
    const output = await agent.search({ workspaceId: 'w', userId: 'u', role: 'viewer' }, { query: 'policy', limit: 4, mode: 'hybrid' })
    expect(repository.searchLexical).toHaveBeenCalledOnce()
    expect(repository.searchVector).toHaveBeenCalledOnce()
    expect(output.retrieval).toMatchObject({ mode: 'hybrid', vectorCount: 1, lexicalCount: 1, failures: [] })
    expect(reranker.rerank).toHaveBeenCalledOnce()
  })

  it('falls back to vector results when lexical search fails', async () => {
    const repository = {
      searchLexical: vi.fn().mockRejectedValue(new Error('lexical unavailable')),
      searchVector: vi.fn().mockResolvedValue([result('vector', 0.8)]),
    }
    const embedding = { embed: vi.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] }) }
    const reranker = { rerank: vi.fn().mockResolvedValue({ results: [{ id: 'vector', score: 0.95 }] }) }
    const agent = new RetrievalAgent(repository as any, embedding as any, reranker as any)
    const output = await agent.search({ workspaceId: 'w', userId: 'u', role: 'viewer' }, { query: 'login policy', limit: 4, mode: 'hybrid' })
    expect(output.evidence.map(item => item.chunkId)).toEqual(['vector'])
    expect(output.retrieval).toMatchObject({ mode: 'vector', vectorCount: 1, lexicalCount: 0, failures: ['lexical'] })
  })

  it('uses only vector search in vector mode', async () => {
    const repository = {
      searchLexical: vi.fn(),
      searchVector: vi.fn().mockResolvedValue([result('vector', 0.8)]),
    }
    const embedding = { embed: vi.fn().mockResolvedValue({ data: [{ embedding: [0.1] }] }) }
    const reranker = { rerank: vi.fn().mockResolvedValue({ results: [{ id: 'vector', score: 0.95 }] }) }
    const agent = new RetrievalAgent(repository as any, embedding as any, reranker as any)
    await agent.search({ workspaceId: 'w', userId: 'u', role: 'viewer' }, { query: 'login policy', limit: 4, mode: 'vector' })
    expect(repository.searchLexical).not.toHaveBeenCalled()
    expect(repository.searchVector).toHaveBeenCalledOnce()
  })

  it('returns no evidence when both hybrid sources fail', async () => {
    const repository = {
      searchLexical: vi.fn().mockRejectedValue(new Error('lexical unavailable')),
      searchVector: vi.fn().mockRejectedValue(new Error('vector unavailable')),
    }
    const embedding = { embed: vi.fn().mockRejectedValue(new Error('embedding unavailable')) }
    const reranker = { rerank: vi.fn() }
    const agent = new RetrievalAgent(repository as any, embedding as any, reranker as any)
    const output = await agent.search({ workspaceId: 'w', userId: 'u', role: 'viewer' }, { query: 'missing', limit: 4, mode: 'hybrid' })
    expect(output).toMatchObject({ evidence: [], sufficient: false, reason: 'no_evidence' })
    expect(reranker.rerank).not.toHaveBeenCalled()
  })

  it('filters document IDs before reranking', async () => {
    const repository = {
      searchLexical: vi.fn().mockResolvedValue([]),
      searchVector: vi.fn().mockResolvedValue([result('allowed', 0.8), { ...result('blocked', 0.9), documentId: 'blocked-document' }]),
    }
    const embedding = { embed: vi.fn().mockResolvedValue({ data: [{ embedding: [0.1] }] }) }
    const reranker = { rerank: vi.fn().mockResolvedValue({ results: [{ id: 'allowed', score: 0.95 }] }) }
    const agent = new RetrievalAgent(repository as any, embedding as any, reranker as any)
    await agent.search({ workspaceId: 'w', userId: 'u', role: 'viewer' }, { query: 'policy', documentIds: ['document-allowed'], limit: 4, mode: 'vector' })
    expect(reranker.rerank.mock.calls[0][1]).toEqual([{ id: 'allowed', content: 'content-allowed' }])
  })
})
