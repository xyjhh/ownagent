import { DocxParser } from './docx.js'
import { MarkdownParser } from './markdown.js'
import { PdfParser } from './pdf.js'
import { TextParser } from './text.js'
import { DocumentParseError, type DocumentParser } from './types.js'

export const documentParsers: DocumentParser[] = [new PdfParser(), new DocxParser(), new MarkdownParser(), new TextParser()]
export function parserFor(mimeType: string, filename: string) {
  const parser = documentParsers.find(item => item.supports(mimeType, filename))
  if (!parser) throw new DocumentParseError('UNSUPPORTED_FILE_TYPE', `Unsupported document type: ${mimeType}`)
  return parser
}
export * from './types.js'
