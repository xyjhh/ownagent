# ownagent API

个人知识库 Agent 的 Express 后端基础框架。当前版本包含自建 JWT/Cookie 认证、Supabase 独立 `ownagent` schema、Workspace 隔离、Redis Streams 任务和 `/ws` 双向实时通道，以及 DeepSeek / Embedding / Reranker / LangGraph 的类型化骨架。

## 本地启动

1. 复制环境变量模板并填写 Supabase service-role key、JWT secret 和管理员密码：

   ```powershell
   Copy-Item .env.example .env
   ```

   `AUTH_JWT_SECRET` 至少 32 个字符。`SUPABASE_SERVICE_ROLE_KEY` 只能放在后端环境，不能交给浏览器。

2. 在共享的 Supabase 项目中执行 `supabase/migrations/001_auth.sql`（本地 Supabase 可使用 `supabase db push`）。迁移会创建并授权专用的 `ownagent` schema；不会读取或修改其他项目的业务表。

   如果使用 Supabase 的 REST API，需要在 Dashboard 的 **Settings → API → Exposed schemas** 中加入 `ownagent`。本服务使用 service-role，并会在代码中显式选择 `SUPABASE_DB_SCHEMA`，不会依赖默认 `public` schema。

3. 创建唯一所有者账号：

   ```powershell
   npm run auth:bootstrap
   ```

4. 启动 API：

   ```powershell
   npm run dev
   ```

默认监听 `http://127.0.0.1:8787`。本机嵌入服务和重排服务分别沿用参考项目的 `8002`、`8001` 端口；它们未启动时不会阻塞认证服务。

## 本地模型服务

本项目提供统一的模型服务脚本。当前电脑上已有的 DirectML Embedding 服务和 Reranker Docker Compose 项目位于 `ownagent` 的同级参考项目中；脚本会复用它们已有的模型与依赖，不会重复下载模型。

```powershell
npm run models:start
npm run models:status
npm run models:stop
```

`models:start` 会启动本机 `Qwen3-Embedding-0.6B` ONNX/DirectML 服务（`127.0.0.1:8002`）及 Docker 中的 `Qwen3-Reranker-0.6B` 服务（`127.0.0.1:8001`），并等待两个 `/health` 端点可用。嵌入服务日志写入 `.runtime/embedding.out.log` 与 `.runtime/embedding.err.log`。`models:stop` 只停止服务，不会删除 Docker 中已经下载的重排模型卷。

如服务目录移动，可设置 `OWNAGENT_EMBEDDING_SERVICE_DIR` 和 `OWNAGENT_RERANKER_SERVICE_DIR`，或把这两个值作为同名脚本参数传入。

## 认证接口

```text
POST /api/auth/login    { email, password }
POST /api/auth/refresh  { refreshToken }
POST /api/auth/logout   { refreshToken }  + Authorization: Bearer <accessToken>
GET  /api/auth/me       + Authorization: Bearer <accessToken>
```

access token 有效期默认 15 分钟，refresh token 默认 30 天且每次刷新轮换。重复使用已经轮换的 refresh token 会撤销整个 token family。

## 检查与测试

```powershell
npm run build
npm test
```

- `GET /health/live` 只检查进程是否存活。
- `GET /health/ready` 检查 Supabase，并列出 DeepSeek、DirectML Embedding、Qwen3 Reranker 的状态；模型依赖是非阻塞项。

当前认证使用 Express 自建 JWT 和 service-role 数据库访问，所有后续业务 Repository 必须显式传入并过滤 `userId`。认证表位于 `ownagent` schema，已启用 RLS 且对 `anon` / `authenticated` 默认拒绝；service-role key 只允许在服务端使用。不要把其他项目的表名、查询或迁移放入这个 schema。

## Workspace、多租户和任务

