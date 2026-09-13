import type { SupabaseClient } from '@supabase/supabase-js'
import type { Workspace, WorkspaceMembership, WorkspaceRole } from './types.js'

function fail(error: { message?: string } | null, operation: string): never {
  throw new Error(`Supabase ${operation} failed: ${error?.message ?? 'unknown error'}`)
}

export class WorkspaceRepository {
  constructor(private readonly db: SupabaseClient) {}

  async listForUser(userId: string): Promise<WorkspaceMembership[]> {
    const { data, error } = await this.db
      .from('workspace_members')
      .select('workspace_id,role,joined_at,workspaces(id,name,slug,created_by,created_at)')
      .eq('user_id', userId)
      .eq('status', 'active')
    if (error) fail(error, 'workspace listing')
    return (data ?? []).map(row => {
      const w = row.workspaces as unknown as Record<string, unknown> | null
      return {
        userId,
        workspaceId: String(row.workspace_id),
        role: String(row.role) as WorkspaceRole,
        joinedAt: String(row.joined_at),
        workspace: w
          ? {
              id: String(w.id),
              name: String(w.name),
              slug: String(w.slug),
              createdBy: String(w.created_by),
              createdAt: String(w.created_at),
            }
          : undefined,
      }
    })
  }

  async findMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | null> {
    const { data, error } = await this.db
      .from('workspace_members')
      .select('workspace_id,role,joined_at')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .maybeSingle()
    if (error) fail(error, 'membership lookup')
    return data
      ? {
          userId,
          workspaceId: String(data.workspace_id),
          role: String(data.role) as WorkspaceRole,
          joinedAt: String(data.joined_at),
        }
      : null
  }

  async create(userId: string, name: string, slug: string): Promise<Workspace> {
    const { data, error } = await this.db
      .from('workspaces')
      .insert({ name, slug, created_by: userId })
      .select('id,name,slug,created_by,created_at')
      .single()
    if (error) fail(error, 'workspace creation')
    const { error: membershipError } = await this.db
      .from('workspace_members')
      .insert({ workspace_id: data.id, user_id: userId, role: 'owner', status: 'active' })
    if (membershipError) fail(membershipError, 'workspace owner membership creation')
    return {
      id: String(data.id),
      name: String(data.name),
      slug: String(data.slug),
      createdBy: String(data.created_by),
      createdAt: String(data.created_at),
    }
  }

  async createInvite(input: {
    workspaceId: string
    invitedBy: string
    email: string
    role: WorkspaceRole
    tokenHash: string
    expiresAt: string
  }) {
    const { data, error } = await this.db
      .from('workspace_invites')
      .insert({
        workspace_id: input.workspaceId,
        invited_by: input.invitedBy,
        email: input.email,
        role: input.role,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt,
      })
      .select('id,expires_at')
      .single()
    if (error) fail(error, 'workspace invite creation')
    return { id: String(data.id), expiresAt: String(data.expires_at) }
  }

  async findInvite(tokenHash: string) {
    const { data, error } = await this.db
      .from('workspace_invites')
      .select('*')
      .eq('token_hash', tokenHash)
      .maybeSingle()
    if (error) fail(error, 'workspace invite lookup')
    return data
  }

  async acceptInvite(
    invite: { id: string; workspace_id: string; role: WorkspaceRole; email: string },
    userId: string,
    email: string
  ) {
    const { data, error } = await this.db
      .from('workspace_invites')
      .update({ accepted_at: new Date().toISOString(), accepted_by: userId })
      .eq('id', invite.id)
      .is('accepted_at', null)
      .eq('email', email)
      .select('id')
    if (error) fail(error, 'workspace invite acceptance')
    if (!data?.length) throw new Error('Invitation has already been accepted')
    const { error: membershipError } = await this.db
      .from('workspace_members')
      .upsert(
        { workspace_id: invite.workspace_id, user_id: userId, role: invite.role, status: 'active' },
        { onConflict: 'workspace_id,user_id' }
      )
    if (membershipError) fail(membershipError, 'workspace membership creation')
  }
}
