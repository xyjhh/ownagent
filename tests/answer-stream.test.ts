import { describe, expect, it } from 'vitest'
import { AnswerDeltaBatcher } from '../src/agent/answer-stream.js'

describe('AnswerDeltaBatcher', () => {
  it('batches deltas and flushes the remaining buffer', async () => {
    const emitted: string[] = []
    const batcher = new AnswerDeltaBatcher(async delta => { emitted.push(delta) }, { intervalMs: 1000 })

    await batcher.push('答')
    await batcher.push('案')
    expect(emitted).toEqual([])
    await batcher.flush()
    expect(emitted).toEqual(['答案'])
  })

  it('flushes immediately at the character threshold and isolates runs', async () => {
    const first: string[] = []
    const second: string[] = []
    const a = new AnswerDeltaBatcher(async delta => { first.push(delta) }, { maxChars: 3, intervalMs: 1000 })
    const b = new AnswerDeltaBatcher(async delta => { second.push(delta) }, { maxChars: 3, intervalMs: 1000 })

    await a.push('abc')
    await b.push('xy')
    expect(first).toEqual(['abc'])
    expect(second).toEqual([])
    await b.flush()
    expect(second).toEqual(['xy'])
  })

  it('does not emit empty deltas', async () => {
    const emitted: string[] = []
    const batcher = new AnswerDeltaBatcher(async delta => { emitted.push(delta) })
    await batcher.push('')
    await batcher.flush()
    expect(emitted).toEqual([])
  })
})
