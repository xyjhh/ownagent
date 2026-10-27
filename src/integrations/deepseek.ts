import type { AppConfig } from '../config/env.js'
import { fetchJson } from './http.js'
import type { LangfuseTracer, TraceContext } from '../observability/langfuse.js'
import { ZodError, type ZodSchema } from 'zod'

export type StructuredModelErrorCode =
  'MODEL_TIMEOUT' | 'MODEL_INVALID_JSON' | 'MODEL_SCHEMA_INVALID' | 'MODEL_UNAVAILABLE'
export class StructuredModelError extends Error {
  constructor(
    public readonly code: StructuredModelErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'StructuredModelError'
  }
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type ChatCompletion = { id: string; choices: Array<{ message: ChatMessage }> }
export type ModelTraceOptions = { trace?: TraceContext; operation?: string; attempt?: number }
export type ChatToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

function parseStructuredContent(content: string): unknown {
  const trimmed = content.trim()
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
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
  constructor(
    private readonly config: AppConfig,
    private readonly tracer?: LangfuseTracer
  ) {}

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

  async chatJson<T>(
    messages: ChatMessage[],
    schema: ZodSchema<T>,
    maxRetriesOrOptions:
      | number
      | ({ model?: string; timeoutMs?: number; maxRetries?: number } & ModelTraceOptions) = 1,
    legacyOptions?: { model?: string; timeoutMs?: number } & ModelTraceOptions
  ): Promise<T> {
    const options = typeof maxRetriesOrOptions === 'number' ? legacyOptions : maxRetriesOrOptions
    const maxRetries =
      typeof maxRetriesOrOptions === 'number'
        ? maxRetriesOrOptions
        : (maxRetriesOrOptions.maxRetries ?? 1)
    let lastError: unknown
    let repairHint = ''
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const attemptMessages = repairHint
        ? [
            ...messages,
            {
              role: 'user' as const,
              content: `上一次输出未通过结构校验，请重新输出完整 JSON。不要解释，不要 Markdown，只修正以下校验问题：${repairHint}`,
            },
          ]
        : messages
      const generation =
        options?.trace &&
        this.tracer?.startGeneration(
          options.trace,
          options.operation ?? 'deepseek.chat_json',
          attemptMessages,
          {
            model: options.model ?? this.config.DEEPSEEK_MODEL,
            attempt,
            timeoutMs: options.timeoutMs ?? this.config.MODEL_TIMEOUT_MS,
          }
        )
      try {
        if (!this.config.DEEPSEEK_API_KEY)
          throw new StructuredModelError('MODEL_UNAVAILABLE', 'DeepSeek API key is not configured')
        const response = await fetchJson<{ choices: Array<{ message?: { content?: string } }> }>(
          `${this.config.DEEPSEEK_BASE_URL}/chat/completions`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: options?.model ?? this.config.DEEPSEEK_MODEL,
              messages: attemptMessages,
              response_format: { type: 'json_object' },
            }),
          },
          options?.timeoutMs ?? this.config.MODEL_TIMEOUT_MS
        )
        const content = response.choices?.[0]?.message?.content
        if (!content)
          throw new StructuredModelError('MODEL_INVALID_JSON', 'Structured model response is empty')
        let parsed: unknown
        try {
          parsed = parseStructuredContent(content)
        } catch (error) {
          throw new StructuredModelError(
            'MODEL_INVALID_JSON',
            'Structured model response is not valid JSON',
            { cause: error }
          )
        }
        try {
          const result = schema.parse(parsed)
          generation?.end(result, { model: options?.model ?? this.config.DEEPSEEK_MODEL, attempt })
          return result
        } catch (error) {
          repairHint =
            error instanceof ZodError
              ? error.issues
                  .slice(0, 5)
                  .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
                  .join('; ')
              : '返回对象不符合要求'
          throw new StructuredModelError(
            'MODEL_SCHEMA_INVALID',
            `Structured model response failed schema validation: ${repairHint}`,
            { cause: error }
          )
        }
      } catch (error) {
        generation?.fail(error, { model: options?.model ?? this.config.DEEPSEEK_MODEL, attempt })
        lastError = error
      }
    }
    if (lastError instanceof StructuredModelError) throw lastError
    const message =
      lastError instanceof Error ? lastError.message : 'Structured model response failed'
    throw new StructuredModelError(
      /timeout|abort/i.test(message) ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE',
      message,
      { cause: lastError }
    )
  }

  async chatToolJson<T>(
    messages: ChatMessage[],
    schema: ZodSchema<T>,
    tool: ChatToolDefinition,
    options: { model?: string; timeoutMs?: number } & ModelTraceOptions = {}
  ): Promise<T> {
    const model = options.model ?? this.config.DEEPSEEK_MODEL
    const generation =
      options.trace &&
      this.tracer?.startGeneration(
        options.trace,
        options.operation ?? 'deepseek.chat_tool',
        messages,
        {
          model,
          attempt: options.attempt ?? 0,
          timeoutMs: options.timeoutMs ?? this.config.MODEL_TIMEOUT_MS,
          toolName: tool.name,
        }
      )
    try {
      if (!this.config.DEEPSEEK_API_KEY)
        throw new StructuredModelError('MODEL_UNAVAILABLE', 'DeepSeek API key is not configured')
      const response = await fetchJson<{
        choices?: Array<{
          message?: {
            tool_calls?: Array<{
              type?: string
              function?: { name?: string; arguments?: string | Record<string, unknown> }
            }>
          }
        }>
      }>(
        `${this.config.DEEPSEEK_BASE_URL}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            tools: [
              {
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              },
            ],
            tool_choice: { type: 'function', function: { name: tool.name } },
          }),
        },
        options.timeoutMs ?? this.config.MODEL_TIMEOUT_MS
      )
      const call = response.choices?.[0]?.message?.tool_calls?.find(
        item => item.type === 'function' && item.function?.name === tool.name
      )
      if (!call?.function?.arguments)
        throw new StructuredModelError(
          'MODEL_INVALID_JSON',
          `Model did not call the required tool: ${tool.name}`
        )
      let parsed: unknown
      try {
        parsed =
          typeof call.function.arguments === 'string'
            ? JSON.parse(call.function.arguments)
            : call.function.arguments
      } catch (error) {
        throw new StructuredModelError('MODEL_INVALID_JSON', 'Tool arguments are not valid JSON', {
          cause: error,
        })
      }
      let result: T
      try {
        result = schema.parse(parsed)
      } catch (error) {
        const detail =
          error instanceof ZodError ? error.issues[0]?.message : 'invalid tool arguments'
        throw new StructuredModelError(
          'MODEL_SCHEMA_INVALID',
          `Tool arguments failed schema validation: ${detail}`,
          { cause: error }
        )
      }
      generation?.end(result, { model, toolName: tool.name })
      return result
    } catch (error) {
      generation?.fail(error, { model, toolName: tool.name })
      throw error
    }
  }

  async *streamChat(
    messages: ChatMessage[],
    options: ModelTraceOptions = {}
  ): AsyncGenerator<string> {
    if (!this.config.DEEPSEEK_API_KEY) throw new Error('DeepSeek API key is not configured')
    const generation =
      options.trace &&
      this.tracer?.startGeneration(
        options.trace,
        options.operation ?? 'deepseek.stream',
        messages,
        { model: this.config.DEEPSEEK_MODEL, timeoutMs: this.config.MODEL_TIMEOUT_MS }
      )
    let answer = ''
    try {
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
        if (done) {
          buffer += decoder.decode()
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const text = parseStreamLine(line)
          if (text === null) continue
          if (text === '[DONE]') {
            generation?.end(answer, { outputLength: answer.length })
            return
          }
          if (text) {
            answer += text
            yield text
          }
        }
      }
      const text = parseStreamLine(buffer)
      if (text && text !== '[DONE]') {
        answer += text
        yield text
      }
      generation?.end(answer, { outputLength: answer.length })
    } catch (error) {
      generation?.fail(error, { outputLength: answer.length })
      throw error
    }
  }
}

function parseStreamLine(line: string): string | null {
  if (!line.startsWith('data:')) return null
  const data = line.slice(5).trim()
  if (data === '[DONE]') return data
  try {
    const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
    return chunk.choices?.[0]?.delta?.content ?? null
  } catch {
    return null
  }
}
