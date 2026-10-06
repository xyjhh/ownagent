import mammoth from 'mammoth'
import type { DocumentParser, ParsedDocument } from './types.js'
import { DocumentParseError } from './types.js'

export class DocxParser implements DocumentParser {
  supports(mimeType: string, filename: string) { return mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(filename) }
  async parse(input: Buffer): Promise<ParsedDocument> {
    try {
      const result = await mammoth.extractRawText({ buffer: input })
      const text = result.value.replace(/\r\n?/g, '\n').trim()
      return { text, sections: [{ headingPath: [], text }], metadata: { warnings: result.messages } }
    } catch (error) { throw new DocumentParseError('FILE_CORRUPTED', 'DOCX parsing failed', { cause: error }) }
  }
}
