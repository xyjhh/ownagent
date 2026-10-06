import type { DocumentParser, ParsedDocument, ParsedSection } from './types.js'

export class MarkdownParser implements DocumentParser {
  supports(mimeType: string, filename: string) {
    return mimeType === 'text/markdown' || /\.(md|markdown)$/i.test(filename)
  }
  async parse(input: Buffer): Promise<ParsedDocument> {
    const text = input.toString('utf8').replace(/\r\n?/g, '\n').trim()
    const sections: ParsedSection[] = []
    const headings: string[] = []
    let buffer: string[] = []
    const flush = () => { const value = buffer.join('\n').trim(); if (value) sections.push({ headingPath: [...headings], text: value }); buffer = [] }
    for (const line of text.split('\n')) {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
      if (!match) { buffer.push(line); continue }
      flush(); const level = match[1].length; headings.splice(level - 1); headings[level - 1] = match[2]
    }
    flush()
    return { title: sections[0]?.headingPath[0], text, sections: sections.length ? sections : [{ headingPath: [], text }], metadata: {} }
  }
}
