create table if not exists ownagent.memory_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  user_id uuid references ownagent.app_users(id) on delete set null,
  conversation_id uuid references ownagent.conversations(id) on delete set null,
  run_id uuid references ownagent.agent_runs(id) on delete set null,
  memory_item_id uuid references ownagent.memory_items(id) on delete set null,
  task_type text not null check (task_type in ('persist_candidate','review_candidate','summarize_conversation','consolidate_memories','embed_memory','expire_memories')),
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','processing','completed','retryable','dead_lettered')),
  attempt integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists memory_tasks_ready_idx on ownagent.memory_tasks(status, available_at);
create index if not exists memory_tasks_conversation_idx on ownagent.memory_tasks(workspace_id, conversation_id);
create index if not exists memory_tasks_item_idx on ownagent.memory_tasks(memory_item_id, task_type);
alter table ownagent.task_outbox add column if not exists memory_task_id uuid references ownagent.memory_tasks(id) on delete cascade;
create index if not exists task_outbox_memory_idx on ownagent.task_outbox(memory_task_id) where memory_task_id is not null;
alter table ownagent.memory_items add column if not exists embedding vector(1024);
alter table ownagent.memory_items add column if not exists embedding_model text;
