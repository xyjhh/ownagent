export const workspaceRoles = ['owner', 'admin', 'editor', 'viewer'] as const
export type WorkspaceRole = (typeof workspaceRoles)[number]

export type WorkspaceContext = { userId: string; workspaceId: string; role: WorkspaceRole }
export type Workspace = { id: string; name: string; slug: string; createdBy: string; createdAt: string }
export type WorkspaceMembership = WorkspaceContext & { joinedAt: string; workspace?: Workspace }
