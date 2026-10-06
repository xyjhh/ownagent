export type ParsedSection = {
  headingPath: string[]
  text: string
  pageNumber?: number
  metadata?: Record<string, unknown>
}

export type ParsedDocument = {
  title?: string
  text: string
  sections: ParsedSection[]
  metadata: Record<string, unknown>
}

export type ParserOptions = { filename?: string; mimeType?: string }

export interface DocumentParser {
  supports(mimeType: string, filename: string): boolean
  parse(input: Buffer, options?: ParserOptions): Promise<ParsedDocument>
}

export class DocumentParseError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentParseError'
  }
}
