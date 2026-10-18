import type { ConversationMessage } from '../conversations/repository.js'
import { estimateTextTokens } from '../conversations/token-window.js'

export const SUMMARY_PROMPT_VERSION = 'memory-worker-v2-incremental'

export type SummaryMessage = Pick<
  ConversationMessage,
  'id' | 'role' | 'content' | 'createdAt' | 'citations'
>

/** Conservative, deterministic estimate used only for batching prompts. */
export const estimateSummaryTokens = estimateTextTokens

export function summaryMessagePayload(message: SummaryMessage) {
  const citations = (message.citations ?? [])
    .map(citation => (typeof citation.title === 'string' ? citation.title.trim() : ''))
    .filter(Boolean)
    .slice(0, 8)
  return {
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(citations.length ? { citations } : {}),
  }
}

export function estimateSummaryMessageTokens(message: SummaryMessage): number {
  return estimateSummaryTokens(JSON.stringify(summaryMessagePayload(message)))
}

export function takeSummaryBatch(
  messages: SummaryMessage[],
  previousSummary: string,
  inputBudget: number
): { batch: SummaryMessage[]; remaining: SummaryMessage[]; estimatedTokens: number } {
  if (!messages.length)
    return { batch: [], remaining: [], estimatedTokens: estimateSummaryTokens(previousSummary) }
  const baseTokens = estimateSummaryTokens(previousSummary) + 160
  const batch: SummaryMessage[] = []
  let estimatedTokens = baseTokens
  for (const message of messages) {
    const messageTokens = estimateSummaryMessageTokens(message)
    if (batch.length > 0 && estimatedTokens + messageTokens > inputBudget) break
    batch.push(message)
    estimatedTokens += messageTokens
  }
  return { batch, remaining: messages.slice(batch.length), estimatedTokens }
}

export function limitSummaryTokens(summary: string, outputBudget: number): string {
  if (estimateSummaryTokens(summary) <= outputBudget) return summary.trim()
  const characters = Array.from(summary)
  let end = characters.length
  while (end > 0 && estimateSummaryTokens(characters.slice(0, end).join('')) > outputBudget)
    end -= 1
  const clipped = characters.slice(0, end).join('').trimEnd()
  const boundary = Math.max(
    clipped.lastIndexOf('\n'),
    clipped.lastIndexOf('。'),
    clipped.lastIndexOf('.')
  )
  const result = (
    boundary > Math.floor(clipped.length * 0.6) ? clipped.slice(0, boundary + 1) : clipped
  ).trim()
  return result || characters[0] || ''
}

export function summaryPrompt(previousSummary: string, messages: SummaryMessage[]) {
  return JSON.stringify({
    previousSummary,
    newMessages: messages.map(summaryMessagePayload),
  })
}
