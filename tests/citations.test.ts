import { describe, expect, it } from 'vitest'
import { selectCitationsFromAnswer } from '../src/agent/citations.js'

const citations = Array.from({ length: 4 }, (_, index) => ({
  documentId: `d${index + 1}`,
  versionId: `v${index + 1}`,
  chunkId: `c${index + 1}`,
  title: `Document ${index + 1}`,
}))

describe('selectCitationsFromAnswer', () => {
  it('selects referenced evidence and preserves reference numbers', () => {
    const result = selectCitationsFromAnswer('依据 [4] 和 [1]。', citations)
    expect(result.map(citation => citation.referenceIndex)).toEqual([1, 4])
    expect(result.map(citation => citation.chunkId)).toEqual(['c1', 'c4'])
  })

  it('deduplicates references and ignores invalid numbers', () => {
    const result = selectCitationsFromAnswer('依据 [2]、[2]、[0]、[9]。', citations)
    expect(result).toHaveLength(1)
    expect(result[0].chunkId).toBe('c2')
  })

  it('returns no citations when the answer has no valid reference', () => {
    expect(selectCitationsFromAnswer('没有引用。', citations)).toEqual([])
  })
})
