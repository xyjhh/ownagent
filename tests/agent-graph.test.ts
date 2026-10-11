import { describe, expect, it } from 'vitest'
import { createKnowledgeAgentGraph } from '../src/agent/graph.js'

describe('knowledge graph', () => {
  it('retrieves evidence, generates an answer and persists citations', async () => {
    const appended: any[] = []
    const deltas: string[] = []
    const graph = createKnowledgeAgentGraph(undefined, {
      retrieval: { search: async () => ({ sufficient: true, evidence: [{ documentId: 'd1', versionId: 'v1', chunkId: 'c1', title: 'Policy', content: 'Use SSO.', score: 0.9, metadata: {} }] }) } as any,
      conversations: { recent: async () => [], summary: async () => undefined, append: async (value: any) => { appended.push(value); return value } } as any,
      memories: { list: async () => [], create: async () => ({}) } as any,
      answerDeltaSink: () => ({ push: async (delta: string) => { deltas.push(delta) }, flush: async () => undefined }),
      model: { streamChat: async function* () { yield 'Use SSO [1].' } } as any,
    })
    const result = await graph.invoke({ workspaceId: 'w1', userId: 'u1', runId: 'r1', conversationId: 'c0', input: 'What is the login policy?' })
    expect(result.answer).toContain('SSO')
    expect(deltas).toEqual(['Use SSO [1].'])
    expect(appended[0].citations[0]).toMatchObject({ documentId: 'd1', versionId: 'v1', chunkId: 'c1' })
  })

  it('streams each model delta while persisting the complete answer', async () => {
    const deltas: string[] = []
    const appended: any[] = []
    const graph = createKnowledgeAgentGraph(undefined, {
      retrieval: { search: async () => ({ sufficient: true, evidence: [] }) } as any,
      supervisor: { classify: async () => ({ decision: { intent: 'knowledge_query', needsRetrieval: true, plan: ['search_knowledge', 'generate_answer'], requiresApproval: false, confidence: 1 }, fallback: false }) } as any,
      conversations: { recent: async () => [], summary: async () => undefined, append: async (value: any) => { appended.push(value); return value } } as any,
      memories: { list: async () => [] } as any,
      answerDeltaSink: () => ({ push: async (delta: string) => { deltas.push(delta) }, flush: async () => undefined }),
      model: { streamChat: async function* () { yield '第一段'; yield '第二段' } } as any,
    })

    const result = await graph.invoke({ workspaceId: 'w1', userId: 'u1', runId: 'r3', conversationId: 'c0', input: '请回答' })
    expect(deltas).toEqual(['第一段', '第二段'])
    expect(result.answer).toBe('第一段第二段')
    expect(appended.at(-1).content).toBe('第一段第二段')
  })

  it('routes greetings directly to the answer node without retrieval', async () => {
    let retrievalCalls = 0
    const graph = createKnowledgeAgentGraph(undefined, {
      retrieval: { search: async () => { retrievalCalls += 1; return { sufficient: true, evidence: [] } } } as any,
      supervisor: { classify: async () => ({
        decision: { intent: 'general_chat', needsRetrieval: false, plan: ['generate_answer'], requiresApproval: false, confidence: 1 },
        fallback: false,
      }) } as any,
      conversations: { recent: async () => [], summary: async () => undefined, append: async (value: any) => value } as any,
      memories: { list: async () => [] } as any,
      model: { streamChat: async function* () { yield '你好！' } } as any,
    })
    const result = await graph.invoke({ workspaceId: 'w1', userId: 'u1', runId: 'r2', conversationId: 'c0', input: '你好' })
    expect(result.answer).toBe('你好！')
    expect(retrievalCalls).toBe(0)
  })
})
