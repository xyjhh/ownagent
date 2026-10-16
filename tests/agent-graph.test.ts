import { describe, expect, it } from 'vitest'
import { Command, MemorySaver } from '@langchain/langgraph'
import { createKnowledgeAgentGraph } from '../src/agent/graph.js'
import { supervisorDecisionSchema } from '../src/agent/supervisor.js'

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

  it('persists only referenced evidence and preserves its original number', async () => {
    const appended: any[] = []
    const evidence = Array.from({ length: 4 }, (_, index) => ({
      documentId: `d${index + 1}`,
      versionId: `v${index + 1}`,
      chunkId: `c${index + 1}`,
      title: `Document ${index + 1}`,
      content: `Evidence ${index + 1}`,
      score: 0.9 - index / 10,
      metadata: {},
    }))
    const graph = createKnowledgeAgentGraph(undefined, {
      retrieval: { search: async () => ({ sufficient: true, evidence }) } as any,
      conversations: { recent: async () => [], summary: async () => undefined, append: async (value: any) => { appended.push(value); return value } } as any,
      memories: { list: async () => [] } as any,
      model: { streamChat: async function* () { yield '依据 [4] 和 [1] 回答。 [1]' } } as any,
    })

    await graph.invoke({ workspaceId: 'w1', userId: 'u1', runId: 'r4', conversationId: 'c0', input: '请回答' })

    expect(appended[0].citations).toHaveLength(2)
    expect(appended[0].citations.map((citation: any) => citation.referenceIndex)).toEqual([1, 4])
    expect(appended[0].citations.map((citation: any) => citation.chunkId)).toEqual(['c1', 'c4'])
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

  it('routes a preference-only input without retrieval and extracts the preference', async () => {
    let retrievalCalls = 0
    const memoryModelCalls: any[] = []
    const persistedCandidates: any[] = []
    const graph = createKnowledgeAgentGraph(undefined, {
      retrieval: { search: async () => { retrievalCalls += 1; return { sufficient: true, evidence: [] } } } as any,
      supervisor: { classify: async () => ({
        decision: { intent: 'preference_update', needsRetrieval: true, plan: ['search_knowledge', 'generate_answer'], requiresApproval: false, confidence: 0.3, containsUserPreference: true, preferenceOnly: true },
        fallback: false,
      }) } as any,
      conversations: { recent: async () => [], summary: async () => undefined, append: async (value: any) => value } as any,
      memories: { list: async () => [], create: async (value: any) => { persistedCandidates.push(value); return {} } } as any,
      model: {
        streamChat: async function* () { yield '好的，后续示例会优先使用 TypeScript。' },
        chatJson: async (messages: any[]) => {
          memoryModelCalls.push(messages)
          return { candidates: [{ scope: 'user', type: 'preference', key: 'answer_language', value: { language: 'TypeScript' }, summary: '示例优先使用 TypeScript', confidence: 0.95, sensitivity: 'normal', autoSave: true }] }
        },
      } as any,
    })
    const result = await graph.invoke({ workspaceId: 'w1', userId: 'u1', runId: 'r-pref', input: '我主要用 TypeScript，示例尽量用 TypeScript' })
    expect(retrievalCalls).toBe(0)
    expect(result.answer).toContain('TypeScript')
    expect(memoryModelCalls).toHaveLength(1)
    expect(persistedCandidates).toHaveLength(1)
    expect(persistedCandidates[0]).toMatchObject({ key: 'answer_language', status: 'active' })
  })

  it('extracts explicit preferences from mixed knowledge questions while still retrieving', async () => {
    let retrievalCalls = 0
    let memoryCalls = 0
    const graph = createKnowledgeAgentGraph(undefined, {
      retrieval: { search: async () => { retrievalCalls += 1; return { sufficient: true, evidence: [] } } } as any,
      supervisor: { classify: async () => ({
        decision: { intent: 'knowledge_query', needsRetrieval: true, plan: ['search_knowledge', 'generate_answer'], requiresApproval: false, confidence: 0.95, containsUserPreference: true, preferenceOnly: false },
        fallback: false,
      }) } as any,
      conversations: { recent: async () => [], summary: async () => undefined, append: async (value: any) => value } as any,
      memories: { list: async () => [], create: async () => ({}) } as any,
      model: {
        streamChat: async function* () { yield '这是文档说明。' },
        chatJson: async () => { memoryCalls += 1; return { candidates: [] } },
      } as any,
    })
    await graph.invoke({ workspaceId: 'w1', userId: 'u1', runId: 'r-mixed', input: '我主要用 TypeScript，请解释这份文档中的实现' })
    expect(retrievalCalls).toBe(1)
    expect(memoryCalls).toBe(1)
  })

  it('runs memory extraction for ordinary general chat and tolerates memory extraction failures', async () => {
    let memoryCalls = 0
    let chatMessages: any[] = []
    const graph = createKnowledgeAgentGraph(undefined, {
      supervisor: { classify: async () => ({
        decision: { intent: 'general_chat', needsRetrieval: false, plan: ['generate_answer'], requiresApproval: false, confidence: 1 },
        fallback: false,
      }) } as any,
      conversations: { recent: async () => [], summary: async () => undefined, append: async (value: any) => value } as any,
      memories: { list: async () => [{ type: 'preference', sensitivity: 'normal', summary: '示例优先使用 TypeScript' }], create: async () => ({}) } as any,
      model: {
        streamChat: async function* (messages: any[]) { chatMessages = messages; yield '你好！' },
        chatJson: async () => { memoryCalls += 1; throw new Error('memory model unavailable') },
      } as any,
    })
    const result = await graph.invoke({ workspaceId: 'w1', userId: 'u1', runId: 'r-chat', input: '你好' })
    expect(result.answer).toBe('你好！')
    expect(memoryCalls).toBe(1)
    expect(chatMessages[0].content).toContain('示例优先使用 TypeScript')
  })

  it('waits for clarification before retrieval and replans after the user responds', async () => {
    const saver = new MemorySaver()
    let classifyCalls = 0
    let retrievalCalls = 0
    const graph = createKnowledgeAgentGraph(saver, {
      retrieval: { search: async () => { retrievalCalls += 1; return { sufficient: true, evidence: [] } } } as any,
      supervisor: {
        classify: async () => {
          classifyCalls += 1
          return classifyCalls === 1
            ? { decision: { intent: 'knowledge_query', needsRetrieval: false, plan: ['generate_answer'], requiresApproval: false, confidence: 0.95, needsClarification: true, clarificationQuestion: '你想了解哪一类信息？', clarificationOptions: ['期望薪资', '岗位职责'] }, fallback: false }
            : { decision: { intent: 'knowledge_query', needsRetrieval: true, plan: ['search_knowledge', 'generate_answer'], requiresApproval: false, confidence: 0.95, needsClarification: false }, fallback: false }
        },
      } as any,
      conversations: { recent: async () => [], summary: async () => undefined, append: async (value: any) => value } as any,
      memories: { list: async () => [] } as any,
      model: { streamChat: async function* () { yield '已根据补充信息回答。' } } as any,
    })
    const config = { configurable: { thread_id: 'clarification-thread' } }
    const firstChunks: any[] = []
    for await (const chunk of await graph.stream({ workspaceId: 'w1', userId: 'u1', runId: 'r5', conversationId: 'c0', input: '我想了解这份简历' }, config, { streamMode: 'updates' })) firstChunks.push(chunk)
    const interrupt = firstChunks.find(chunk => chunk.__interrupt__)
    expect(interrupt?.__interrupt__?.[0]?.value).toMatchObject({ kind: 'question', options: ['期望薪资', '岗位职责'] })
    expect(retrievalCalls).toBe(0)

    const secondChunks: any[] = []
    for await (const chunk of await graph.stream(new Command({ resume: '期望薪资' }), config, { streamMode: 'updates' })) secondChunks.push(chunk)
    expect(classifyCalls).toBe(2)
    expect(retrievalCalls).toBe(1)
    expect(secondChunks.some(chunk => chunk.persist_response)).toBe(true)
  })

  it('uses a safe clarification prompt when the model returns an empty question', async () => {
    const saver = new MemorySaver()
    let retrievalCalls = 0
    const decision = supervisorDecisionSchema.parse({
      intent: 'knowledge_query',
      needsRetrieval: true,
      plan: ['search_knowledge', 'generate_answer'],
      requiresApproval: false,
      confidence: 0.9,
      needsClarification: true,
      clarificationQuestion: '',
    })
    const graph = createKnowledgeAgentGraph(saver, {
      retrieval: { search: async () => { retrievalCalls += 1; return { sufficient: true, evidence: [] } } } as any,
      supervisor: { classify: async () => ({ decision, fallback: false }) } as any,
      conversations: { recent: async () => [], summary: async () => undefined, append: async (value: any) => value } as any,
      memories: { list: async () => [] } as any,
    })

    const chunks: any[] = []
    for await (const chunk of await graph.stream(
      { workspaceId: 'w1', userId: 'u1', runId: 'r-clarification-empty', input: '帮我分析一下这份资料' },
      { configurable: { thread_id: 'clarification-empty-thread' } },
      { streamMode: 'updates' },
    )) chunks.push(chunk)

    const interrupt = chunks.find(chunk => chunk.__interrupt__)
    expect(interrupt?.__interrupt__?.[0]?.value).toMatchObject({
      kind: 'question',
      question: '请补充你希望重点了解或分析的内容。',
    })
    expect(retrievalCalls).toBe(0)
  })
})
