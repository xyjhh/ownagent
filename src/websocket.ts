import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { AuthService } from './modules/auth/service.js'
import type { WorkspaceRepository } from './modules/workspaces/repository.js'
import type { RunService } from './modules/runs/service.js'
import type { RedisStreams } from './queue/redis-streams.js'
import type { AppConfig } from './config/env.js'
import { parseCookies } from './modules/auth/cookies.js'
import { ApiError } from './modules/auth/errors.js'
import { z } from 'zod'

type Client = {
  ws: WebSocket
  id: string
  userId: string
  subscriptions: Map<string, () => Promise<void>>
  seen: Map<string, number>
}
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('subscribe'),
    workspaceId: z.string().uuid(),
    runId: z.string().uuid(),
    lastSequence: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('start_run'),
    workspaceId: z.string().uuid(),
    question: z.string().min(1).max(20_000),
    conversationId: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.enum(['approve', 'reject']),
    workspaceId: z.string().uuid(),
    runId: z.string().uuid(),
    approvalId: z.string().min(1).max(120),
    value: z.boolean().optional(),
    reason: z.string().max(2000).optional(),
    messageId: z.string().max(120).optional(),
  }),
  z.object({
    type: z.literal('interrupt'),
    workspaceId: z.string().uuid(),
    runId: z.string().uuid(),
    reason: z.string().max(500).optional(),
    messageId: z.string().max(120).optional(),
  }),
  z.object({
    type: z.literal('follow_up'),
    workspaceId: z.string().uuid(),
    runId: z.string().uuid(),
    question: z.string().min(1).max(20_000),
    messageId: z.string().max(120).optional(),
  }),
])

