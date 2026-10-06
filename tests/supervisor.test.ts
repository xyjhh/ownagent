import { describe, expect, it, vi } from 'vitest'
import { SupervisorAgent, fallbackDecision } from '../src/agent/supervisor.js'

describe('SupervisorAgent', () => {
  it('uses rules for controls and greetings without calling the model', async () => {
    const model = { chatJson: vi.fn() }
    const supervisor = new SupervisorAgent(model as any)
    expect((await supervisor.classify('你好', { workspaceId: 'w', userId: 'u' })).decision.intent).toBe('general_chat')
    expect((await supervisor.classify('approve: deploy', { workspaceId: 'w', userId: 'u' })).decision.requiresApproval).toBe(true)
    expect(model.chatJson).not.toHaveBeenCalled()
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
})
