import { PDFParse } from 'pdf-parse'
import type { DocumentParser, ParsedDocument } from './types.js'
import { DocumentParseError } from './types.js'

export class PdfParser implements DocumentParser {
  supports(mimeType: string, filename: string) { return mimeType === 'application/pdf' || /\.pdf$/i.test(filename) }
  async parse(input: Buffer): Promise<ParsedDocument> {
    try {
      const parser = new PDFParse({ data: input })
      const result = await parser.getText()
      await parser.destroy()
      const text = String(result.text ?? '').replace(/\r\n?/g, '\n').trim()
      return { text, sections: [{ headingPath: [], text, pageNumber: 1 }], metadata: { pages: result.total } }
    } catch (error) { throw new DocumentParseError('FILE_CORRUPTED', 'PDF parsing failed', { cause: error }) }
  }
}
