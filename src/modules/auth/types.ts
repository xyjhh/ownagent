export type PublicUser = {
  id: string
  email: string
  createdAt: string
}

export type UserRecord = PublicUser & {
  passwordHash: string
  isActive: boolean
  lastLoginAt: string | null
}

export type RefreshTokenRecord = {
  id: string
  familyId: string
  userId: string
  tokenHash: string
  expiresAt: string
  revokedAt: string | null
  replacedBy: string | null
  sessionId?: string | null
}

export type TokenPair = {
  accessToken: string
  refreshToken: string
  tokenType: 'Bearer'
  expiresIn: number
  user: PublicUser
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<UserRecord | null>
  findUserById(id: string): Promise<UserRecord | null>
  createUser(input: { email: string; passwordHash: string }): Promise<UserRecord>
  updateLastLogin(id: string, at: string): Promise<void>
  findRefreshTokenByHash(hash: string): Promise<RefreshTokenRecord | null>
  createRefreshToken(input: {
    id: string
    familyId: string
    userId: string
    tokenHash: string
    expiresAt: string
    sessionId?: string
  }): Promise<RefreshTokenRecord>
  revokeRefreshToken(id: string, replacedBy?: string): Promise<boolean>
  revokeRefreshTokenFamily(familyId: string): Promise<void>
  findSession?(id: string): Promise<{ revokedAt: string | null } | null>
  createSession?(input: { id: string; userId: string; userAgent?: string; ipHash?: string }): Promise<void>
  revokeSession?(id: string): Promise<void>
}
