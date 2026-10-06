import { z, type ZodSchema } from 'zod'
import type { DeepSeekClient } from '../integrations/deepseek.js'

export const supervisorDecisionSchema = z.object({
  intent: z.enum(['knowledge_query', 'document_summary', 'document_compare', 'general_chat']),
  needsRetrieval: z.boolean(),
  query: z.string().max(4000).optional(),
  documentIds: z.array(z.string().uuid()).max(20).optional(),
  plan: z.array(z.enum(['search_knowledge', 'get_document', 'compare_documents', 'generate_answer'])).min(1).max(4),
  requiresApproval: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500).optional(),
})

export type SupervisorDecision = z.infer<typeof supervisorDecisionSchema>
export type SupervisorContext = { workspaceId: string; userId: string; role?: string }

export function fallbackDecision(input: string): SupervisorDecision {
  return { intent: 'knowledge_query', needsRetrieval: true, query: input.slice(0, 4000), plan: ['search_knowledge', 'generate_answer'], requiresApproval: false, confidence: 0, reason: 'supervisor_fallback' }
}

export class SupervisorAgent {
  constructor(private readonly model: DeepSeekClient, private readonly options: { confidenceThreshold: number; maxRetries: number; model?: string; timeoutMs?: number } = { confidenceThreshold: 0.65, maxRetries: 1 }) {}

  async classify(input: string, context: SupervisorContext): Promise<{ decision: SupervisorDecision; fallback: boolean }> {
    const trimmed = input.trim()
    const rule = this.ruleDecision(trimmed)
    if (rule) return { decision: rule, fallback: false }
    const messages = [
      { role: 'system' as const, content: '你是企业知识库任务规划器。只能输出符合要求的 JSON。只能选择允许的 intent 和 plan，不能执行工具、决定权限或编造事实。不明确时选择只读 knowledge_query。涉及写操作时 requiresApproval 必须为 true。' },
      { role: 'user' as const, content: JSON.stringify({ input: trimmed, workspaceId: context.workspaceId, role: context.role ?? 'viewer', allowedPlans: ['search_knowledge', 'get_document', 'compare_documents', 'generate_answer'] }) },
    ]
    try {
      const decision = await this.model.chatJson(messages, supervisorDecisionSchema, this.options.maxRetries, { model: this.options.model, timeoutMs: this.options.timeoutMs })
      if (decision.confidence < this.options.confidenceThreshold) return { decision: fallbackDecision(trimmed), fallback: true }
      return { decision, fallback: false }
    } catch {
      return { decision: fallbackDecision(trimmed), fallback: true }
    }
  }

  private ruleDecision(input: string): SupervisorDecision | undefined {
    if (!input) return { intent: 'general_chat', needsRetrieval: false, plan: ['generate_answer'], requiresApproval: false, confidence: 1, reason: 'empty_input' }
    if (/^(approve:|ask:|cancel$|stop$|继续$|拒绝$)/i.test(input)) return { intent: 'general_chat', needsRetrieval: false, plan: ['generate_answer'], requiresApproval: input.startsWith('approve:'), confidence: 1, reason: 'control_input' }
    if (/^(你好|嗨|hello|hi|谢谢|thanks)[!！。.]?$/i.test(input)) return { intent: 'general_chat', needsRetrieval: false, plan: ['generate_answer'], requiresApproval: false, confidence: 1, reason: 'greeting' }
    return undefined
  }
}

export type SupervisorSchema<T> = ZodSchema<T>
