import type { DocumentRepository } from '../../modules/documents/repository.js'
import type { ComparisonSource, DocumentContext, DocumentReadResult } from '../../modules/documents/types.js'

/** Deterministic, permission-checked document tools used by semantic Graph nodes. */
export class DocumentTools {
  constructor(private readonly repository: DocumentRepository) {}
  getDocument(context: DocumentContext, documentId: string, versionId?: string): Promise<DocumentReadResult> { return this.repository.getAuthorized(context, documentId, versionId) }
  compareDocumentSources(context: DocumentContext, documentIds: string[], _query?: string): Promise<ComparisonSource[]> { return this.repository.getComparisonSources(context, documentIds) }
}
