import type { ConversationMessage } from './repository.js'

export type TokenWindowResult = {
  messages: ConversationMessage[]
  estimatedTokens: number
  messageCount: number
  truncated: boolean
}

const chineseHanPattern = /[\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{2fa1f}]/u
const englishOrDigitPattern = /[A-Za-z0-9]/u
const punctuationPattern = /[\p{P}\p{S}]/u
const truncationMarker = '…[内容已截断]…'

/** Conservative, deterministic estimate used for context-window budgeting. */
export function estimateTextTokens(value: string): number {
  let chinese = 0
  let latinOrPunctuation = 0
  let unsupported = 0
  for (const character of Array.from(value)) {
    if (chineseHanPattern.test(character)) chinese += 1
    else if (/\s/u.test(character)) continue
    else if (englishOrDigitPattern.test(character) || punctuationPattern.test(character)) latinOrPunctuation += 1
    else unsupported += 1
  }
  return Math.max(1, chinese + Math.ceil(latinOrPunctuation / 4) + unsupported)
}

function messagePayload(message: ConversationMessage) {
  const citations = (message.citations ?? [])
    .map(citation => typeof citation.title === 'string' ? citation.title.trim() : '')
    .filter(Boolean)
    .slice(0, 8)
  return {
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(citations.length ? { citations } : {}),
  }
}

export function estimateConversationMessageTokens(message: ConversationMessage): number {
  return estimateTextTokens(JSON.stringify(messagePayload(message)))
}

export function truncateTextToTokenBudget(value: string, tokenBudget: number): string {
  const characters = Array.from(value)
  if (!characters.length || estimateTextTokens(value) <= tokenBudget) return value
  if (tokenBudget <= estimateTextTokens(truncationMarker)) return characters.slice(0, 1).join('')

  const available = tokenBudget - estimateTextTokens(truncationMarker)
  let low = 1
  let high = Math.max(1, Math.floor(characters.length / 2))
  let best = truncationMarker
  while (low <= high) {
    const half = Math.floor((low + high) / 2)
    const candidate = `${characters.slice(0, half).join('')}${truncationMarker}${characters.slice(-half).join('')}`
    if (estimateTextTokens(candidate) <= tokenBudget && estimateTextTokens(candidate) <= available + estimateTextTokens(truncationMarker)) {
      best = candidate
      low = half + 1
    } else {
      high = half - 1
    }
  }
  return best
}

function sortMessages(messages: ConversationMessage[]) {
  return messages
    .filter(message => String(message.content ?? '').trim().length > 0)
    .slice()
    .sort((left, right) => {
      const createdAt = left.createdAt.localeCompare(right.createdAt)
      return createdAt || left.id.localeCompare(right.id)
    })
}

function truncateMessageToBudget(message: ConversationMessage, tokenBudget: number): ConversationMessage {
  const emptyContentMessage = { ...message, content: '' }
  const contentBudget = Math.max(1, tokenBudget - estimateConversationMessageTokens(emptyContentMessage))
  const content = truncateTextToTokenBudget(message.content, contentBudget)
  return { ...message, content }
}

export function selectRecentMessagesByTokenBudget(messages: ConversationMessage[], tokenBudget: number): TokenWindowResult {
  const budget = Math.max(1, Math.floor(tokenBudget))
  const ordered = sortMessages(messages)
  const selected: ConversationMessage[] = []
  let estimatedTokens = 0
  let truncated = false

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index]!
    const messageTokens = estimateConversationMessageTokens(message)
    if (messageTokens <= budget - estimatedTokens) {
      selected.push(message)
      estimatedTokens += messageTokens
      continue
    }

    const remainingBudget = budget - estimatedTokens
    const partial = truncateMessageToBudget(message, Math.max(1, remainingBudget))
    const partialTokens = estimateConversationMessageTokens(partial)
    if (selected.length === 0 || partialTokens <= remainingBudget) {
      selected.push(partial)
      estimatedTokens += partialTokens
    }
    truncated = true
    break
  }

  selected.reverse()
  return {
    messages: selected,
    estimatedTokens,
    messageCount: selected.length,
    truncated,
  }
}
