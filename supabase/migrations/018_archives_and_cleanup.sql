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
    and kd.status = 'ready'
    and (kd.visibility = 'workspace' or kd.owner_id = p_user_id or exists (
      select 1 from ownagent.knowledge_document_members kdm
      where kdm.document_id = kd.id and kdm.user_id = p_user_id
    ))
    and kc.embedding is not null
  order by kc.embedding <=> p_query_embedding::vector(1024)
  limit greatest(1, least(p_limit, 100));
$$;
grant execute on function ownagent.search_knowledge_chunks(uuid, uuid, text, integer) to service_role;
