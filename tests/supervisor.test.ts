import { describe, expect, it, vi } from 'vitest'
import { SupervisorAgent, fallbackDecision, supervisorDecisionSchema } from '../src/agent/supervisor.js'

describe('SupervisorAgent', () => {
  it('uses protocol checks only for controls and lets the model classify greetings', async () => {
    const model = { chatJson: vi.fn().mockResolvedValue({ intent: 'general_chat', needsRetrieval: false, plan: ['generate_answer'], requiresApproval: false, confidence: 0.99 }) }
    const supervisor = new SupervisorAgent(model as any)
    expect((await supervisor.classify('你好', { workspaceId: 'w', userId: 'u' })).decision.intent).toBe('general_chat')
    expect(model.chatJson).toHaveBeenCalledTimes(1)
    expect((await supervisor.classify('approve: deploy', { workspaceId: 'w', userId: 'u' })).decision.requiresApproval).toBe(true)
    expect(model.chatJson).toHaveBeenCalledTimes(1)
  })
  it('keeps model decisions with low confidence and falls back only on errors', async () => {
    const model = { chatJson: vi.fn().mockResolvedValue({ intent: 'knowledge_query', needsRetrieval: true, query: 'q', plan: ['search_knowledge', 'generate_answer'], requiresApproval: false, confidence: 0.9 }) }
    const supervisor = new SupervisorAgent(model as any)
    expect((await supervisor.classify('公司的报销政策是什么', { workspaceId: 'w', userId: 'u' })).decision.confidence).toBe(0.9)
    model.chatJson.mockResolvedValue({ intent: 'knowledge_query', needsRetrieval: true, plan: ['search_knowledge'], requiresApproval: false, confidence: 0.1 })
    expect((await supervisor.classify('未知问题', { workspaceId: 'w', userId: 'u' })).fallback).toBe(false)
    model.chatJson.mockRejectedValue(new Error('timeout'))
    expect((await supervisor.classify('另一个问题', { workspaceId: 'w', userId: 'u' })).decision).toEqual(fallbackDecision('另一个问题'))
  })

  it('passes bounded conversation context so the model can resolve a unique reference', async () => {
    const model = { chatJson: vi.fn().mockResolvedValue({
      intent: 'knowledge_query',
      needsRetrieval: true,
      query: '许永进有几年工作经验',
      plan: ['search_knowledge', 'generate_answer'],
      requiresApproval: false,
      confidence: 0.95,
      needsClarification: false,
    }) }
    const supervisor = new SupervisorAgent(model as any)
    const result = await supervisor.classify('他有几年工作经验', {
      workspaceId: 'w',
      userId: 'u',
      conversationSummary: '当前讨论许永进的前端工程师简历。',
      recentMessages: [
        { role: 'user', content: '徐永进是谁' },
        { role: 'assistant', content: '证据中的姓名是许永进，具备 2 年开发经验', citations: [{ title: '许永进-前端工程师-简历' }] },
      ],
    })
    const payload = JSON.parse(model.chatJson.mock.calls[0][0][1].content)
    expect(result.decision.needsClarification).toBe(false)
    expect(result.decision.query).toContain('许永进')
    expect(payload.conversationSummary).toContain('许永进')
    expect(payload.recentMessages).toHaveLength(2)
    expect(payload.recentMessages[1].citations[0].title).toBe('许永进-前端工程师-简历')
  })

  it('normalizes safe model aliases before strict validation', () => {
    expect(supervisorDecisionSchema.parse({
      intent: 'qa',
      needsRetrieval: 'true',
      plan: ['retrieve', 'answer'],
      requiresApproval: 'false',
      confidence: '0.9',
      query: null,
      reason: null,
    })).toMatchObject({
      intent: 'knowledge_query',
      needsRetrieval: true,
      plan: ['search_knowledge', 'generate_answer'],
      requiresApproval: false,
      confidence: 0.9,
    })
  })

  it('accepts a structured clarification decision and defaults old outputs to no clarification', () => {
    expect(supervisorDecisionSchema.parse({
      intent: 'knowledge_query',
      needsRetrieval: false,
      plan: ['generate_answer'],
      requiresApproval: false,
      confidence: 0.92,
      needsClarification: true,
      clarificationQuestion: '你想了解哪一类信息？',
      clarificationOptions: ['岗位职责', '期望薪资', '岗位职责'],
    })).toMatchObject({
      needsClarification: true,
      clarificationOptions: ['岗位职责', '期望薪资'],
    })
    expect(supervisorDecisionSchema.parse({
      intent: 'general_chat',
      needsRetrieval: false,
      plan: ['generate_answer'],
      requiresApproval: false,
      confidence: 1,
    }).needsClarification).toBe(false)
    expect(supervisorDecisionSchema.parse({
      intent: 'knowledge_query',
      needsRetrieval: false,
      plan: ['generate_answer'],
      requiresApproval: false,
      confidence: 0.9,
      needsClarification: true,
    })).toMatchObject({
      needsClarification: true,
      clarificationQuestion: '请补充你希望重点了解或分析的内容。',
    })
  })

  it('keeps clarification pauses when the model returns an empty question', () => {
    expect(supervisorDecisionSchema.parse({
      intent: 'knowledge_query',
      needsRetrieval: true,
      plan: ['search_knowledge', 'generate_answer'],
      requiresApproval: false,
      confidence: 0.9,
      needsClarification: true,
      clarificationQuestion: '   ',
      clarificationOptions: ['岗位职责', '', ' 岗位职责 '],
    })).toMatchObject({
      needsClarification: true,
      clarificationQuestion: '请补充你希望重点了解或分析的内容。',
      clarificationOptions: ['岗位职责'],
    })
  })

  it('drops an empty clarification question when clarification is not needed', () => {
    expect(supervisorDecisionSchema.parse({
      intent: 'general_chat',
      needsRetrieval: false,
      plan: ['generate_answer'],
      requiresApproval: false,
      confidence: 0.9,
      needsClarification: false,
      clarificationQuestion: '   ',
    })).not.toHaveProperty('clarificationQuestion')
  })

  it('normalizes preference-only decisions into a non-retrieval route', () => {
    expect(supervisorDecisionSchema.parse({
      intent: 'general_chat',
      needsRetrieval: true,
      plan: ['search_knowledge', 'generate_answer'],
      requiresApproval: false,
      confidence: 0.2,
      containsUserPreference: true,
      preferenceOnly: true,
    })).toMatchObject({
      intent: 'preference_update',
      needsRetrieval: false,
      plan: ['generate_answer'],
      containsUserPreference: true,
      preferenceOnly: true,
    })
  })

  it('does not replace an explicit preference-only decision with low-confidence retrieval fallback', async () => {
    const model = { chatJson: vi.fn().mockResolvedValue({
      intent: 'preference_update',
      needsRetrieval: false,
      plan: ['generate_answer'],
      requiresApproval: false,
      confidence: 0.2,
      containsUserPreference: true,
      preferenceOnly: true,
    }) }
    const supervisor = new SupervisorAgent(model as any)
    const result = await supervisor.classify('我主要用 TypeScript，示例尽量用 TypeScript', { workspaceId: 'w', userId: 'u' })
    expect(result.fallback).toBe(false)
    expect(result.decision.intent).toBe('preference_update')
    expect(result.decision.needsRetrieval).toBe(false)
  })
})
