import { z, type ZodSchema } from 'zod'
import type { DeepSeekClient } from '../integrations/deepseek.js'
import type { TraceContext } from '../observability/langfuse.js'

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
    output.plan = input.plan.split(/[,，>、]/).map(item => item.trim()).filter(Boolean).map(item => {
      const raw = item.toLowerCase().replace(/[\s-]/g, '_')
      return supervisorPlanAliases[raw.replace(/_/g, '')] ?? raw
    })
  }
  for (const key of ['needsRetrieval', 'requiresApproval']) {
    if (typeof input[key] === 'string' && /^(true|false)$/i.test(input[key] as string)) output[key] = input[key] === 'true'
  }
  if (typeof input.confidence === 'string' && input.confidence.trim() !== '') {
    const confidence = Number(input.confidence)
    if (Number.isFinite(confidence)) output.confidence = confidence
  }
  for (const key of ['query', 'reason', 'documentIds']) if (output[key] === null) delete output[key]
  return output
}

export const supervisorDecisionSchema = z.preprocess(normalizeSupervisorDecision, z.object({
  intent: z.enum(['knowledge_query', 'document_summary', 'document_compare', 'general_chat']),
  needsRetrieval: z.boolean(),
  query: z.string().max(4000).optional(),
  documentIds: z.array(z.string().uuid()).max(20).optional(),
  plan: z.array(z.enum(['search_knowledge', 'get_document', 'compare_documents', 'generate_answer'])).min(1).max(4),
  requiresApproval: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500).optional(),
}))

export type SupervisorDecision = z.infer<typeof supervisorDecisionSchema>
export type SupervisorContext = { workspaceId: string; userId: string; role?: string; trace?: TraceContext }

export function fallbackDecision(input: string): SupervisorDecision {
  return { intent: 'knowledge_query', needsRetrieval: true, query: input.slice(0, 4000), plan: ['search_knowledge', 'generate_answer'], requiresApproval: false, confidence: 0, reason: 'supervisor_fallback' }
}

export class SupervisorAgent {
  constructor(private readonly model: DeepSeekClient, private readonly options: { confidenceThreshold: number; maxRetries: number; model?: string; timeoutMs?: number } = { confidenceThreshold: 0.65, maxRetries: 1 }) {}

  async classify(input: string, context: SupervisorContext): Promise<{ decision: SupervisorDecision; fallback: boolean }> {
    const trimmed = input.trim()
    const control = this.controlDecision(trimmed)
    if (control) return { decision: control, fallback: false }
    const messages = [
      { role: 'system' as const, content: '你是企业知识库任务规划器。只输出一个合法 JSON 对象，不要 Markdown、代码围栏、解释或额外字段。输出格式示例：{"intent":"knowledge_query","needsRetrieval":true,"query":"问题改写，可选","documentIds":[],"plan":["search_knowledge","generate_answer"],"requiresApproval":false,"confidence":0.9,"reason":"可选简短原因"}。intent 只能是 knowledge_query、document_summary、document_compare、general_chat；plan 中每一项只能是 search_knowledge、get_document、compare_documents、generate_answer；plan 至少包含一项；confidence 必须是 0 到 1 的数字。只能选择允许的 intent 和 plan，不能执行工具、决定权限或编造事实。不明确时选择只读 knowledge_query。涉及写操作时 requiresApproval 必须为 true。' },
      { role: 'user' as const, content: JSON.stringify({ input: trimmed, workspaceId: context.workspaceId, role: context.role ?? 'viewer', allowedPlans: ['search_knowledge', 'get_document', 'compare_documents', 'generate_answer'] }) },
    ]
    try {
      const decision = await this.model.chatJson(messages, supervisorDecisionSchema, this.options.maxRetries, { model: this.options.model, timeoutMs: this.options.timeoutMs, trace: context.trace, operation: 'supervisor.classify' })
      if (decision.confidence < this.options.confidenceThreshold) return { decision: fallbackDecision(trimmed), fallback: true }
      return { decision, fallback: false }
    } catch {
      return { decision: fallbackDecision(trimmed), fallback: true }
    }
  }

  private controlDecision(input: string): SupervisorDecision | undefined {
    if (!input) return { intent: 'general_chat', needsRetrieval: false, plan: ['generate_answer'], requiresApproval: false, confidence: 1, reason: 'empty_input' }
    const lower = input.toLowerCase()
    const isApproval = lower.startsWith('approve:')
    const isQuestion = lower.startsWith('ask:')
    const isControl = isApproval || isQuestion || new Set(['cancel', 'stop', '继续', '拒绝']).has(input)
    if (isControl) return { intent: 'general_chat', needsRetrieval: false, plan: ['generate_answer'], requiresApproval: isApproval, confidence: 1, reason: 'control_input' }
    return undefined
  }
}

export type SupervisorSchema<T> = ZodSchema<T>
