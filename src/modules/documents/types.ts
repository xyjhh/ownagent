import type { WorkspaceContext } from '../workspaces/types.js'

export type DocumentVisibility = 'workspace' | 'private'
export type AuthorizedDocument = { id: string; title: string; content: string; visibility: DocumentVisibility; metadata: Record<string, unknown>; createdAt: string }
export type SearchResult = { chunkId: string; documentId: string; title: string; content: string; metadata: Record<string, unknown>; score: number; rerankScore?: number }
export type DocumentContext = WorkspaceContext
