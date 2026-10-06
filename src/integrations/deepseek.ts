import type { AppConfig } from '../config/env.js'
import { fetchJson } from './http.js'
import type { ZodSchema } from 'zod'

export type StructuredModelErrorCode = 'MODEL_TIMEOUT' | 'MODEL_INVALID_JSON' | 'MODEL_SCHEMA_INVALID' | 'MODEL_UNAVAILABLE'
export class StructuredModelError extends Error {
  constructor(public readonly code: StructuredModelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StructuredModelError'
  }
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type ChatCompletion = { id: string; choices: Array<{ message: ChatMessage }> }

function parseStructuredContent(content: string): unknown {
  const trimmed = content.trim()
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    return JSON.parse(withoutFence)
  } catch {
    const start = withoutFence.search(/[\[{]/)
    const end = Math.max(withoutFence.lastIndexOf('}'), withoutFence.lastIndexOf(']'))
    if (start >= 0 && end > start) return JSON.parse(withoutFence.slice(start, end + 1))
    throw new Error('Structured model response is not valid JSON')
  }
}

export class DeepSeekClient {
  constructor(private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.DEEPSEEK_API_KEY)
  }

  async chat(messages: ChatMessage[]): Promise<ChatCompletion> {
    if (!this.config.DEEPSEEK_API_KEY) throw new Error('DeepSeek API key is not configured')
    return fetchJson<ChatCompletion>(
      `${this.config.DEEPSEEK_BASE_URL}/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: this.config.DEEPSEEK_MODEL, messages }),
      },
      this.config.MODEL_TIMEOUT_MS
    )
  }

  async chatJson<T>(messages: ChatMessage[], schema: ZodSchema<T>, maxRetriesOrOptions: number | { model?: string; timeoutMs?: number; maxRetries?: number } = 1, legacyOptions?: { model?: string; timeoutMs?: number }): Promise<T> {
    const options = typeof maxRetriesOrOptions === 'number' ? legacyOptions : maxRetriesOrOptions
    const maxRetries = typeof maxRetriesOrOptions === 'number' ? maxRetriesOrOptions : (maxRetriesOrOptions.maxRetries ?? 1)
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        if (!this.config.DEEPSEEK_API_KEY) throw new StructuredModelError('MODEL_UNAVAILABLE', 'DeepSeek API key is not configured')
        const response = await fetchJson<{ choices: Array<{ message?: { content?: string } }> }>(
          `${this.config.DEEPSEEK_BASE_URL}/chat/completions`,
          { method: 'POST', headers: { authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: options?.model ?? this.config.DEEPSEEK_MODEL, messages, response_format: { type: 'json_object' } }) },
          options?.timeoutMs ?? this.config.MODEL_TIMEOUT_MS
        )
        const content = response.choices?.[0]?.message?.content
        if (!content) throw new StructuredModelError('MODEL_INVALID_JSON', 'Structured model response is empty')
        let parsed: unknown
        try { parsed = parseStructuredContent(content) } catch (error) { throw new StructuredModelError('MODEL_INVALID_JSON', 'Structured model response is not valid JSON', { cause: error }) }
        try { return schema.parse(parsed) } catch (error) { throw new StructuredModelError('MODEL_SCHEMA_INVALID', 'Structured model response failed schema validation', { cause: error }) }
      } catch (error) {
        lastError = error
        if (error instanceof StructuredModelError && error.code === 'MODEL_SCHEMA_INVALID') break
      }
    }
    if (lastError instanceof StructuredModelError) throw lastError
    const message = lastError instanceof Error ? lastError.message : 'Structured model response failed'
    throw new StructuredModelError(/timeout|abort/i.test(message) ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE', message, { cause: lastError })
  }

  async *streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
    if (!this.config.DEEPSEEK_API_KEY) throw new Error('DeepSeek API key is not configured')
    const response = await fetch(`${this.config.DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: this.config.DEEPSEEK_MODEL, messages, stream: true }),
      signal: AbortSignal.timeout(this.config.MODEL_TIMEOUT_MS),
    })
    if (!response.ok || !response.body)
      throw new Error(`DeepSeek request failed (${response.status})`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        try {
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
          const text = chunk.choices?.[0]?.delta?.content
          if (text) yield text
        } catch {
          /* skip malformed SSE frame */
        }
      }
    }
  }
}
