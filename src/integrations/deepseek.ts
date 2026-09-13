import type { AppConfig } from '../config/env.js'
import { fetchJson } from './http.js'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type ChatCompletion = { id: string; choices: Array<{ message: ChatMessage }> }

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
