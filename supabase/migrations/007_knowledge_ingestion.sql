alter table ownagent.knowledge_documents
  add column if not exists status text not null default 'ready',
  add column if not exists source_type text not null default 'text',
  add column if not exists storage_bucket text,
  add column if not exists storage_key text,
  add column if not exists original_filename text,
  add column if not exists mime_type text,
  add column if not exists file_size bigint,
  add column if not exists content_hash text,
  add column if not exists parser_version text,
  add column if not exists chunking_version text,
  add column if not exists embedding_model text,
  add column if not exists error_code text,
  add column if not exists error_message text,
  add column if not exists deleted_at timestamptz,
  add column if not exists ingest_attempt integer not null default 0;

alter table ownagent.knowledge_documents
  drop constraint if exists knowledge_documents_status_check;
alter table ownagent.knowledge_documents
  add constraint knowledge_documents_status_check check (status in ('queued', 'processing', 'ready', 'failed', 'deleted'));

create unique index if not exists knowledge_documents_workspace_hash_idx
  on ownagent.knowledge_documents(workspace_id, content_hash)
  where content_hash is not null and status <> 'deleted';

create table if not exists ownagent.knowledge_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references ownagent.knowledge_documents(id) on delete cascade,
  version integer not null,
  content text not null default '',
  parser_version text not null,
  chunking_version text not null,
  embedding_model text not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique(document_id, version)
);
create unique index if not exists knowledge_document_active_version_idx
  on ownagent.knowledge_document_versions(document_id) where active;

alter table ownagent.knowledge_chunks
  add column if not exists version_id uuid references ownagent.knowledge_document_versions(id) on delete cascade,
  add column if not exists heading_path jsonb not null default '[]',
  add column if not exists page_number integer,
  add column if not exists char_start integer,
  add column if not exists char_end integer,
  add column if not exists token_count integer;

alter table ownagent.task_outbox alter column run_id drop not null;
alter table ownagent.task_outbox add column if not exists document_id uuid references ownagent.knowledge_documents(id) on delete cascade;
create index if not exists task_outbox_document_idx on ownagent.task_outbox(document_id) where document_id is not null;

create or replace function ownagent.populate_task_workspace() returns trigger
language plpgsql security definer set search_path = ownagent, public as $$
begin
  if new.workspace_id is null and new.run_id is not null then
    select workspace_id into new.workspace_id from ownagent.agent_runs where id = new.run_id;
  end if;
  if new.workspace_id is null and new.document_id is not null then
    select workspace_id into new.workspace_id from ownagent.knowledge_documents where id = new.document_id;
  end if;
  return new;
end;
$$;

-- PostgreSQL does not allow CREATE OR REPLACE to change RETURNS TABLE
-- (OUT parameter) types. Drop the previous 6-column result shape first.
drop function if exists ownagent.search_knowledge_chunks(uuid, uuid, text, integer);

create function ownagent.search_knowledge_chunks(
  p_workspace_id uuid, p_user_id uuid, p_query_embedding text, p_limit integer default 20
) returns table(chunk_id uuid, document_id uuid, version_id uuid, title text, content text, metadata jsonb, page_number integer, heading_path jsonb, score real)
language sql security definer set search_path = ownagent, public as $$
  select kc.id, kd.id, kc.version_id, kd.title, kc.content,
    kc.metadata, kc.page_number, kc.heading_path,
    (1 - (kc.embedding <=> p_query_embedding::vector(1024)))::real
  from ownagent.knowledge_chunks kc
  join ownagent.knowledge_documents kd on kd.id = kc.document_id
  where kc.workspace_id = p_workspace_id and kd.status = 'ready'
    and (kd.visibility = 'workspace' or kd.owner_id = p_user_id or exists (
      select 1 from ownagent.knowledge_document_members kdm where kdm.document_id = kd.id and kdm.user_id = p_user_id
    )) and kc.embedding is not null
  order by kc.embedding <=> p_query_embedding::vector(1024)
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function ownagent.search_knowledge_chunks(uuid, uuid, text, integer) to service_role;
