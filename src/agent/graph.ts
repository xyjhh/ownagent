import { END, START, StateGraph, interrupt } from '@langchain/langgraph'
import type { DocumentContext, Evidence, DocumentReadResult, ComparisonSource } from '../modules/documents/types.js'
import type { DocumentRepository } from '../modules/documents/repository.js'
import type { DocumentTools } from './tools/documents.js'
import type { RetrievalAgent } from './tools/knowledge.js'
import type { RetrievalMode, SearchExecutionMode } from '../modules/documents/search.js'
import type {
  ConversationRepository,
  ConversationMessage,
} from '../modules/conversations/repository.js'
import type { MemoryItem, MemoryRepository } from '../modules/memory/repository.js'
import type { DeepSeekClient } from '../integrations/deepseek.js'
import { SupervisorAgent, type SupervisorDecision, fallbackDecision } from './supervisor.js'
import { z } from 'zod'

export const CitationSchema = z.object({ documentId: z.string().uuid().or(z.string().min(1)), versionId: z.string().uuid().or(z.string().min(1)), chunkId: z.string().uuid().or(z.string().min(1)), title: z.string().max(500), pageNumber: z.number().int().optional(), headingPath: z.array(z.string()).optional(), quote: z.string().max(2000).optional() })
export const MemoryCandidateSchema = z.object({ scope: z.enum(['user', 'workspace']), type: z.enum(['preference', 'fact', 'instruction']), key: z.string().min(1).max(100), value: z.record(z.string(), z.unknown()), summary: z.string().min(1).max(500), confidence: z.number().min(0).max(1), sensitivity: z.enum(['normal', 'sensitive']), autoSave: z.boolean(), sourceMessageId: z.string().optional() })
function normalizeMemoryCandidate(value: unknown, index: number) {
  const candidate = typeof value === 'string'
    ? { content: value }
    : value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const category = String(candidate.type ?? candidate.category ?? '').toLowerCase()
  const type = category.includes('instruction') || category.includes('指令')
    ? 'instruction'
    : category.includes('fact') || category.includes('事实')
      ? 'fact'
      : 'preference'
  const summary = String(candidate.summary ?? candidate.content ?? candidate.text ?? '').trim()
  const key = String(candidate.key ?? `${type}:${summary.slice(0, 80) || index}`).trim()
  const rawValue = candidate.value
  const valueObject = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
    ? rawValue
    : { content: rawValue ?? candidate.content ?? summary }
  return {
    scope: candidate.scope === 'workspace' ? 'workspace' : 'user',
    type,
    key,
    value: valueObject,
    summary: summary || key,
    confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0.8,
    sensitivity: candidate.sensitivity === 'sensitive' ? 'sensitive' : 'normal',
    autoSave: typeof candidate.autoSave === 'boolean'
      ? candidate.autoSave
      : category.includes('preference') || category.includes('偏好'),
    sourceMessageId: typeof candidate.sourceMessageId === 'string' ? candidate.sourceMessageId : undefined,
  }
}

const NormalizedMemoryCandidatesSchema = z.preprocess(value => {
  if (Array.isArray(value)) return { candidates: value.map(normalizeMemoryCandidate) }
  if (!value || typeof value !== 'object') return { candidates: [] }
  const response = value as Record<string, unknown>
  const candidates = response.candidates ?? response.memories ?? response.memory_candidates ?? response.memory ?? response.items
  return { candidates: Array.isArray(candidates) ? candidates.map(normalizeMemoryCandidate) : [] }
}, z.object({ candidates: z.array(MemoryCandidateSchema).max(20) }))
export const MemoryCandidatesSchema = NormalizedMemoryCandidatesSchema
export const DocumentSummarySchema = z.object({ summary: z.string().max(8000), keyPoints: z.array(z.string().max(1000)).max(30), citations: z.array(CitationSchema).max(30) })
export const DocumentComparisonSchema = z.object({ topics: z.array(z.object({ topic: z.string().max(300), left: z.string().max(2000), right: z.string().max(2000), changeType: z.enum(['added', 'removed', 'changed', 'unchanged']), citations: z.array(CitationSchema).max(20) })).max(50), conclusion: z.string().max(5000) })
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>
export type DocumentComparison = z.infer<typeof DocumentComparisonSchema>

