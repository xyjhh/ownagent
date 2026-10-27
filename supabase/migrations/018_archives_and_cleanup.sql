create table if not exists ownagent.conversation_archives (
  conversation_id uuid not null references ownagent.conversations(id) on delete cascade,
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  user_id uuid not null references ownagent.app_users(id) on delete cascade,
  archived_at timestamptz not null default now(),
  primary key (user_id, conversation_id)
);
create index if not exists conversation_archives_workspace_user_idx
  on ownagent.conversation_archives(workspace_id, user_id, archived_at desc);

-- This table is queried through the Supabase service-role client by the API.
grant select, insert, update, delete on ownagent.conversation_archives to service_role;
