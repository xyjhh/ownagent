import { describe, expect, it } from 'vitest'
import {
  estimateConversationMessageTokens,
  estimateTextTokens,
  selectRecentMessagesByTokenBudget,
} from '../src/modules/conversations/token-window.js'

const message = (
  id: string,
  content: string,
  createdAt = `2026-01-01T00:0${id.slice(-1)}:00.000Z`
) => ({
  id,
  role: 'user' as const,
  content,
  citations: [],
  createdAt,
})

describe('conversation token window', () => {
  it('uses the configured tiktoken estimate', () => {
    expect(estimateTextTokens('你好')).toBe(2)
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(estimateTextTokens('你好 abcd')).toBe(4)
    expect(estimateTextTokens('かな')).toBe(2)
    expect(estimateTextTokens('한국')).toBe(3)
    expect(estimateTextTokens('😀')).toBe(2)
  })

  it('selects newest messages and returns them in chronological order', () => {
    const messages = [message('m1', '第一条'), message('m2', '第二条'), message('m3', '第三条')]
    const result = selectRecentMessagesByTokenBudget(
      messages,
      estimateConversationMessageTokens(messages[1]!)
    )
    expect(result.messages.at(-1)?.id).toBe('m3')
    expect(result.messages.length).toBeGreaterThanOrEqual(1)
    expect(result.messages.map(item => item.id)).toEqual(
      [...result.messages]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(item => item.id)
    )
    expect(result.truncated).toBe(true)
  })

  it('keeps and truncates an oversized latest message', () => {
    const latest = message('m2', '这是一条非常长的用户问题'.repeat(100))
    const result = selectRecentMessagesByTokenBudget([message('m1', '旧消息'), latest], 50)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.id).toBe('m2')
    expect(result.messages[0]?.content).toContain('内容已截断')
    expect(result.truncated).toBe(true)
  })

  it('counts citation metadata as part of the message window', () => {
    const withoutCitation = message('m1', '问题')
    const withCitation = { ...withoutCitation, citations: [{ title: '一份很长的引用来源标题' }] }
    expect(estimateConversationMessageTokens(withCitation)).toBeGreaterThan(
      estimateConversationMessageTokens(withoutCitation)
    )
  })
})
