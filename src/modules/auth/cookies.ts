import type { Response, Request } from 'express'
import type { AppConfig } from '../../config/env.js'
import { durationToSeconds } from '../../config/env.js'

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.cookie
  if (!header) return {}
  return Object.fromEntries(
    header
      .split(';')
      .map(part => {
        const index = part.indexOf('=')
        if (index < 0) return ['', '']
        const key = part.slice(0, index).trim()
        const value = part.slice(index + 1).trim()
        try {
          return [key, decodeURIComponent(value)]
        } catch {
          return [key, value]
        }
      })
      .filter(([key]) => Boolean(key))
  )
}

export function accessCookie(request: Request, config: AppConfig): string | undefined {
  return parseCookies(request)[config.AUTH_COOKIE_ACCESS_NAME]
}

export function refreshCookie(request: Request, config: AppConfig): string | undefined {
  return parseCookies(request)[config.AUTH_COOKIE_REFRESH_NAME]
}

export function setAuthCookies(
  response: Response,
  config: AppConfig,
  accessToken: string,
  refreshToken: string
) {
  response.append(
    'Set-Cookie',
    serialize(
      config.AUTH_COOKIE_ACCESS_NAME,
      accessToken,
      config,
      durationToSeconds(config.ACCESS_TOKEN_TTL)
    )
  )
  response.append(
    'Set-Cookie',
    serialize(
      config.AUTH_COOKIE_REFRESH_NAME,
      refreshToken,
      config,
      durationToSeconds(config.REFRESH_TOKEN_TTL)
    )
  )
}

export function clearAuthCookies(response: Response, config: AppConfig) {
  response.append('Set-Cookie', serialize(config.AUTH_COOKIE_ACCESS_NAME, '', config, 0))
  response.append('Set-Cookie', serialize(config.AUTH_COOKIE_REFRESH_NAME, '', config, 0))
}

function serialize(name: string, value: string, config: AppConfig, maxAge: number): string {
  const encoded = encodeURIComponent(value)
  const secure = config.AUTH_COOKIE_SECURE ? '; Secure' : ''
  return `${name}=${encoded}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=${config.AUTH_COOKIE_SAMESITE[0]!.toUpperCase()}${config.AUTH_COOKIE_SAMESITE.slice(1)}${secure}`
}
