import { END, START, StateGraph, interrupt } from '@langchain/langgraph'

export type KnowledgeAgentState = {
  userId: string
  conversationId?: string
  input?: string
  output?: string
  requiresApproval?: boolean
}

export type KnowledgeAgentContext = {
  userId: string
  conversationId?: string
}

/** Minimal graph kept intentionally inert until knowledge retrieval is implemented. */
export function createKnowledgeAgentGraph(checkpointer?: unknown) {
  const graph: any = new StateGraph({
    channels: {
      userId: { reducer: (_left: string, right: string) => right, default: () => '' },
      conversationId: {
        reducer: (_left: string | undefined, right: string | undefined) => right,
        default: () => undefined,
      },
      input: {
        reducer: (_left: string | undefined, right: string | undefined) => right,
        default: () => undefined,
      },
      output: {
        reducer: (_left: string | undefined, right: string | undefined) => right,
        default: () => undefined,
      },
      requiresApproval: {
        reducer: (_left: boolean | undefined, right: boolean | undefined) => right,
        default: () => false,
      },
    },
  } as any)
  graph.addNode('placeholder', async (state: KnowledgeAgentState) => {
    if (state.input?.toLowerCase().startsWith('approve:') && !state.requiresApproval) {
      const value = interrupt({
        kind: 'approval',
        approvalId: `approval-${Date.now()}`,
        prompt: state.input.slice(8).trim() || 'Approve this action?',
        options: [true, false],
      }) as unknown as boolean
      return {
        output: value === false ? 'Rejected by user' : 'Approved by user',
        requiresApproval: true,
      }
    }
    if (state.input?.toLowerCase().startsWith('ask:')) {
      const answer = interrupt({
        kind: 'question',
        question: state.input.slice(4).trim() || 'Please provide more details.',
      }) as unknown as string
      return { output: String(answer), requiresApproval: true }
    }
    return { output: state.input ? `Agent received: ${state.input}` : '' }
  })
  graph.addEdge(START, 'placeholder')
  graph.addEdge('placeholder', END)
  return graph.compile(checkpointer ? { checkpointer } : undefined)
}
