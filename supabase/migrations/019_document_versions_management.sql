alter table ownagent.knowledge_documents
  add column if not exists ingest_status text not null default 'idle';

alter table ownagent.knowledge_documents
  drop constraint if exists knowledge_documents_ingest_status_check;
alter table ownagent.knowledge_documents
  add constraint knowledge_documents_ingest_status_check
  check (ingest_status in ('idle', 'queued', 'processing', 'failed'));

alter table ownagent.knowledge_document_versions
  add column if not exists status text not null default 'ready',
  add column if not exists error_code text,
  add column if not exists error_message text,
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists completed_at timestamptz;

alter table ownagent.knowledge_document_versions
  drop constraint if exists knowledge_document_versions_status_check;
alter table ownagent.knowledge_document_versions
  add constraint knowledge_document_versions_status_check
  check (status in ('building', 'ready', 'failed'));

-- Older installations created chunks before versioning was introduced. Give
-- those documents an initial immutable version before enforcing version-aware
-- chunk uniqueness.
do $$
declare
  d record;
  v uuid;
begin
  for d in
    select kd.id, kd.content, kd.parser_version, kd.chunking_version, kd.embedding_model,
           kd.created_at, kd.status
    from ownagent.knowledge_documents kd
    where not exists (
      select 1 from ownagent.knowledge_document_versions kdv
      where kdv.document_id = kd.id
    )
  loop
    insert into ownagent.knowledge_document_versions(
      document_id, version, content, parser_version, chunking_version,
      embedding_model, active, status, created_at, completed_at
    ) values (
      d.id, 1, coalesce(d.content, ''), coalesce(d.parser_version, 'legacy'),
      coalesce(d.chunking_version, 'legacy'), coalesce(d.embedding_model, 'legacy'),
      case when d.status = 'ready' then true else false end, 'ready',
      coalesce(d.created_at, now()), coalesce(d.created_at, now())
    ) returning id into v;
    update ownagent.knowledge_chunks
      set version_id = v
      where document_id = d.id and version_id is null;
  end loop;
end $$;

alter table ownagent.knowledge_chunks
  drop constraint if exists knowledge_chunks_document_id_chunk_index_key;
create unique index if not exists knowledge_chunks_document_version_index
  on ownagent.knowledge_chunks(document_id, version_id, chunk_index)
  where version_id is not null;
create unique index if not exists knowledge_chunks_legacy_index
  on ownagent.knowledge_chunks(document_id, chunk_index)
  where version_id is null;
create index if not exists knowledge_document_versions_document_idx
  on ownagent.knowledge_document_versions(document_id, version desc);

-- Only the current successful version participates in retrieval. The version_id
-- null fallback keeps old rows searchable until the migration has been applied
-- to every legacy document.
drop function if exists ownagent.search_knowledge_chunks(uuid, uuid, text, integer);
create function ownagent.search_knowledge_chunks(
  p_workspace_id uuid, p_user_id uuid, p_query_embedding text, p_limit integer default 20
) returns table(chunk_id uuid, document_id uuid, version_id uuid, title text, content text, metadata jsonb, page_number integer, heading_path jsonb, score real)
language sql security definer set search_path = ownagent, public as $$
  select kc.id, kd.id, kc.version_id, kd.title, kc.content, kc.metadata,
    kc.page_number, kc.heading_path,
    (1 - (kc.embedding <=> p_query_embedding::vector(1024)))::real
  from ownagent.knowledge_chunks kc
  join ownagent.knowledge_documents kd on kd.id = kc.document_id
  left join ownagent.knowledge_document_versions kv on kv.id = kc.version_id
  where kc.workspace_id = p_workspace_id and kd.status = 'ready'
    and (kc.version_id is null or (kv.active and kv.status = 'ready'))
    and (kd.visibility = 'workspace' or kd.owner_id = p_user_id or exists (
      select 1 from ownagent.knowledge_document_members kdm
      where kdm.document_id = kd.id and kdm.user_id = p_user_id
    )) and kc.embedding is not null
  order by kc.embedding <=> p_query_embedding::vector(1024)
  limit greatest(1, least(p_limit, 100));
$$;
grant execute on function ownagent.search_knowledge_chunks(uuid, uuid, text, integer) to service_role;

drop function if exists ownagent.search_knowledge_chunks_lexical(uuid, uuid, text, integer);
create function ownagent.search_knowledge_chunks_lexical(
  p_workspace_id uuid, p_user_id uuid, p_query text, p_limit integer default 20
) returns table(chunk_id uuid, document_id uuid, version_id uuid, title text, content text, metadata jsonb, page_number integer, heading_path jsonb, score real)
language sql security definer set search_path = ownagent, public
set pg_trgm.word_similarity_threshold = '0.1' as $$
  with query as (
    select websearch_to_tsquery('simple', coalesce(nullif(trim(p_query), ''), ' ')) as tsquery
  )
  select kc.id, kd.id, kc.version_id, kd.title, kc.content, kc.metadata,
    kc.page_number, kc.heading_path,
    greatest(ts_rank_cd(kc.search_vector, query.tsquery),
      word_similarity(coalesce(p_query, ''), kc.content),
      word_similarity(coalesce(p_query, ''), kd.title))::real
  from ownagent.knowledge_chunks kc
  join ownagent.knowledge_documents kd on kd.id = kc.document_id
  left join ownagent.knowledge_document_versions kv on kv.id = kc.version_id
  cross join query
  where kc.workspace_id = p_workspace_id and kd.status = 'ready'
    and (kc.version_id is null or (kv.active and kv.status = 'ready'))
    and (kd.visibility = 'workspace' or kd.owner_id = p_user_id or exists (
      select 1 from ownagent.knowledge_document_members kdm
      where kdm.document_id = kd.id and kdm.user_id = p_user_id
    )) and (kc.search_vector @@ query.tsquery or coalesce(p_query, '') <% kc.content or coalesce(p_query, '') <% kd.title)
  order by greatest(ts_rank_cd(kc.search_vector, query.tsquery), word_similarity(coalesce(p_query, ''), kc.content), word_similarity(coalesce(p_query, ''), kd.title)) desc, kc.id
  limit greatest(1, least(p_limit, 100));
$$;
grant execute on function ownagent.search_knowledge_chunks_lexical(uuid, uuid, text, integer) to service_role;

create or replace function ownagent.activate_document_version(
  p_document_id uuid,
  p_version_id uuid
) returns boolean
language plpgsql security definer set search_path = ownagent, public as $$
declare
  v record;
begin
  select * into v from ownagent.knowledge_document_versions
    where id = p_version_id and document_id = p_document_id and status = 'ready';
  if not found then return false; end if;
  update ownagent.knowledge_document_versions
    set active = false where document_id = p_document_id;
  update ownagent.knowledge_document_versions
    set active = true, completed_at = coalesce(completed_at, now()), error_code = null, error_message = null
    where id = p_version_id;
  update ownagent.knowledge_documents
    set status = 'ready', ingest_status = 'idle', content = v.content,
        parser_version = v.parser_version, chunking_version = v.chunking_version,
        embedding_model = v.embedding_model, error_code = null, error_message = null,
        updated_at = now()
    where id = p_document_id;
  return true;
end $$;
grant execute on function ownagent.activate_document_version(uuid, uuid) to service_role;
