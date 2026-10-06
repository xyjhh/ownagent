import { describe, expect, it } from 'vitest'
import { createKnowledgeAgentGraph } from '../src/agent/graph.js'

describe('knowledge graph', () => {
  it('retrieves evidence, generates an answer and persists citations', async () => {
    const appended: any[] = []
    const graph = createKnowledgeAgentGraph(undefined, {
      retrieval: { search: async () => ({ sufficient: true, evidence: [{ documentId: 'd1', versionId: 'v1', chunkId: 'c1', title: 'Policy', content: 'Use SSO.', score: 0.9, metadata: {} }] }) } as any,
      conversations: { recent: async () => [], summary: async () => undefined, append: async (value: any) => { appended.push(value); return value } } as any,
      memories: { list: async () => [], create: async () => ({}) } as any,
      model: { streamChat: async function* () { yield 'Use SSO [1].' } } as any,
    })
    const result = await graph.invoke({ workspaceId: 'w1', userId: 'u1', runId: 'r1', conversationId: 'c0', input: 'What is the login policy?' })
    expect(result.answer).toContain('SSO')
    expect(appended[0].citations[0]).toMatchObject({ documentId: 'd1', versionId: 'v1', chunkId: 'c1' })
  })
})
