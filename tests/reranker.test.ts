import { afterEach, describe, expect, it, vi } from 'vitest'
import { RerankerClient } from '../src/integrations/reranker.js'

afterEach(() => vi.restoreAllMocks())

describe('DashScope reranker client', () => {
  it('sends DashScope input and maps result indexes back to document ids', async () => {
    const body = {
      output: { results: [
        { index: 1, relevance_score: 0.93 },
        { index: 0, relevance_score: 0.41 },
      ] },
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = new RerankerClient({
      DASHSCOPE_API_KEY: 'test-key',
      DASHSCOPE_RERANK_URL: 'https://dashscope.example/rerank',
      RERANK_MODEL: 'qwen3.7-text-rerank',
      RERANK_INSTRUCT: 'retrieve relevant passages',
      MODEL_TIMEOUT_MS: 1000,
    } as any)

    await expect(client.rerank('query', [
      { id: 'first', content: 'first content' },
      { id: 'second', content: 'second content' },
    ], 1)).resolves.toEqual({ results: [
      { id: 'second', score: 0.93 },
    ] })
    const request = fetchMock.mock.calls[0]![1] as RequestInit
    expect(fetchMock.mock.calls[0]![0]).toBe('https://dashscope.example/rerank')
    expect(request.headers).toMatchObject({ authorization: 'Bearer test-key' })
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: 'qwen3.7-text-rerank',
      input: { query: 'query', documents: ['first content', 'second content'] },
      parameters: { top_n: 1, instruct: 'retrieve relevant passages' },
    })
  })

  it('returns an empty result without calling the API for no candidates', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const client = new RerankerClient({ DASHSCOPE_API_KEY: 'test-key' } as any)
    await expect(client.rerank('query', [])).resolves.toEqual({ results: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
