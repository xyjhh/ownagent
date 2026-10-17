import { z, type ZodSchema } from 'zod'
import type { DeepSeekClient } from '../integrations/deepseek.js'
import type { TraceContext } from '../observability/langfuse.js'
import type { ConversationMessage } from '../modules/conversations/repository.js'
import { selectRecentMessagesByTokenBudget, truncateTextToTokenBudget } from '../modules/conversations/token-window.js'

const supervisorIntentAliases: Record<string, string> = {
  knowledge: 'knowledge_query',
  knowledgequery: 'knowledge_query',
  qa: 'knowledge_query',
  summary: 'document_summary',
  documentsummary: 'document_summary',
  compare: 'document_compare',
  documentcompare: 'document_compare',
  chat: 'general_chat',
  general: 'general_chat',
  preference: 'preference_update',
  preferenceupdate: 'preference_update',
  memory: 'preference_update',
  userpreference: 'preference_update',
}

const supervisorPlanAliases: Record<string, string> = {
  search: 'search_knowledge',
  retrieve: 'search_knowledge',
  retrieval: 'search_knowledge',
  getdocument: 'get_document',
  read_document: 'get_document',
  summarize: 'get_document',
  compare: 'compare_documents',
  answer: 'generate_answer',
  respond: 'generate_answer',
}

const DEFAULT_CLARIFICATION_QUESTION = '请补充你希望重点了解或分析的内容。'

function normalizeSupervisorDecision(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = { ...input }
  if (typeof input.intent === 'string') {
    const key = input.intent.trim().toLowerCase().replace(/[\s-]/g, '')
    output.intent = supervisorIntentAliases[key] ?? input.intent.trim()
  }
  if (Array.isArray(input.plan)) {
    output.plan = input.plan.map(item => {
      if (typeof item !== 'string') return item
      const raw = item.trim().toLowerCase().replace(/[\s-]/g, '_')
      const key = raw.replace(/_/g, '')
      return supervisorPlanAliases[key] ?? raw
    })
  } else if (typeof input.plan === 'string') {
    output.plan = input.plan
      .split(/[,，>、]/)
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const raw = item.toLowerCase().replace(/[\s-]/g, '_')
        return supervisorPlanAliases[raw.replace(/_/g, '')] ?? raw
      })
  }
  for (const key of ['needsRetrieval', 'requiresApproval', 'needsClarification']) {
    if (typeof input[key] === 'string' && /^(true|false)$/i.test(input[key] as string))
      output[key] = input[key] === 'true'
  }
  if (typeof input.confidence === 'string' && input.confidence.trim() !== '') {
    const confidence = Number(input.confidence)
    if (Number.isFinite(confidence)) output.confidence = confidence
  }
  for (const key of ['query', 'reason', 'documentIds']) if (output[key] === null) delete output[key]
  if (typeof output.clarificationQuestion === 'string') {
    output.clarificationQuestion = output.clarificationQuestion.trim()
  } else if (output.clarificationQuestion === null) {
    delete output.clarificationQuestion
  }
  if (Array.isArray(output.clarificationOptions)) {
    output.clarificationOptions = [
      ...new Set(
        output.clarificationOptions
          .filter(option => typeof option === 'string' && option.trim().length > 0)
          .map(option => (option as string).trim())
      ),
    ]
  }
  for (const key of ['containsUserPreference', 'preferenceOnly']) {
    if (typeof input[key] === 'string' && /^(true|false)$/i.test(input[key] as string))
      output[key] = input[key] === 'true'
  }
  // A preference-only decision is a control decision for routing. Normalize
  // stale model plans so they can never trigger a knowledge search.
  if (output.intent === 'preference_update' || output.preferenceOnly === true) {
    output.containsUserPreference = true
    output.preferenceOnly = true
    output.intent = 'preference_update'
    output.needsRetrieval = false
    output.plan = ['generate_answer']
  }
  // Some model responses set needsClarification=true but return an empty
  // clarificationQuestion. Preserve the intended pause instead of letting
  // schema failure turn the request into a retrieval fallback.
  if (
    output.needsClarification === true &&
    (typeof output.clarificationQuestion !== 'string' || output.clarificationQuestion.length === 0)
  ) {
    output.clarificationQuestion = DEFAULT_CLARIFICATION_QUESTION
  }
  return output
}

