# OwnAgent 本地开发环境

本环境与生产 Compose 完全隔离。开发电脑使用仓库内的 Supabase CLI 项目、独立 Redis、独立 Langfuse 数据卷，以及宿主机上的 API、Worker 和前端热更新进程。开发脚本不会调用生产 `docker-compose.yml`，也不会使用生产 `.env` 或生产数据卷。

## 首次设置

在 `E:\project\ownagent` 执行：

```powershell
npm install
if (-not (Test-Path .env.development)) { Copy-Item .env.development.example .env.development }
notepad .env.development
npm run setup:dev
```

至少填写 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 和需要使用的模型 API key。开发环境使用本机地址：API 是 `http://127.0.0.1:8787`，Supabase Studio 是 `http://127.0.0.1:54323`，Langfuse 是 `http://127.0.0.1:3002`。

缺少 DeepSeek、Embedding 或 DashScope 凭据时，API 仍可启动，但对应模型功能不可用，`/health/ready` 会报告这些依赖未配置。

`setup:dev` 首次会启动 Supabase、执行全部 migrations、启动开发 Redis/Langfuse，并创建 `dev-workspace`。管理员和 workspace seed 是幂等的。开发数据库只使用空数据和固定 seed，不复制生产数据。

## 日常启动

```powershell
cd E:\project\ownagent
npm run start:dev
```

后端进程日志在 `.runtime\dev\`。前端另开终端：

```powershell
cd E:\project\ownagentweb
npm install
npm run dev
```

前端访问 `http://127.0.0.1:5173`，Vite 将 `/api` 和 `/ws` 代理到本地 API。修改 API、Worker 或前端源码后会分别由 `tsx` 和 Vite 热更新。

停止开发环境：

```powershell
cd E:\project\ownagent
npm run stop:dev
```

停止只删除开发容器，保留开发卷。下次 `npm run start:dev` 会复用本地数据，不会执行 reset。

## 开发服务边界

开发 Redis 使用 `127.0.0.1:6380`，Langfuse 使用独立的 `ownagent-dev-*` 卷和 `127.0.0.1:3002`。Supabase CLI 使用 `54321` 到 `54324` 端口。开发环境不启动 Caddy、Cloudflare Tunnel 或生产 API/Worker。

不要在开发电脑的 `.env.development` 中填写生产 Supabase、Redis、Langfuse 或 Cloudflare 凭据。根目录 `.env` 可以与 `.env.development` 共存，但开发脚本始终通过 `--env-file .env.development` 和 `DOTENV_CONFIG_PATH` 读取开发配置；手动运行 Node 命令时也应显式设置 `DOTENV_CONFIG_PATH=.env.development`。

开发环境没有日常 reset 命令。需要彻底清理时，先执行 `npm run stop:dev`，再仅删除以下开发资源：

```powershell
docker volume rm ownagent-dev-redis-data ownagent-dev-langfuse-postgres ownagent-dev-langfuse-clickhouse ownagent-dev-langfuse-redis ownagent-dev-langfuse-minio
docker volume ls --filter 'label=com.supabase.cli.project=ownagent-dev' -q | ForEach-Object { docker volume rm $_ }
supabase stop --workdir E:\project\ownagent --yes
```

生产环境仍然使用根 Compose：

```powershell
docker compose up -d --build --wait
docker compose down
```

开发环境不要运行生产 `docker compose down -v`，也不要使用生产 `init:compose`。
