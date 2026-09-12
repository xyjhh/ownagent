create extension if not exists vector;
create schema if not exists ownagent;

create table if not exists ownagent.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_by uuid not null references ownagent.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ownagent.workspace_members (
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  user_id uuid not null references ownagent.app_users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists ownagent.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  invited_by uuid not null references ownagent.app_users(id),
  email text not null,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references ownagent.app_users(id),
  created_at timestamptz not null default now()
);

create table if not exists ownagent.auth_sessions (
  id uuid primary key,
  user_id uuid not null references ownagent.app_users(id) on delete cascade,
  user_agent text,
  ip_hash text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table ownagent.auth_refresh_tokens add column if not exists session_id uuid references ownagent.auth_sessions(id) on delete cascade;
create index if not exists workspace_members_user_idx on ownagent.workspace_members(user_id, status);
create index if not exists workspace_invites_email_idx on ownagent.workspace_invites(email, expires_at);
create index if not exists auth_sessions_user_idx on ownagent.auth_sessions(user_id, created_at desc);
create index if not exists auth_refresh_tokens_session_idx on ownagent.auth_refresh_tokens(session_id);

create table if not exists ownagent.audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid references ownagent.app_users(id) on delete set null,
  workspace_id uuid references ownagent.workspaces(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  request_id text,
  ip_hash text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists ownagent.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  owner_id uuid not null references ownagent.app_users(id),
  title text not null,
  content text not null,
  visibility text not null default 'workspace' check (visibility in ('workspace', 'private')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ownagent.knowledge_document_members (
  document_id uuid not null references ownagent.knowledge_documents(id) on delete cascade,
  user_id uuid not null references ownagent.app_users(id) on delete cascade,
  primary key (document_id, user_id)
);

create table if not exists ownagent.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references ownagent.knowledge_documents(id) on delete cascade,
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  metadata jsonb not null default '{}',
  embedding vector(1024),
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index if not exists knowledge_chunks_workspace_idx on ownagent.knowledge_chunks(workspace_id, document_id);
create index if not exists knowledge_documents_workspace_idx on ownagent.knowledge_documents(workspace_id, visibility);

create table if not exists ownagent.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  created_by uuid not null references ownagent.app_users(id),
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ownagent.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references ownagent.conversations(id) on delete cascade,
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  user_id uuid not null references ownagent.app_users(id),
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  citations jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists ownagent.agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  requested_by uuid not null references ownagent.app_users(id),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'canceled')),
  input jsonb not null,
  idempotency_key text not null,
  attempt integer not null default 0,
  max_attempts integer not null default 5,
  langgraph_thread_id text not null unique,
  langfuse_trace_id text,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table if not exists ownagent.agent_run_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references ownagent.agent_runs(id) on delete cascade,
  sequence_no integer not null,
  event_type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (run_id, sequence_no)
);

create table if not exists ownagent.task_outbox (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ownagent.agent_runs(id) on delete cascade,
  stream text not null,
  payload jsonb not null,
  published_at timestamptz,
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists task_outbox_pending_idx on ownagent.task_outbox(available_at, created_at) where published_at is null;

create or replace function ownagent.create_agent_run(
  p_workspace_id uuid,
  p_requested_by uuid,
  p_input jsonb,
  p_idempotency_key text,
  p_max_attempts integer default 5
) returns ownagent.agent_runs
language plpgsql security definer set search_path = ownagent, public
as $$
declare result ownagent.agent_runs;
begin
  select * into result from ownagent.agent_runs
    where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then return result; end if;
  begin
    insert into ownagent.agent_runs(workspace_id, requested_by, input, idempotency_key, max_attempts, langgraph_thread_id)
      values (p_workspace_id, p_requested_by, p_input, p_idempotency_key, p_max_attempts, 'ownagent-' || gen_random_uuid()::text)
      returning * into result;
    insert into ownagent.task_outbox(run_id, stream, payload)
      values (result.id, 'ownagent:agent-runs', jsonb_build_object('runId', result.id));
    return result;
  exception when unique_violation then
    select * into result from ownagent.agent_runs
      where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
    return result;
  end;
end;
$$;

create or replace function ownagent.search_knowledge_chunks(
  p_workspace_id uuid,
  p_user_id uuid,
  p_query_embedding text,
  p_limit integer default 20
) returns table(chunk_id uuid, document_id uuid, title text, content text, metadata jsonb, score real)
language sql security definer set search_path = ownagent, public
as $$
  select kc.id, kd.id, kd.title, kc.content, kc.metadata,
    (1 - (kc.embedding <=> p_query_embedding::vector(1024)))::real
  from ownagent.knowledge_chunks kc
  join ownagent.knowledge_documents kd on kd.id = kc.document_id
  where kc.workspace_id = p_workspace_id
    and (kd.visibility = 'workspace' or kd.owner_id = p_user_id or exists (
      select 1 from ownagent.knowledge_document_members kdm
      where kdm.document_id = kd.id and kdm.user_id = p_user_id
    ))
    and kc.embedding is not null
  order by kc.embedding <=> p_query_embedding::vector(1024)
  limit greatest(1, least(p_limit, 100));
$$;

grant usage on schema ownagent to service_role;
grant select, insert, update, delete on all tables in schema ownagent to service_role;
grant execute on function ownagent.create_agent_run(uuid, uuid, jsonb, text, integer) to service_role;
grant execute on function ownagent.search_knowledge_chunks(uuid, uuid, text, integer) to service_role;
