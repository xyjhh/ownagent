import type { ConversationMessage } from './repository.js'

const maxTitleLength = 48

function stripMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?，。；：！？、])/g, '$1')
    .trim()
}

export function normalizeConversationTitle(value: unknown, fallback: string) {
  const candidate = stripMarkdown(typeof value === 'string' ? value : '')
    .replace(/^(标题|title)\s*[:：-]\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
  const source = candidate || stripMarkdown(fallback) || '新对话'
  return source.slice(0, maxTitleLength).trim() || '新对话'
}

export function fallbackConversationTitle(messages: ConversationMessage[]) {
  const firstUserMessage = messages.find(message => message.role === 'user')
  return normalizeConversationTitle(firstUserMessage?.content, '新对话')
}

export function titlePrompt(messages: ConversationMessage[]) {
  return JSON.stringify(messages.map(message => ({ role: message.role, content: message.content })))
}
