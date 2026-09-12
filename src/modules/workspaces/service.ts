import { createHash, randomBytes } from 'node:crypto'
import { ApiError, badRequest } from '../auth/errors.js'
import { normalizeEmail } from '../auth/service.js'
import type { WorkspaceRepository } from './repository.js'
import type { WorkspaceContext, WorkspaceRole } from './types.js'

export class WorkspaceService {
  constructor(private readonly repository: WorkspaceRepository) {}
  list(userId: string) { return this.repository.listForUser(userId) }
  create(userId: string, name: string, slug: string) {
    if (!name.trim() || !slug.trim()) throw badRequest('name and slug are required')
    return this.repository.create(userId, name.trim(), slug.trim().toLowerCase())
  }
  async invite(context: WorkspaceContext, email: string, role: WorkspaceRole) {
    if (!['owner', 'admin'].includes(context.role)) throw new ApiError(403, 'FORBIDDEN', 'Only workspace admins can invite members')
    const token = randomBytes(32).toString('base64url')
    const invite = await this.repository.createInvite({ workspaceId: context.workspaceId, invitedBy: context.userId, email: normalizeEmail(email), role, tokenHash: this.hash(token), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() })
    return { ...invite, token }
  }
  async acceptInvite(userId: string, email: string, token: string) {
    const invite = await this.repository.findInvite(this.hash(token))
    if (!invite || invite.accepted_at || Date.parse(String(invite.expires_at)) <= Date.now() || normalizeEmail(String(invite.email)) !== normalizeEmail(email)) throw new ApiError(400, 'INVALID_INVITE', 'Invitation is invalid or expired')
    await this.repository.acceptInvite({ id: String(invite.id), workspace_id: String(invite.workspace_id), role: String(invite.role) as WorkspaceRole, email: normalizeEmail(email) }, userId, normalizeEmail(email))
    return { workspaceId: String(invite.workspace_id), role: String(invite.role) }
  }
  private hash(value: string) { return createHash('sha256').update(value).digest('hex') }
}
