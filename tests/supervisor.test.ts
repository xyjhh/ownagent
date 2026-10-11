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
  it('validates model output and falls back on low confidence or errors', async () => {
    const model = { chatJson: vi.fn().mockResolvedValue({ intent: 'knowledge_query', needsRetrieval: true, query: 'q', plan: ['search_knowledge', 'generate_answer'], requiresApproval: false, confidence: 0.9 }) }
    const supervisor = new SupervisorAgent(model as any)
    expect((await supervisor.classify('公司的报销政策是什么', { workspaceId: 'w', userId: 'u' })).decision.confidence).toBe(0.9)
    model.chatJson.mockResolvedValue({ intent: 'knowledge_query', needsRetrieval: true, plan: ['search_knowledge'], requiresApproval: false, confidence: 0.1 })
    expect((await supervisor.classify('未知问题', { workspaceId: 'w', userId: 'u' })).fallback).toBe(true)
    model.chatJson.mockRejectedValue(new Error('timeout'))
    expect((await supervisor.classify('另一个问题', { workspaceId: 'w', userId: 'u' })).decision).toEqual(fallbackDecision('另一个问题'))
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
})
