import { describe, expect, it } from 'vitest'
import {
  estimateSummaryMessageTokens,
  estimateSummaryTokens,
  limitSummaryTokens,
  summaryPrompt,
  takeSummaryBatch,
} from '../src/modules/memory/conversation-summary.js'

const message = (id: string, content: string) => ({
  id,
  role: 'user' as const,
  content,
  createdAt: '2026-01-01T00:00:00.000Z',
  citations: [],
})

describe('conversation summary batching', () => {
  it('uses a stable conservative estimate for mixed Chinese and Latin text', () => {
    expect(estimateSummaryTokens('你好')).toBe(2)
    expect(estimateSummaryTokens('abcd')).toBe(1)
    expect(estimateSummaryTokens('你好 abcd')).toBe(3)
    expect(estimateSummaryMessageTokens(message('m1', '你好 abcd'))).toBeGreaterThan(3)
  })

  it('does not classify Japanese kana or Korean characters as Chinese', () => {
    expect(estimateSummaryTokens('かな')).toBe(2)
    expect(estimateSummaryTokens('한국')).toBe(2)
  })

  it('splits messages in chronological order and always includes one message', () => {
    const messages = [message('m1', '第一条'), message('m2', '第二条'), message('m3', '第三条')]
    const first = takeSummaryBatch(messages, '', 205)
    expect(first.batch.map(item => item.id)).toEqual(['m1', 'm2'])
    expect(first.remaining.map(item => item.id)).toEqual(['m3'])
    const second = takeSummaryBatch(first.remaining, '已有摘要', 205)
    expect(second.batch.map(item => item.id)).toEqual(['m3'])
  })

  it('does not create a batch for an empty delta', () => {
    expect(takeSummaryBatch([], '已有摘要', 6000)).toMatchObject({ batch: [], remaining: [] })
  })

  it('limits oversized summaries without returning an empty string', () => {
    const summary = limitSummaryTokens('第一段。第二段。第三段。', 4)
    expect(summary.length).toBeGreaterThan(0)
    expect(estimateSummaryTokens(summary)).toBeLessThanOrEqual(4)
  })

  it('serializes the previous summary and new messages for the merge prompt', () => {
    const prompt = summaryPrompt('旧摘要', [message('m1', '新增消息')])
    expect(JSON.parse(prompt)).toMatchObject({
      previousSummary: '旧摘要',
      newMessages: [{ role: 'user', content: '新增消息' }],
    })
  })
})