const supervisorDecisionObjectSchema = z
  .object({
    intent: z.enum([
      'knowledge_query',
      'document_summary',
      'document_compare',
      'general_chat',
      'preference_update',
    ]),
    needsRetrieval: z.boolean(),
    query: z.string().max(4000).optional(),
    documentIds: z.array(z.string().uuid()).max(20).optional(),
    plan: z
      .array(z.enum(['search_knowledge', 'get_document', 'compare_documents', 'generate_answer']))
      .min(1)
      .max(4),
    requiresApproval: z.boolean(),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(500).optional(),
    needsClarification: z.boolean().default(false),
    clarificationQuestion: z.string().trim().min(1).max(1000).optional(),
    clarificationOptions: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
    containsUserPreference: z.boolean().default(false),
    preferenceOnly: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.needsClarification && !value.clarificationQuestion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clarificationQuestion'],
        message: 'clarificationQuestion is required when needsClarification is true',
      })
    }
  })

export const supervisorDecisionSchema = z.preprocess(
  normalizeSupervisorDecision,
  supervisorDecisionObjectSchema
)

export type SupervisorDecision = z.infer<typeof supervisorDecisionSchema>
export type SupervisorContext = {
  workspaceId: string
  userId: string
  role?: string
  conversationSummary?: string
  recentMessages?: Array<{
    role: 'user' | 'assistant' | 'system'
    content: string
    createdAt?: string
    citations?: Array<{ title?: string }>
  }>
  trace?: TraceContext
}

const MAX_CONTEXT_MESSAGE_LENGTH = 12_000
const MAX_CONTEXT_SUMMARY_TOKENS = 1_600

function formatConversationContext(context: SupervisorContext, tokenBudget: number) {
  const summary = context.conversationSummary?.trim()
    ? truncateTextToTokenBudget(context.conversationSummary.trim(), MAX_CONTEXT_SUMMARY_TOKENS)
    : undefined
  const normalizedMessages: ConversationMessage[] = (context.recentMessages ?? [])
    .map((message, index) => {
      const citations = (message.citations ?? [])
        .map(citation => typeof citation.title === 'string' ? citation.title.trim() : '')
        .filter(Boolean)
        .slice(0, 8)
      return {
        id: `context-${index}`,
        role: message.role,
        content: String(message.content ?? '').trim().slice(0, MAX_CONTEXT_MESSAGE_LENGTH),
        createdAt: message.createdAt ?? '',
        citations: citations.map(title => ({ title })),
      }
    })
  const window = selectRecentMessagesByTokenBudget(normalizedMessages, tokenBudget)
  const recentMessages = window.messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.citations.length ? { citations: message.citations.map(citation => ({ title: typeof citation.title === 'string' ? citation.title : undefined })) } : {}),
  }))

  return { conversationSummary: summary, recentMessages }
}

export function fallbackDecision(input: string): SupervisorDecision {
  return {
    intent: 'knowledge_query',
    needsRetrieval: true,
    query: input.slice(0, 4000),
    plan: ['search_knowledge', 'generate_answer'],
    requiresApproval: false,
    confidence: 0,
    reason: 'supervisor_fallback',
    needsClarification: false,
    containsUserPreference: false,
    preferenceOnly: false,
  }
}

export class SupervisorAgent {
  constructor(
    private readonly model: DeepSeekClient,
    private readonly options: {
      confidenceThreshold: number
      maxRetries: number
      model?: string
      timeoutMs?: number
    recentTokenBudget?: number
  } = { confidenceThreshold: 0.65, maxRetries: 1, recentTokenBudget: 4_000 }
  ) {}

