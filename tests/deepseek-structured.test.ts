import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DeepSeekClient } from '../src/integrations/deepseek.js'
import type { AppConfig } from '../src/config/env.js'

const config = {
  DEEPSEEK_API_KEY: 'test-key',
  DEEPSEEK_BASE_URL: 'http://deepseek.test/v1',
  DEEPSEEK_MODEL: 'deepseek-chat',
  MODEL_TIMEOUT_MS: 1000,
} as AppConfig

afterEach(() => vi.unstubAllGlobals())

describe('DeepSeek structured output', () => {
  it('retries schema failures with a targeted repair instruction', async () => {
    const responses = [
      { choices: [{ message: { content: JSON.stringify({ value: 'wrong' }) } }] },
      { choices: [{ message: { content: JSON.stringify({ value: 'ok' }) } }] },
    ]
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const response = responses.shift()!
      return {
        ok: true,
        json: async () => response,
        requestBody: JSON.parse(String(init?.body)),
      } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new DeepSeekClient(config).chatJson(
      [{ role: 'user', content: 'return JSON' }],
      z.object({ value: z.literal('ok') }),
      { maxRetries: 1 },
    )
    expect(result).toEqual({ value: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(secondBody.messages.at(-1).content).toContain('上一次输出未通过结构校验')
  })
})
