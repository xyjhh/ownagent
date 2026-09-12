import type { AuthIdentity } from '../modules/auth/service.js'
import type { WorkspaceContext } from '../modules/workspaces/types.js'

declare global {
  namespace Express {
    interface Request {
      requestId: string
      auth?: AuthIdentity
      workspace?: WorkspaceContext
      langfuseTrace?: unknown
    }
  }
}

export {}