export type UserIntent =
  | 'knowledge_query'
  | 'document_summary'
  | 'document_compare'
  | 'general_chat'
export type Citation = {
  documentId: string
  versionId: string
  chunkId: string
  title: string
  pageNumber?: number
  headingPath?: string[]
  quote?: string
}
export type MemoryCandidate = {
  scope: 'user' | 'workspace'
  type: 'preference' | 'fact' | 'instruction'
  key: string
  value: Record<string, unknown>
  summary: string
  confidence: number
  sensitivity: 'normal' | 'sensitive'
  autoSave: boolean
  sourceMessageId?: string
}
export type KnowledgeAgentState = {
  workspaceId: string
  userId: string
  runId: string
  conversationId?: string
  input?: string
  intent?: UserIntent
  recentMessages?: ConversationMessage[]
  conversationSummary?: string
  memories?: MemoryItem[]
  evidence?: Evidence[]
  answer?: string
  citations?: Citation[]
  memoryCandidates?: MemoryCandidate[]
  requiresMemoryConfirmation?: boolean
  output?: string
  supervisorDecision?: SupervisorDecision
  supervisorFallback?: boolean
  planRejected?: boolean
  requiresApproval?: boolean
  documentSources?: ComparisonSource[]
  summary?: DocumentSummary
  comparison?: DocumentComparison
  retrieval?: { mode: SearchExecutionMode; vectorCount: number; lexicalCount: number; failures: string[] }
}
export type KnowledgeGraphDeps = {
  retrieval?: RetrievalAgent
  conversations?: ConversationRepository
  memories?: MemoryRepository
  model?: DeepSeekClient
  supervisor?: SupervisorAgent
  documents?: DocumentRepository
  documentTools?: DocumentTools
  retrievalMode?: RetrievalMode
}

