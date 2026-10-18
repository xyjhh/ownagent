export type ReferencedCitation = {
  documentId: string
  versionId: string
  chunkId: string
  title: string
  pageNumber?: number
  headingPath?: string[]
  quote?: string
  referenceIndex?: number
}

/**
 * Select only the evidence references explicitly used in a generated answer.
 * The returned referenceIndex preserves the number shown to the user.
 */
export function selectCitationsFromAnswer<T extends ReferencedCitation>(
  answer: string,
  citations: T[]
): Array<T & { referenceIndex: number }> {
  const indexes = new Set<number>()
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const index = Number(match[1])
    if (Number.isInteger(index) && index >= 1 && index <= citations.length) indexes.add(index)
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map(index => ({ ...citations[index - 1], referenceIndex: index }))
}