  async classify(
    input: string,
    context: SupervisorContext
  ): Promise<{ decision: SupervisorDecision; fallback: boolean }> {
    const trimmed = input.trim()
    const control = this.controlDecision(trimmed)
    if (control) return { decision: control, fallback: false }
    const conversationContext = formatConversationContext(context, this.options.recentTokenBudget ?? 4_000)
    const messages = [
      {
        role: 'system' as const,
        content:
          '你是企业知识库任务规划器。只输出一个合法 JSON 对象，不要 Markdown、代码围栏、解释或额外字段。输出格式示例：{"intent":"knowledge_query","needsRetrieval":true,"query":"问题改写，可选","documentIds":[],"plan":["search_knowledge","generate_answer"],"requiresApproval":false,"confidence":0.9,"reason":"可选简短原因","needsClarification":false,"clarificationQuestion":"可选的面向用户的问题","clarificationOptions":[],"containsUserPreference":false,"preferenceOnly":false}。intent 只能是 knowledge_query、document_summary、document_compare、general_chat、preference_update；preference_update 只用于用户明确表达偏好、习惯或回答格式要求。用户偏好字段：containsUserPreference 表示输入是否包含长期偏好，preferenceOnly 表示整条输入只有偏好且不需要知识库回答。preferenceOnly=true 时必须使用 intent=preference_update、needsRetrieval=false、plan=["generate_answer"]，不得检索知识库。偏好与知识问题同时出现时，containsUserPreference=true 但 preferenceOnly=false，保留知识问题的检索计划。用户明确表达“我主要用 TypeScript”“以后示例尽量用 TypeScript”属于偏好，不要当作知识库问题。不明确时选择只读 knowledge_query。信息不足以安全执行时或者根据上下文无法判断用户需要的信息时设置 needsClarification=true，提供简短的 clarificationQuestion；存在有限选择时提供最多 6 个 clarificationOptions，不要猜测用户未提供的信息。只能选择允许的 intent 和 plan，不能执行工具、决定权限或编造事实。涉及写操作时 requiresApproval 必须为 true。' +
          ' 如果当前问题包含“他/她/这个人/这个项目/上一份资料”等指代，先结合 conversationSummary 和 recentMessages 解析。最近上下文中只有一个明确实体时直接解析，并把解析后的完整问题写入 query；上一轮助手纠正过名称时优先使用纠正后的规范名称。只有存在多个候选实体，或没有任何可用上下文时，才设置 needsClarification=true。needsClarification 只由语义是否有歧义决定，不要仅因为 confidence 数值较低而澄清。',
      },
      {
        role: 'user' as const,
        content: JSON.stringify({
          input: trimmed,
          workspaceId: context.workspaceId,
          role: context.role ?? 'viewer',
          conversationSummary: conversationContext.conversationSummary,
          recentMessages: conversationContext.recentMessages,
          allowedPlans: [
            'search_knowledge',
            'get_document',
            'compare_documents',
            'generate_answer',
          ],
        }),
      },
    ]
    try {
      const decision = await this.model.chatJson(
        messages,
        supervisorDecisionSchema,
        this.options.maxRetries,
        {
          model: this.options.model,
          timeoutMs: this.options.timeoutMs,
          trace: context.trace,
          operation: 'supervisor.classify',
        }
      )
      if (decision.preferenceOnly || decision.intent === 'preference_update')
        return { decision, fallback: false }
      // if (decision.confidence < this.options.confidenceThreshold) return { decision: fallbackDecision(trimmed), fallback: true }
      return { decision, fallback: false }
    } catch {
      return { decision: fallbackDecision(trimmed), fallback: true }
    }
  }

  private controlDecision(input: string): SupervisorDecision | undefined {
    if (!input)
      return {
        intent: 'general_chat',
        needsRetrieval: false,
        plan: ['generate_answer'],
        requiresApproval: false,
        confidence: 1,
        reason: 'empty_input',
        needsClarification: false,
        containsUserPreference: false,
        preferenceOnly: false,
      }
    const lower = input.toLowerCase()
    const isApproval = lower.startsWith('approve:')
    const isControl = isApproval || new Set(['cancel', 'stop', '继续', '拒绝']).has(input)
    if (isControl)
      return {
        intent: 'general_chat',
        needsRetrieval: false,
        plan: ['generate_answer'],
        requiresApproval: isApproval,
        confidence: 1,
        reason: 'control_input',
        needsClarification: false,
        containsUserPreference: false,
        preferenceOnly: false,
      }
    return undefined
  }
}

export type SupervisorSchema<T> = ZodSchema<T>
