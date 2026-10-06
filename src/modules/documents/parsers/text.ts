import type { DocumentParser, ParsedDocument } from './types.js'

export class TextParser implements DocumentParser {
  supports(mimeType: string, filename: string) {
    return mimeType === 'text/plain' || /\.txt$/i.test(filename)
  }
  async parse(input: Buffer): Promise<ParsedDocument> {
    const text = input.toString('utf8').replace(/\r\n?/g, '\n').trim()
    return { text, sections: [{ headingPath: [], text }], metadata: {} }
  }
}
