import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '../src/modules/conversations/repository.js'
import { fallbackConversationTitle, normalizeConversationTitle, titlePrompt } from '../src/modules/conversations/title.js'

const messages = (content: string): ConversationMessage[] => [
  { id: '1', role: 'user', content, citations: [], createdAt: '' },
  { id: '2', role: 'assistant', content: '回答', citations: [], createdAt: '' },
]

describe('conversation titles', () => {
  it('normalizes model output and removes title decoration', () => {
    expect(normalizeConversationTitle('标题：**团队发布流程**。', '备用')).toBe('团队发布流程。')
  })

  it('falls back to the first user question', () => {
    expect(fallbackConversationTitle(messages('如何设计一个可观测的发布流程？'))).toBe('如何设计一个可观测的发布流程？')
  })

  it('serializes only conversation roles and content for the title prompt', () => {
    expect(titlePrompt(messages('Explain the auth flow'))).toContain('Explain the auth flow')
    expect(titlePrompt(messages('Explain the auth flow'))).not.toContain('createdAt')
  })
})
