create table if not exists ownagent.conversation_summaries (
  conversation_id uuid primary key references ownagent.conversations(id) on delete cascade,
  summary text not null,
  covered_until_message_id uuid references ownagent.conversation_messages(id),
  model text,
  prompt_version text,
  updated_at timestamptz not null default now()
);

create table if not exists ownagent.memory_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  owner_user_id uuid references ownagent.app_users(id) on delete cascade,
  scope text not null check (scope in ('user', 'workspace')),
  type text not null check (type in ('preference', 'fact', 'instruction')),
  key text not null,
  value jsonb not null default '{}',
  summary text not null,
  confidence real not null default 1,
  status text not null default 'active' check (status in ('active', 'pending_confirmation', 'archived', 'deleted')),
  sensitivity text not null default 'normal' check (sensitivity in ('normal', 'sensitive')),
  source_conversation_id uuid references ownagent.conversations(id) on delete set null,
  source_message_id uuid references ownagent.conversation_messages(id) on delete set null,
  source_run_id uuid references ownagent.agent_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  check ((scope = 'user' and owner_user_id is not null) or (scope = 'workspace' and owner_user_id is null))
);
create unique index if not exists memory_active_key_idx on ownagent.memory_items(workspace_id, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), scope, key) where status = 'active';
create index if not exists memory_lookup_idx on ownagent.memory_items(workspace_id, owner_user_id, scope, status);
