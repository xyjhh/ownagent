import type { WorkspaceContext } from '../workspaces/types.js'

export type DocumentVisibility = 'workspace' | 'private'
export type AuthorizedDocument = {
  id: string
  title: string
  content: string
  visibility: DocumentVisibility
  metadata: Record<string, unknown>
  createdAt: string
}
export type SearchResult = {
  chunkId: string
  documentId: string
  title: string
  content: string
  metadata: Record<string, unknown>
  score: number
  rerankScore?: number
  versionId?: string
  pageNumber?: number
  headingPath?: string[]
}
export type Evidence = {
  documentId: string
  versionId: string
  chunkId: string
  title: string
  content: string
  score: number
  pageNumber?: number
  headingPath?: string[]
  metadata: Record<string, unknown>
}
export type DocumentContext = WorkspaceContext
export type DocumentReadResult = {
  documentId: string
  versionId: string
  title: string
  content: string
  chunks: Array<Pick<Evidence, 'chunkId' | 'content' | 'pageNumber' | 'headingPath' | 'metadata'> & { charStart?: number; charEnd?: number }>
}
export type ComparisonSource = DocumentReadResult
