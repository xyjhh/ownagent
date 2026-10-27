# OwnAgent Compose 启动与更新

本文档适用于 `E:\project\ownagent` 的统一 Docker Compose 部署。前端源码目录为同级目录 `E:\project\ownagentweb`。

## 1. 前置条件

- Docker Desktop 已启动，并且 Docker Engine 可用。
- 当前目录是 `E:\project\ownagent`。
- `.env` 已存在，并填写了 Supabase、Langfuse、Cloudflare Tunnel、Embedding、DeepSeek 等配置。
- 前端目录位于 `E:\project\ownagentweb`。Compose 的 `frontend` 服务会使用 `../ownagentweb` 作为构建上下文。

检查 Docker 和 Compose：

```powershell
docker version
docker compose version
```

## 2. 首次初始化

全新初始化只在明确放弃旧数据时执行：

```powershell
cd E:\project\ownagent
npm run init:compose
```

该脚本会删除本项目指定的 OwnAgent、Supabase 和 Langfuse 数据卷，并重新执行迁移。它会要求输入：

```text
DELETE OLD DATA
```

日常启动不要运行 `npm run init:compose`，也不要使用 `docker compose down -v`。这两个操作可能删除数据。

## 3. 启动全部服务

首次启动、代码更新后或 Docker 镜像需要重新构建时：

```powershell
cd E:\project\ownagent
docker compose up -d --build --wait
```

如果镜像已经构建过，只是电脑重启或服务被停止，可以跳过构建：

```powershell
docker compose up -d --wait
```

也可以使用项目脚本：

```powershell
npm run start:all:docker
```

这个脚本包含 `--build`，适合代码更新后使用。

检查服务状态：

```powershell
docker compose ps
```

所有必需服务应显示 `Up`；配置了健康检查的服务应显示 `healthy`。

## 4. 关闭和重新启动

### 停止并删除容器

```powershell
docker compose down
```

该命令会停止并删除容器和 Compose 网络，但保留数据库、Storage、Redis、Langfuse 和 Caddy 数据卷。

### 只停止服务

```powershell
docker compose stop
```

之后可以使用下面的命令恢复：

```powershell
docker compose start
```

### 使用项目脚本

```powershell
npm run stop:all:docker
```

## 5. 修改后端代码

后端 API 和所有 Worker 共用根目录的 `Dockerfile`。修改 `src`、后端依赖或 Dockerfile 后，在后端目录执行：

```powershell
docker compose up -d --build --wait
```

需要更新的后端服务包括：

- `api`
- `worker`
- `worker-2`
- `document-worker`
- `memory-worker`

它们使用同一个镜像，但通过不同的 `command` 运行不同的 Node 程序。

## 6. 修改前端代码

前端源码在 `E:\project\ownagentweb`。修改前端后，在后端目录执行：

```powershell
cd E:\project\ownagent
docker compose up -d --build --wait frontend
```

前端和后端一起修改时，可以使用同一条命令：

```powershell
docker compose up -d --build --wait
```

部署后浏览器使用 `Ctrl + F5` 强制刷新，避免继续使用旧的静态资源缓存。

## 7. 修改 `.env`

修改 `.env` 后，先验证 Compose 配置：

```powershell
docker compose config --quiet
```

没有输出表示配置语法通过。然后重新创建容器，使新环境变量生效：

```powershell
docker compose up -d --force-recreate --wait
```

如果只修改了 Embedding、DeepSeek、DashScope 或文档解析相关变量，可以只重建相关服务：

```powershell
docker compose up -d --force-recreate api worker worker-2 document-worker memory-worker --wait
```

如果修改了 Supabase、S3、Cloudflare Tunnel 或反向代理相关变量，建议重建全部服务。

验证某个容器是否读取了变量时，只输出非敏感变量名或脱敏后的值，不要把 `.env`、API Key、JWT 或 Tunnel Token 提交到 Git。

## 8. 查看日志

查看全部服务的最近日志：

```powershell
docker compose logs --tail=100
```

持续查看 API 和 Worker：

```powershell
docker compose logs -f api worker worker-2 document-worker memory-worker
```

查看前端、入口代理和 Tunnel：

```powershell
docker compose logs -f frontend caddy cloudflared
```

查看文档解析失败原因：

```powershell
docker compose logs --since 30m document-worker
```

## 9. 健康检查和访问地址

公网入口：

```text
https://www.xyjagent.cn
```

API 就绪检查：

```text
https://www.xyjagent.cn/health/ready
```

本机 API 检查：

```powershell
Invoke-WebRequest http://127.0.0.1:8787/health/live
Invoke-WebRequest http://127.0.0.1:8787/health/ready
```

Supabase Studio 默认只绑定本机：

```text
http://127.0.0.1:54323
```

Langfuse 默认只绑定本机：

```text
http://127.0.0.1:3001
```

## 10. 备份

执行备份：

```powershell
cd E:\project\ownagent
npm run backup:compose
```

备份目录包含 Supabase PostgreSQL 导出和 Storage 文件归档。备份前确认 Compose 正常运行。不要在备份或恢复过程中让多个容器同时写入同一批数据。

## 11. 数据库迁移

新增数据库迁移后，只执行尚未应用的 SQL 文件。生产环境不要重复执行已经成功应用的迁移，也不要通过重新初始化来应用普通迁移。

迁移完成后重新构建或重启相关服务：

```powershell
docker compose up -d --wait
```

迁移前建议先执行备份：

```powershell
npm run backup:compose
```

## 12. 常见问题

### Docker 拉取镜像失败

先确认 Docker Desktop 网络可用，再单独重试构建：

```powershell
docker compose build
docker compose up -d --wait
```

### 服务显示 unhealthy

查看对应服务日志：

```powershell
docker compose ps
docker compose logs --tail=200 <service-name>
```

不要先执行 `down -v`，因为这会删除数据卷。

### 修改 `.env` 后配置没有生效

环境变量是在容器创建时注入的。使用：

```powershell
docker compose up -d --force-recreate --wait
```

### 文档上传成功但解析失败

先确认 `document-worker` 正常运行，再检查 Embedding 服务地址、API Key、模型名和网络连接：

```powershell
docker compose ps document-worker
docker compose logs --since 30m document-worker
```

修改配置后重建 API 和所有 Worker，再从前端重新触发解析。

### 只想重启一个服务

```powershell
docker compose restart api
docker compose restart document-worker
```

如果修改了代码或环境变量，应使用 `--build` 或 `--force-recreate`，单纯 `restart` 不会重新构建镜像，也不会重新读取新的环境变量。
