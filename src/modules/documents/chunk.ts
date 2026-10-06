import type { ParsedSection } from './parsers/types.js'

export type DocumentChunk = { index: number; content: string; headingPath: string[]; pageNumber?: number; charStart: number; charEnd: number; tokenCount: number; metadata: Record<string, unknown> }

export function chunkSections(sections: ParsedSection[], targetChars = 3_200, overlapChars = 400): DocumentChunk[] {
  const chunks: DocumentChunk[] = []; let index = 0; let cursor = 0
  for (const section of sections) {
    const text = section.text.trim(); if (!text) continue
    for (let start = 0; start < text.length; start += Math.max(1, targetChars - overlapChars)) {
      const content = text.slice(start, start + targetChars).trim(); if (!content) break
      const charStart = cursor + start; const charEnd = charStart + content.length
      chunks.push({ index: index++, content, headingPath: section.headingPath, pageNumber: section.pageNumber, charStart, charEnd, tokenCount: Math.ceil(content.length / 4), metadata: section.metadata ?? {} })
      if (start + targetChars >= text.length) break
    }
    cursor += text.length + 1
  }
  return chunks.length ? chunks : [{ index: 0, content: '', headingPath: [], charStart: 0, charEnd: 0, tokenCount: 0, metadata: {} }]
}
