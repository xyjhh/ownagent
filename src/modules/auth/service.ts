import argon2 from 'argon2'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { durationToSeconds, type AppConfig } from '../../config/env.js'
import { ApiError, unauthorized } from './errors.js'
import type { AuthRepository, PublicUser, RefreshTokenRecord, TokenPair, UserRecord } from './types.js'

export class AuthService {
  private readonly accessTokenSeconds: number
  private readonly refreshTokenSeconds: number
  private readonly jwtKey: Uint8Array
  private readonly previousJwtKey?: Uint8Array

  constructor(private readonly repository: AuthRepository, private readonly config: AppConfig) {
    this.accessTokenSeconds = durationToSeconds(config.ACCESS_TOKEN_TTL)
    this.refreshTokenSeconds = durationToSeconds(config.REFRESH_TOKEN_TTL)
    this.jwtKey = new TextEncoder().encode(config.AUTH_JWT_SECRET)
    this.previousJwtKey = config.AUTH_JWT_PREVIOUS_SECRET ? new TextEncoder().encode(config.AUTH_JWT_PREVIOUS_SECRET) : undefined
  }

  async login(email: string, password: string, metadata?: { userAgent?: string; ipHash?: string }): Promise<TokenPair> {
    const user = await this.repository.findUserByEmail(normalizeEmail(email))
    if (!user || !user.isActive || !(await this.verifyPassword(password, user.passwordHash))) {
      throw unauthorized()
    }
    await this.repository.updateLastLogin(user.id, new Date().toISOString())
    return this.issueTokenPair(user, undefined, undefined, undefined, metadata)
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const record = await this.repository.findRefreshTokenByHash(hashToken(refreshToken))
    if (!record) throw unauthorized('Invalid refresh token')
    if (record.revokedAt) {
      await this.repository.revokeRefreshTokenFamily(record.familyId)
      throw unauthorized('Invalid refresh token')
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      await this.repository.revokeRefreshToken(record.id)
      throw unauthorized('Invalid refresh token')
    }
    const user = await this.repository.findUserById(record.userId)
    if (!user || !user.isActive) throw unauthorized('Invalid refresh token')
    if (record.sessionId && this.repository.findSession) {
      const session = await this.repository.findSession(record.sessionId)
      if (!session || session.revokedAt) throw unauthorized('Invalid refresh token')
    }

    const nextId = randomUUID()
    const nextRaw = randomToken()
    const replaced = await this.repository.revokeRefreshToken(record.id, nextId)
    if (!replaced) {
      await this.repository.revokeRefreshTokenFamily(record.familyId)
      throw unauthorized('Invalid refresh token')
    }
    await this.repository.createRefreshToken({
      id: nextId,
      familyId: record.familyId,
      userId: user.id,
      tokenHash: hashToken(nextRaw),
      expiresAt: new Date(Date.now() + this.refreshTokenSeconds * 1000).toISOString(),
      sessionId: record.sessionId ?? record.id,
    })
    return this.issueTokenPair(user, nextRaw, nextId, record.familyId)
  }

  async logout(refreshToken: string): Promise<void> {
    const record = await this.repository.findRefreshTokenByHash(hashToken(refreshToken))
    if (record && !record.revokedAt) { await this.repository.revokeRefreshToken(record.id); if (record.sessionId && this.repository.revokeSession) await this.repository.revokeSession(record.sessionId) }
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.repository.findUserById(userId)
    if (!user || !user.isActive) throw unauthorized()
    return this.publicUser(user)
  }

  async bootstrap(email: string, password: string): Promise<PublicUser> {
    const normalized = normalizeEmail(email)
    if (await this.repository.findUserByEmail(normalized)) {
      throw new ApiError(409, 'USER_EXISTS', 'An owner account already exists')
    }
    const user = await this.repository.createUser({
      email: normalized,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    })
    return this.publicUser(user)
  }

  async verifyAccessToken(token: string): Promise<{ userId: string; email: string; sessionId?: string }> {
    try {
      const options = { algorithms: ['HS256'], issuer: this.config.AUTH_JWT_ISSUER, audience: this.config.AUTH_JWT_AUDIENCE }
      let result
      try { result = await jwtVerify(token, this.jwtKey, options) } catch (currentError) {
        if (!this.previousJwtKey) throw currentError
        result = await jwtVerify(token, this.previousJwtKey, options)
      }
      const kid = result.protectedHeader.kid
      if (kid && kid !== 'current' && kid !== 'previous') throw new Error('Invalid key id')
      const { sub, email, sid } = result.payload
      if (typeof sub !== 'string' || typeof email !== 'string') throw new Error('Invalid claims')
      return { userId: sub, email, sessionId: typeof sid === 'string' ? sid : undefined }
    } catch {
      throw unauthorized()
    }
  }

  async authenticateAccessToken(token: string): Promise<AuthIdentity> {
    const identity = await this.verifyAccessToken(token)
    const user = await this.repository.findUserById(identity.userId)
    if (!user || !user.isActive) throw unauthorized()
    if (identity.sessionId && this.repository.findSession) {
      const session = await this.repository.findSession(identity.sessionId)
      if (!session || session.revokedAt) throw unauthorized()
    }
    return identity
  }

  private async issueTokenPair(
    user: UserRecord,
    existingRaw?: string,
    existingId?: string,
    existingFamilyId?: string,
    metadata?: { userAgent?: string; ipHash?: string },
  ): Promise<TokenPair> {
    const sessionId = existingId ?? randomUUID()
    const refreshRaw = existingRaw ?? randomToken()
    const familyId = existingFamilyId ?? randomUUID()
    if (!existingRaw) {
      if (this.repository.createSession) await this.repository.createSession({ id: sessionId, userId: user.id, ...metadata })
      await this.repository.createRefreshToken({
        id: sessionId,
        familyId,
        userId: user.id,
        tokenHash: hashToken(refreshRaw),
        expiresAt: new Date(Date.now() + this.refreshTokenSeconds * 1000).toISOString(),
      })
    }
    const accessToken = await new SignJWT({ email: user.email, sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'current' })
      .setSubject(user.id)
      .setIssuer(this.config.AUTH_JWT_ISSUER)
      .setAudience(this.config.AUTH_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTokenSeconds}s`)
      .sign(this.jwtKey)
    return {
      accessToken,
      refreshToken: refreshRaw,
      tokenType: 'Bearer',
      expiresIn: this.accessTokenSeconds,
      user: this.publicUser(user),
    }
  }

  private async verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password)
    } catch {
      return false
    }
  }

  private publicUser(user: UserRecord): PublicUser {
    return { id: user.id, email: user.email, createdAt: user.createdAt }
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type AuthIdentity = Awaited<ReturnType<AuthService['verifyAccessToken']>>
