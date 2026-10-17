import { describe, expect, it } from 'vitest'
import { ConversationRepository } from '../src/modules/conversations/repository.js'

class QueryBuilder implements PromiseLike<{ data: any; error: null }> {
  private selectedRows: Record<string, unknown>[]
  private filters: Array<(row: Record<string, unknown>) => boolean> = []

  constructor(rows: Record<string, unknown>[]) {
    this.selectedRows = [...rows]
  }

  select() { return this }
  eq(field: string, value: unknown) { this.filters.push(row => row[field] === value); return this }
  gte(field: string, value: string) { this.filters.push(row => String(row[field]) >= value); return this }
  order(field: string, options: { ascending: boolean }) {
    this.selectedRows.sort((left, right) => {
      const comparison = String(left[field]).localeCompare(String(right[field]))
      return options.ascending ? comparison : -comparison
    })
    return this
  }
  limit(value: number) { this.selectedRows = this.selectedRows.slice(0, value); return this }
  private result() {
    const rows = this.selectedRows.filter(row => this.filters.every(filter => filter(row)))
    return { data: rows, error: null as null }
  }
  maybeSingle() { return Promise.resolve(this.result()).then(result => ({ data: result.data[0] ?? null, error: result.error })) }
  then<TResult1 = { data: any; error: null }, TResult2 = never>(onfulfilled?: ((value: { data: any; error: null }) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null) {
    return Promise.resolve(this.result()).then(onfulfilled, onrejected)
  }
}

describe('conversation summary repository reads', () => {
  const rows = [
    { id: 'm1', conversation_id: 'c1', role: 'user', content: '第一条', citations: [], created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'm2', conversation_id: 'c1', role: 'assistant', content: '第二条', citations: [{ title: '简历' }], created_at: '2026-01-01T00:01:00.000Z' },
    { id: 'm3', conversation_id: 'c1', role: 'user', content: '第三条', citations: [], created_at: '2026-01-01T00:02:00.000Z' },
  ]

  it('reads the full summary record and keeps summary() compatible', async () => {
    const db = { from: (table: string) => new QueryBuilder(table === 'conversation_summaries' ? [{
      summary: '旧摘要', covered_until_message_id: 'm1', model: 'deepseek-chat', prompt_version: 'memory-worker-v1', updated_at: '2026-01-01T00:03:00.000Z', conversation_id: 'c1',
    }] : []) }
    const repository = new ConversationRepository(db as any)
    await expect(repository.summary('c1')).resolves.toBe('旧摘要')
    await expect(repository.summaryRecord('c1')).resolves.toMatchObject({ summary: '旧摘要', coveredUntilMessageId: 'm1', promptVersion: 'memory-worker-v1' })
  })

  it('returns only messages after the covered checkpoint in chronological order', async () => {
    const db = { from: (table: string) => new QueryBuilder(table === 'conversation_messages' ? rows : []) }
    const repository = new ConversationRepository(db as any)
    await expect(repository.summaryMessages('c1', 'm1')).resolves.toMatchObject([
      { id: 'm2', content: '第二条' },
      { id: 'm3', content: '第三条' },
    ])
    await expect(repository.summaryMessages('c1', 'missing')).resolves.toBeUndefined()
  })
})