export class RealtimeWebSocketServer {
  private readonly wss: WebSocketServer
  private readonly clients = new Set<Client>()
  constructor(
    private readonly server: HttpServer,
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly workspaceRepository: WorkspaceRepository,
    private readonly runService: RunService,
    private readonly queue: RedisStreams
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.config.WS_MAX_FRAME_BYTES })
    this.server.on('upgrade', (request, socket, head) => void this.upgrade(request, socket, head))
    this.wss.on(
      'connection',
      (ws: WebSocket, request: IncomingMessage, identity: { userId: string }) =>
        this.connection(ws, request, identity)
    )
  }
  private async upgrade(
    request: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer
  ) {
    try {
      if (this.clients.size >= this.config.WS_MAX_CONNECTIONS)
        throw new ApiError(503, 'WS_CAPACITY', 'WebSocket capacity reached')
      const origin = request.headers.origin
      if (
        origin &&
        !this.config.WEB_ORIGIN.split(',')
          .map(value => value.trim())
          .includes(origin)
      )
        throw new ApiError(403, 'WS_ORIGIN_FORBIDDEN', 'Origin is not allowed')
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws')
        throw new ApiError(404, 'WS_NOT_FOUND', 'WebSocket endpoint not found')
      const cookieHeader = request.headers.cookie
      const accessToken = cookieHeader
        ? parseCookies({ headers: { cookie: cookieHeader } } as never)[
            this.config.AUTH_COOKIE_ACCESS_NAME
          ]
        : undefined
      if (!accessToken) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required')
      const identity = await this.auth.authenticateAccessToken(accessToken)
      this.wss.handleUpgrade(request, socket, head, ws =>
        this.wss.emit('connection', ws, request, identity)
      )
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  }
  private connection(ws: WebSocket, _request: IncomingMessage, identity: { userId: string }) {
    const client: Client = {
      ws,
      id: randomUUID(),
      userId: identity.userId,
      subscriptions: new Map(),
      seen: new Map(),
    }
    this.clients.add(client)
    ws.send(JSON.stringify({ type: 'ready', connectionId: client.id, userId: identity.userId }))
    ws.on('message', data => void this.message(client, data))
    ws.on('close', () => {
      this.clients.delete(client)
      for (const close of client.subscriptions.values()) void close()
    })
    ws.on('error', () => ws.close())
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, this.config.WS_HEARTBEAT_INTERVAL_MS)
    ws.once('close', () => clearInterval(heartbeat))
  }
  private async message(client: Client, raw: RawData) {
    try {
      const parsed = messageSchema.safeParse(JSON.parse(raw.toString()))
      if (!parsed.success)
        throw new ApiError(400, 'WS_MESSAGE_INVALID', 'Invalid WebSocket message')
      const input = parsed.data as Record<string, unknown>
      const type = String(input.type ?? '')
      if (type === 'ping') return this.send(client, { type: 'pong' })
      const workspaceId = String(input.workspaceId ?? '')
      if (!workspaceId) throw new ApiError(400, 'WORKSPACE_REQUIRED', 'workspaceId is required')
      const membership = await this.workspaceRepository.findMembership(client.userId, workspaceId)
      if (!membership)
        throw new ApiError(403, 'WORKSPACE_FORBIDDEN', 'You are not a member of this workspace')
      if (type === 'start_run') {
        const question = typeof input.question === 'string' ? input.question : ''
        if (!question) throw new ApiError(400, 'INVALID_INPUT', 'question is required')
        const idempotencyKey =
          typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : ''
        if (!idempotencyKey || idempotencyKey.length > 200)
          throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required')
        const run = await this.runService.create(membership, { question, ...(typeof input.conversationId === 'string' ? { conversationId: input.conversationId } : {}) }, idempotencyKey)
        this.send(client, { type: 'run_created', run })
        return this.subscribe(client, workspaceId, run.id, 0)
      }
      const runId = String(input.runId ?? '')
      if (!runId) throw new ApiError(400, 'RUN_REQUIRED', 'runId is required')
      if (type === 'subscribe')
        return this.subscribe(client, workspaceId, runId, Number(input.lastSequence ?? 0))
      const controlId = String(input.messageId ?? input.controlId ?? randomUUID())
      if (type === 'approve' || type === 'reject') {
        const run = await this.runService.approve(
          membership,
          runId,
          String(input.approvalId ?? ''),
          type === 'approve',
          controlId,
          type === 'reject' && typeof input.reason === 'string' ? input.reason : undefined
        )
        return this.send(client, { type: 'status', runId, status: run?.status })
      }
      if (type === 'interrupt') {
        const run = await this.runService.control(
          membership,
          runId,
          'interrupt',
          { reason: String(input.reason ?? 'user_cancelled') },
          controlId
        )
        return this.send(client, { type: 'interrupted', runId, status: run?.status })
      }
      if (type === 'follow_up') {
        const question = typeof input.question === 'string' ? input.question : ''
        if (!question) throw new ApiError(400, 'INVALID_INPUT', 'question is required')
        const run = await this.runService.control(
          membership,
          runId,
          'follow_up',
          { question },
          controlId
        )
        return this.send(client, { type: 'status', runId, status: run?.status })
      }
      throw new ApiError(400, 'WS_MESSAGE_INVALID', 'Unsupported message type')
    } catch (error) {
      this.send(client, {
        type: 'error',
        code: error instanceof ApiError ? error.code : 'WS_ERROR',
        message: error instanceof ApiError ? error.message : 'Request failed',
      })
    }
  }
  private async subscribe(
    client: Client,
    workspaceId: string,
    runId: string,
    lastSequence: number
  ) {
    const key = `${workspaceId}:${runId}`
    const existing = client.subscriptions.get(key)
    if (existing) await existing()
    const close = await this.queue.subscribeEvents(runId, event => {
      if (String(event.workspaceId ?? workspaceId) !== workspaceId) return
      this.sendEvent(client, event)
    })
    client.subscriptions.set(key, close)
    const events = await this.runService.events(
      { userId: client.userId, workspaceId, role: 'viewer' },
      runId,
      lastSequence
    )
    if (events === null) throw new ApiError(404, 'NOT_FOUND', 'Run not found')
    for (const event of events) {
      const type =
        event.type === 'started' ? 'status' : event.type === 'canceled' ? 'interrupted' : event.type
      this.sendEvent(client, {
        type,
        runId,
        sequence: event.sequence,
        ...(type === 'status' ? { status: 'running' } : {}),
        payload: event.payload,
        createdAt: event.createdAt,
        workspaceId,
      })
    }
  }
  private sendEvent(client: Client, event: Record<string, unknown>) {
    const sequence = Number(event.sequence ?? 0)
    const runId = String(event.runId ?? '')
    if (runId && sequence) {
      const last = client.seen.get(runId) ?? 0
      if (sequence <= last) return
      client.seen.set(runId, sequence)
    }
    this.send(client, event)
  }
  private send(client: Client, value: Record<string, unknown>) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(value))
  }
}
