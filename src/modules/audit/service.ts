import type { SupabaseClient } from '@supabase/supabase-js'
import type { WorkspaceContext } from '../workspaces/types.js'

export class AuditService {
  constructor(private readonly db: SupabaseClient) {}
  async record(input: {
    context?: WorkspaceContext
    action: string
    resourceType: string
    resourceId?: string
    requestId?: string
    ipHash?: string
    metadata?: Record<string, unknown>
  }): Promise<void> {
    const { error } = await this.db
      .from('audit_logs')
      .insert({
        user_id: input.context?.userId ?? null,
        workspace_id: input.context?.workspaceId ?? null,
        action: input.action,
        resource_type: input.resourceType,
        resource_id: input.resourceId ?? null,
        request_id: input.requestId ?? null,
        ip_hash: input.ipHash ?? null,
        metadata: input.metadata ?? {},
      })
    if (error) throw new Error(`Audit log write failed: ${error.message}`)
  }
}