export function createKnowledgeAgentGraph(checkpointer?: unknown, deps: KnowledgeGraphDeps = {}) {
  const graph: any = new StateGraph({
    channels: {
      userId: { reducer: (_: string, v: string) => v, default: () => '' },
      workspaceId: { reducer: (_: string, v: string) => v, default: () => '' },
      runId: { reducer: (_: string, v: string) => v, default: () => '' },
      conversationId: {
        reducer: (_: string | undefined, v: string | undefined) => v,
        default: () => undefined,
      },
      input: {
        reducer: (_: string | undefined, v: string | undefined) => v,
        default: () => undefined,
      },
      intent: {
        reducer: (_: UserIntent | undefined, v: UserIntent) => v,
        default: () => 'knowledge_query',
      },
      recentMessages: {
        reducer: (_: ConversationMessage[], v: ConversationMessage[]) => v,
        default: () => [],
      },
      conversationSummary: {
        reducer: (_: string | undefined, v: string | undefined) => v,
        default: () => undefined,
      },
      memories: { reducer: (_: MemoryItem[], v: MemoryItem[]) => v, default: () => [] },
      evidence: { reducer: (_: Evidence[], v: Evidence[]) => v, default: () => [] },
      answer: { reducer: (_: string | undefined, v: string) => v, default: () => undefined },
      citations: { reducer: (_: Citation[], v: Citation[]) => v, default: () => [] },
      memoryCandidates: {
        reducer: (_: MemoryCandidate[], v: MemoryCandidate[]) => v,
        default: () => [],
      },
      requiresMemoryConfirmation: { reducer: (_: boolean, v: boolean) => v, default: () => false },
      output: { reducer: (_: string | undefined, v: string) => v, default: () => undefined },
      requiresApproval: {
        reducer: (_: boolean | undefined, v: boolean) => v,
        default: () => false,
      },
      supervisorDecision: { reducer: (_: SupervisorDecision | undefined, v: SupervisorDecision | undefined) => v, default: () => undefined },
      supervisorFallback: { reducer: (_: boolean | undefined, v: boolean | undefined) => v, default: () => false },
      planRejected: { reducer: (_: boolean | undefined, v: boolean | undefined) => v, default: () => false },
      documentSources: { reducer: (_: ComparisonSource[], v: ComparisonSource[]) => v, default: () => [] },
      summary: { reducer: (_: DocumentSummary | undefined, v: DocumentSummary | undefined) => v, default: () => undefined },
      comparison: { reducer: (_: DocumentComparison | undefined, v: DocumentComparison | undefined) => v, default: () => undefined },
      retrieval: { reducer: (_: KnowledgeAgentState['retrieval'], v: KnowledgeAgentState['retrieval']) => v, default: () => undefined },
    },
  } as any)
  graph.addNode('load_context', async (state: KnowledgeAgentState) => ({
    recentMessages:
      deps.conversations && state.conversationId
        ? await deps.conversations.recent(state.conversationId, 12)
        : [],
    conversationSummary:
      deps.conversations && state.conversationId
        ? await deps.conversations.summary(state.conversationId)
        : undefined,
    memories: deps.memories ? await deps.memories.list(state.workspaceId, state.userId) : [],
  }))
  graph.addNode('prefilter_input', async (state: KnowledgeAgentState) => ({ input: (state.input ?? '').slice(0, 4000) }))
  graph.addNode('supervisor_plan', async (state: KnowledgeAgentState) => {
    const result = deps.supervisor ? await deps.supervisor.classify(state.input ?? '', { workspaceId: state.workspaceId, userId: state.userId }) : { decision: fallbackDecision(state.input ?? ''), fallback: true }
    return { supervisorDecision: result.decision, supervisorFallback: result.fallback, intent: result.decision.intent }
  })
  graph.addNode('validate_plan', async (state: KnowledgeAgentState) => {
    const decision = state.supervisorDecision ?? fallbackDecision(state.input ?? '')
    const allowed = new Set(['search_knowledge', 'get_document', 'compare_documents', 'generate_answer'])
    const needsDocuments = Boolean(decision.documentIds?.length || decision.plan.includes('get_document') || decision.plan.includes('compare_documents'))
    const valid = decision.plan.every(item => allowed.has(item)) && (decision.requiresApproval ? decision.plan.includes('generate_answer') : true) && (decision.needsRetrieval === decision.plan.includes('search_knowledge')) && (!needsDocuments || Boolean(deps.documents || deps.documentTools))
    if (valid && decision.documentIds?.length && (deps.documents || deps.documentTools)) {
      try {
        const context = { userId: state.userId, workspaceId: state.workspaceId, role: 'viewer' } as DocumentContext
        if (decision.intent === 'document_compare') {
          if (deps.documentTools) await deps.documentTools.compareDocumentSources(context, decision.documentIds)
          else await deps.documents!.getComparisonSources(context, decision.documentIds)
        } else for (const id of decision.documentIds) {
          if (deps.documentTools) await deps.documentTools.getDocument(context, id)
          else await deps.documents!.getAuthorized(context, id)
        }
      } catch { return { supervisorDecision: fallbackDecision(state.input ?? ''), supervisorFallback: true, planRejected: true, intent: 'knowledge_query' } }
    }
    return valid ? {} : { supervisorDecision: fallbackDecision(state.input ?? ''), supervisorFallback: true, planRejected: true, intent: 'knowledge_query' }
  })
  graph.addNode('route_plan', async (state: KnowledgeAgentState) => {
    const decision = state.supervisorDecision ?? fallbackDecision(state.input ?? '')
    if (decision.requiresApproval) interrupt({ kind: 'approval', prompt: 'This action requires approval', options: [true, false] })
    return {}
  })
  graph.addNode('retrieve_evidence', async (state: KnowledgeAgentState) => {
    if (!deps.retrieval || !state.supervisorDecision?.plan.includes('search_knowledge')) return { evidence: [] }
    const result = await deps.retrieval.search(
      { userId: state.userId, workspaceId: state.workspaceId, role: 'viewer' } as DocumentContext,
      { query: state.supervisorDecision?.query ?? state.input ?? '', documentIds: state.supervisorDecision?.documentIds, limit: 8, mode: deps.retrievalMode ?? 'hybrid' }
    )
    return { evidence: result.evidence, retrieval: result.retrieval }
  })
  graph.addNode('read_documents', async (state: KnowledgeAgentState) => {
    const decision = state.supervisorDecision
    if ((!deps.documents && !deps.documentTools) || !decision?.documentIds?.length || (!decision.plan.includes('get_document') && !decision.plan.includes('compare_documents'))) return { documentSources: [] }
    try { const context = { userId: state.userId, workspaceId: state.workspaceId, role: 'viewer' } as DocumentContext; return { documentSources: decision.plan.includes('compare_documents') ? (deps.documentTools ? await deps.documentTools.compareDocumentSources(context, decision.documentIds) : await deps.documents!.getComparisonSources(context, decision.documentIds)) : await Promise.all(decision.documentIds.map(id => deps.documentTools ? deps.documentTools.getDocument(context, id) : deps.documents!.getAuthorized(context, id))) } } catch { return { documentSources: [] } }
  })
  graph.addNode('summarize_document', async (state: KnowledgeAgentState) => {
    if (state.intent !== 'document_summary' || !deps.model || !state.documentSources?.length) return {}
    const source = state.documentSources[0]
    const result = await deps.model.chatJson([{ role: 'system', content: '请仅根据提供的文档内容输出 JSON 摘要，不得编造引用。' }, { role: 'user', content: JSON.stringify({ title: source.title, versionId: source.versionId, chunks: source.chunks, request: state.input }) }], DocumentSummarySchema)
    const validIds = new Set(source.chunks.map(c => c.chunkId)); result.citations = result.citations.filter(c => c.documentId === source.documentId && c.versionId === source.versionId && validIds.has(c.chunkId)); return { summary: result, answer: result.summary, citations: result.citations }
  })
  graph.addNode('compare_documents', async (state: KnowledgeAgentState) => {
    if (state.intent !== 'document_compare' || !deps.model || !state.documentSources?.length) return {}
    const valid = new Set(state.documentSources.flatMap(s => s.chunks.map(c => `${s.documentId}:${s.versionId}:${c.chunkId}`)))
    const result = await deps.model.chatJson([{ role: 'system', content: '请仅根据已授权文档输出 JSON 比较结果，不得编造引用。' }, { role: 'user', content: JSON.stringify({ documents: state.documentSources, request: state.input }) }], DocumentComparisonSchema)
    result.topics = result.topics.map(topic => ({ ...topic, citations: topic.citations.filter(c => valid.has(`${c.documentId}:${c.versionId}:${c.chunkId}`)) })); return { comparison: result, answer: `${result.conclusion}\n${result.topics.map(t => `${t.topic}: ${t.left} / ${t.right}`).join('\n')}`, citations: result.topics.flatMap(t => t.citations) }
  })
  graph.addNode('build_prompt', async (state: KnowledgeAgentState) => ({
    output: JSON.stringify({
      summary: state.conversationSummary,
      messages: state.recentMessages,
      memories: state.memories,
      evidence: state.evidence,
      input: state.input,
    }),
  }))
  graph.addNode('generate_answer_stream', async (state: KnowledgeAgentState) => {
    if ((state.intent === 'document_summary' || state.intent === 'document_compare') && state.answer) return { output: state.answer }
    const citations = (state.evidence ?? []).map(e => ({
      documentId: e.documentId,
      versionId: e.versionId,
      chunkId: e.chunkId,
      title: e.title,
      pageNumber: e.pageNumber,
      headingPath: e.headingPath,
    }))
    if (!deps.model)
      return {
        answer: state.evidence?.length ? state.evidence[0].content : '知识库中没有足够依据。',
        citations,
      }
    const evidenceText = (state.evidence ?? [])
      .map((e, i) => `[${i + 1}] ${e.title}\n${e.content}`)
      .join('\n\n')
    let answer = ''
    for await (const delta of deps.model.streamChat([
      {
        role: 'system',
        content:
          '你是企业知识库助手。只能基于提供的证据陈述企业事实；证据不足时明确说明，不得伪造引用。回答中使用 [1]、[2] 标记证据。',
      },
      {
        role: 'user',
        content: `历史摘要：${state.conversationSummary ?? ''}\n证据：\n${evidenceText}\n问题：${state.input ?? ''}`,
      },
    ]))
      answer += delta
    return { answer, output: answer, citations }
  })
  graph.addNode('extract_memory_candidates', async (state: KnowledgeAgentState) => {
    if (!deps.model || !state.input) return { memoryCandidates: [], requiresMemoryConfirmation: false }
    try {
      const result = await deps.model.chatJson([{ role: 'system', content: '只提取用户明确表达的长期记忆候选，禁止推测。敏感信息和事实不得自动保存。只输出 JSON，顶层必须是 {"candidates":[]}；候选字段必须包含 scope、type、key、value、summary、confidence、sensitivity、autoSave。没有候选时输出 {"candidates":[]}。' }, { role: 'user', content: JSON.stringify({ input: state.input, sourceMessageId: undefined }) }], MemoryCandidatesSchema)
      const candidates: MemoryCandidate[] = result.candidates.map(c => ({ ...c, autoSave: c.autoSave && c.sensitivity === 'normal' && c.confidence >= 0.8 }))
      return { memoryCandidates: candidates, requiresMemoryConfirmation: candidates.some(c => !c.autoSave) }
    } catch { return { memoryCandidates: [], requiresMemoryConfirmation: false } }
  })
  graph.addNode('persist_response', async (state: KnowledgeAgentState) => {
    if (deps.conversations && state.conversationId && state.answer)
      await deps.conversations.append({
        conversationId: state.conversationId,
        workspaceId: state.workspaceId,
        userId: state.userId,
        role: 'assistant',
        content: state.answer,
        citations: state.citations ?? [],
      })
    for (const candidate of state.memoryCandidates ?? []) {
      if (deps.memories?.enqueueTask) {
        try {
          await deps.memories.enqueueTask({ workspaceId: state.workspaceId, userId: state.userId, conversationId: state.conversationId, runId: state.runId, taskType: 'persist_candidate', payload: { candidate } })
        } catch {
          // Memory persistence is intentionally decoupled from the completed answer.
        }
      } else if (deps.memories) {
        await deps.memories.create({ ...candidate, workspaceId: state.workspaceId, userId: state.userId, status: candidate.autoSave ? 'active' : 'pending_confirmation', sourceConversationId: state.conversationId, sourceRunId: state.runId })
      }
    }
    if (deps.memories?.enqueueTask && state.conversationId) {
      try {
        await deps.memories.enqueueTask({ workspaceId: state.workspaceId, userId: state.userId, conversationId: state.conversationId, runId: state.runId, taskType: 'summarize_conversation', payload: { conversationId: state.conversationId } })
      } catch {
        // Summary generation is asynchronous and must not affect the answer outcome.
      }
    }
    return { output: state.answer }
  })
  graph.addNode('placeholder', async (state: KnowledgeAgentState) => {
    if (state.input?.toLowerCase().startsWith('approve:') && !state.requiresApproval) {
      interrupt({
        kind: 'approval',
        approvalId: `approval-${Date.now()}`,
        prompt: state.input.slice(8).trim() || 'Approve this action?',
        options: [true, false],
      })
      return { requiresApproval: true }
    }
    if (state.input?.toLowerCase().startsWith('ask:')) {
      interrupt({
        kind: 'question',
        question: state.input.slice(4).trim() || 'Please provide more details.',
      })
      return { requiresApproval: true }
    }
    return {}
  })
  graph.addEdge(START, 'load_context')
  graph.addEdge('load_context', 'prefilter_input')
  graph.addEdge('prefilter_input', 'supervisor_plan')
  graph.addEdge('supervisor_plan', 'validate_plan')
  graph.addEdge('validate_plan', 'route_plan')
  graph.addEdge('route_plan', 'retrieve_evidence')
  graph.addEdge('retrieve_evidence', 'read_documents')
  graph.addEdge('read_documents', 'summarize_document')
  graph.addEdge('summarize_document', 'compare_documents')
  graph.addEdge('compare_documents', 'build_prompt')
  graph.addEdge('build_prompt', 'generate_answer_stream')
  graph.addEdge('generate_answer_stream', 'extract_memory_candidates')
  graph.addEdge('extract_memory_candidates', 'persist_response')
  graph.addEdge('persist_response', 'placeholder')
  graph.addEdge('placeholder', END)
  return graph.compile(checkpointer ? { checkpointer } : undefined)
}