- `GET/POST /api/workspaces`：列出或创建 workspace。
- `POST /api/workspaces/:workspaceId/invites`：owner/admin 邀请成员。
- `POST /api/invites/:token/accept`：被邀请用户接受邀请。
- `GET/POST /api/workspaces/:workspaceId/documents`：按 workspace 权限列出或写入文档。
- `POST /api/workspaces/:workspaceId/search`：先做 workspace/private ACL 过滤，再 Embedding 和 Reranker。
- `POST /api/workspaces/:workspaceId/runs`：使用 `X-Idempotency-Key` 创建幂等 Agent 任务。
- `GET/POST /api/workspaces/:workspaceId/runs/:runId`：查询任务、事件和取消任务。

API 只创建和管理任务；Worker 负责 LangGraph 执行。启动 Worker：

```powershell
npm run dev:worker
```

前端可通过 `ws://127.0.0.1:8787/ws` 建立双向连接。登录或刷新响应会同时设置 HttpOnly Cookie；浏览器会自动在 WebSocket 握手时携带 Cookie。连接后发送 `subscribe`、`start_run`、`approve`、`reject`、`interrupt`、`follow_up` 消息即可接收实时状态、审批和 token 事件。断线重连时使用 `lastSequence`，服务端会先补发 `agent_run_events` 历史记录，再接收 Redis Pub/Sub 实时事件。

多实例部署可使用 `docker compose up --build`。Redis Streams 使用 `ownagent:agent-runs`，Postgres `agent_runs` 是任务最终事实来源，`task_outbox` 负责在数据库提交后补发消息。

Redis 由 OwnAgent 自己的 Compose 服务提供，数据保存在 `ownagent-redis` Docker volume。Compose 内的 API/Worker 使用 `redis://redis:6379`，本机执行 `npm run dev` 或 `npm run dev:worker` 时使用 `.env` 中的 `redis://127.0.0.1:6379`；Redis 同时发布到本机回环地址 `6379`。如果该端口被其他项目占用，请先停止占用它的容器，或统一修改端口映射和 `.env` 中的 `REDIS_URL`。

Redis 任务 Stream 只作为短期传输层：Worker 成功处理后会原子执行 `XACK + XDEL`，因此不会因为已完成任务长期累积。`ownagent:dead-letter` 使用近似 `MAXLEN` 限制保留数量；Redis 默认启用 `maxmemory 512mb` 和 `noeviction`，达到上限时拒绝新写入，任务会继续留在 Postgres Outbox，不会静默丢失。Redis 内存、Stream 长度、Pending 和 Outbox 积压可通过 `/health/ready` 查看。

Outbox 采用 PostgreSQL `LISTEN/NOTIFY` 事件驱动，不使用周期性轮询。Dispatcher 启动和数据库重连时会扫描一次未发布记录；正常创建任务会在事务提交后立即唤醒分发。

执行新增 migration 前，请先确认目标 Supabase 项目和备份策略：

```text
supabase/migrations/002_enterprise_foundation.sql
supabase/migrations/003_realtime_agent.sql
supabase/migrations/004_outbox_notify.sql
supabase/migrations/005_realtime_agent_patch.sql
supabase/migrations/006_outbox_retry_delay.sql
```

`005_realtime_agent_patch.sql` 是针对已执行过原始 `003_realtime_agent.sql` 的独立幂等补丁；本次对第三个脚本的修复全部放在该文件中，`003` 本身不需要重复修改或执行。它会补齐事件/Outbox 的非空 Workspace 约束、并发安全的事件序号和审批过期处理。上述迁移只创建或修改 `ownagent` schema 内的对象，不会自动执行其他项目的 migration。

执行顺序为 `001_auth.sql` → `002_enterprise_foundation.sql` → `003_realtime_agent.sql` → `004_outbox_notify.sql` → `005_realtime_agent_patch.sql` → `006_outbox_retry_delay.sql`。如果前五个脚本已经执行，只需补执行 `006`；执行前请确认目标 Supabase 项目及备份策略。
