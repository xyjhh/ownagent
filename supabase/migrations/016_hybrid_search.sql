create extension if not exists pg_trgm;

alter table ownagent.knowledge_chunks
  add column if not exists search_vector tsvector
    generated always as (to_tsvector('simple', coalesce(content, ''))) stored;

create index if not exists knowledge_chunks_search_vector_idx
  on ownagent.knowledge_chunks using gin(search_vector);
create index if not exists knowledge_chunks_content_trgm_idx
  on ownagent.knowledge_chunks using gist(content gist_trgm_ops);
create index if not exists knowledge_documents_title_trgm_idx
  on ownagent.knowledge_documents using gist(title gist_trgm_ops);

create or replace function ownagent.search_knowledge_chunks_lexical(
  p_workspace_id uuid,
  p_user_id uuid,
  p_query text,
  p_limit integer default 20
) returns table(
  chunk_id uuid,
  document_id uuid,
  version_id uuid,
  title text,
  content text,
  metadata jsonb,
  page_number integer,
  heading_path jsonb,
  score real
)
language sql
security definer
set search_path = ownagent, public
set pg_trgm.word_similarity_threshold = '0.1'
as $$
  with query as (
    select websearch_to_tsquery('simple', coalesce(nullif(trim(p_query), ''), ' ')) as tsquery
  )
  select kc.id,
    kd.id,
    kc.version_id,
    kd.title,
    kc.content,
    kc.metadata,
    kc.page_number,
    kc.heading_path,
    greatest(
      ts_rank_cd(kc.search_vector, query.tsquery),
      word_similarity(coalesce(p_query, ''), kc.content),
      word_similarity(coalesce(p_query, ''), kd.title)
    )::real
  from ownagent.knowledge_chunks kc
  join ownagent.knowledge_documents kd on kd.id = kc.document_id
  cross join query
  where kc.workspace_id = p_workspace_id
    and kd.status = 'ready'
    and (kd.visibility = 'workspace' or kd.owner_id = p_user_id or exists (
      select 1
      from ownagent.knowledge_document_members kdm
      where kdm.document_id = kd.id and kdm.user_id = p_user_id
    ))
    and (
      kc.search_vector @@ query.tsquery
      or coalesce(p_query, '') <% kc.content
      or coalesce(p_query, '') <% kd.title
    )
  order by greatest(
    ts_rank_cd(kc.search_vector, query.tsquery),
    word_similarity(coalesce(p_query, ''), kc.content),
    word_similarity(coalesce(p_query, ''), kd.title)
  ) desc, kc.id
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function ownagent.search_knowledge_chunks_lexical(uuid, uuid, text, integer) to service_role;
