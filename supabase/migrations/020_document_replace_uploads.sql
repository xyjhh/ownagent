alter table ownagent.document_uploads
  add column if not exists target_document_id uuid references ownagent.knowledge_documents(id) on delete cascade,
  add column if not exists upload_mode text not null default 'create';

alter table ownagent.document_uploads
  drop constraint if exists document_uploads_upload_mode_check;
alter table ownagent.document_uploads
  add constraint document_uploads_upload_mode_check check (upload_mode in ('create', 'replace'));
create index if not exists document_uploads_target_status_idx
  on ownagent.document_uploads(target_document_id, status);

alter table ownagent.knowledge_document_versions
  add column if not exists content_hash text,
  add column if not exists source_filename text,
  add column if not exists source_file_size bigint,
  add column if not exists source_mime_type text,
  add column if not exists source_storage_bucket text,
  add column if not exists source_storage_key text,
  add column if not exists failed_at timestamptz,
  add column if not exists retry_of_version_id uuid references ownagent.knowledge_document_versions(id);
create index if not exists knowledge_document_versions_hash_idx
  on ownagent.knowledge_document_versions(content_hash) where content_hash is not null;

update ownagent.knowledge_document_versions v
set content_hash = coalesce(v.content_hash, d.content_hash),
    source_filename = coalesce(v.source_filename, d.original_filename),
    source_file_size = coalesce(v.source_file_size, d.file_size),
    source_mime_type = coalesce(v.source_mime_type, d.mime_type),
    source_storage_bucket = coalesce(v.source_storage_bucket, d.storage_bucket),
    source_storage_key = coalesce(v.source_storage_key, d.storage_key)
from ownagent.knowledge_documents d
where d.id = v.document_id and v.active = true;

create or replace function ownagent.claim_document_upload_completion(
  p_workspace_id uuid,
  p_user_id uuid,
  p_upload_id uuid
) returns boolean
language plpgsql security definer set search_path = ownagent, public as $$
declare
  u ownagent.document_uploads%rowtype;
begin
  select * into u from ownagent.document_uploads
    where id = p_upload_id and workspace_id = p_workspace_id and user_id = p_user_id
    for update;
  if not found or not (
    u.status in ('initiated', 'uploading')
    or (u.status = 'completing' and u.updated_at < now() - interval '5 minutes')
  ) then return false; end if;
  update ownagent.document_uploads set status = 'completing', updated_at = now()
    where id = p_upload_id;
  return true;
end $$;
grant execute on function ownagent.claim_document_upload_completion(uuid, uuid, uuid) to service_role;

create or replace function ownagent.complete_document_create_upload(
  p_workspace_id uuid,
  p_user_id uuid,
  p_upload_id uuid,
  p_stream text
) returns jsonb
language plpgsql security definer set search_path = ownagent, public as $$
declare
  u ownagent.document_uploads%rowtype;
  d ownagent.knowledge_documents%rowtype;
  v_title text;
begin
  select * into u from ownagent.document_uploads
    where id = p_upload_id and workspace_id = p_workspace_id and user_id = p_user_id
      and upload_mode = 'create' and target_document_id is null
    for update;
  if not found then return null; end if;
  if u.status = 'completed' and u.document_id is not null then
    select * into d from ownagent.knowledge_documents where id = u.document_id;
    if found then return to_jsonb(d); end if;
  end if;
  if u.status <> 'completing' then return null; end if;

  v_title := left(regexp_replace(u.original_filename, '\.[^.]+$', ''), 300);
  if coalesce(v_title, '') = '' then v_title := 'Uploaded document'; end if;
  insert into ownagent.knowledge_documents(
    workspace_id, owner_id, title, content, visibility, metadata, status, ingest_status,
    source_type, storage_bucket, storage_key, original_filename, mime_type, file_size, content_hash
  ) values (
    p_workspace_id, p_user_id, v_title, '', 'workspace', '{}'::jsonb, 'queued', 'queued',
    'upload', u.storage_bucket, u.storage_key, u.original_filename, u.mime_type, u.file_size, u.content_hash
  ) returning * into d;

  update ownagent.document_uploads set status = 'completed', document_id = d.id,
    completed_at = now(), uploaded_bytes = file_size, updated_at = now()
    where id = p_upload_id;
  insert into ownagent.task_outbox(document_id, document_upload_id, workspace_id, stream, payload)
    values (d.id, p_upload_id, p_workspace_id, p_stream,
      jsonb_build_object('documentId', d.id, 'uploadId', p_upload_id, 'mode', 'create', 'attempt', 1));
  return to_jsonb(d);
end $$;
grant execute on function ownagent.complete_document_create_upload(uuid, uuid, uuid, text) to service_role;

create or replace function ownagent.complete_document_replace_upload(
  p_workspace_id uuid,
  p_document_id uuid,
  p_upload_id uuid,
  p_stream text
) returns boolean
language plpgsql security definer set search_path = ownagent, public as $$
declare
  d ownagent.knowledge_documents%rowtype;
  u ownagent.document_uploads%rowtype;
begin
  select * into d from ownagent.knowledge_documents
    where id = p_document_id and workspace_id = p_workspace_id and status <> 'deleted'
    for update;
  if not found then return false; end if;

  select * into u from ownagent.document_uploads
    where id = p_upload_id and workspace_id = p_workspace_id and user_id is not null
      and upload_mode = 'replace' and target_document_id = p_document_id
    for update;
  if not found then return false; end if;
  if u.status = 'completed' then return true; end if;
  if u.status not in ('initiated', 'uploading', 'completing') then return false; end if;
  if d.ingest_status in ('queued', 'processing') then return false; end if;

  update ownagent.document_uploads set status = 'completed', document_id = p_document_id,
    completed_at = now(), uploaded_bytes = file_size, updated_at = now()
    where id = p_upload_id;
  update ownagent.knowledge_documents set ingest_status = 'queued',
    error_code = null, error_message = null, updated_at = now()
    where id = p_document_id;
  insert into ownagent.task_outbox(document_id, document_upload_id, workspace_id, stream, payload)
    values (p_document_id, p_upload_id, p_workspace_id, p_stream,
      jsonb_build_object('documentId', p_document_id, 'uploadId', p_upload_id, 'mode', 'replace', 'attempt', 1));
  return true;
end $$;
grant execute on function ownagent.complete_document_replace_upload(uuid, uuid, uuid, text) to service_role;

create or replace function ownagent.complete_unchanged_document_replace_upload(
  p_workspace_id uuid,
  p_document_id uuid,
  p_upload_id uuid,
  p_content_hash text
) returns boolean
language plpgsql security definer set search_path = ownagent, public as $$
declare
  d ownagent.knowledge_documents%rowtype;
  u ownagent.document_uploads%rowtype;
  active_hash text;
begin
  select * into d from ownagent.knowledge_documents
    where id = p_document_id and workspace_id = p_workspace_id and status <> 'deleted'
    for update;
  if not found or d.ingest_status in ('queued', 'processing') then return false; end if;
  select * into u from ownagent.document_uploads
    where id = p_upload_id and workspace_id = p_workspace_id
      and upload_mode = 'replace' and target_document_id = p_document_id and status = 'completing'
    for update;
  if not found then return false; end if;
  select content_hash into active_hash from ownagent.knowledge_document_versions
    where document_id = p_document_id and active = true and status = 'ready';
  if coalesce(active_hash, d.content_hash) is distinct from p_content_hash then return false; end if;
  update ownagent.document_uploads set status = 'completed', document_id = p_document_id,
    completed_at = now(), uploaded_bytes = file_size, content_hash = p_content_hash,
    last_error = 'UNCHANGED', updated_at = now()
    where id = p_upload_id;
  update ownagent.knowledge_documents set ingest_status = 'idle', error_code = null,
    error_message = null, updated_at = now() where id = p_document_id;
  return true;
end $$;
grant execute on function ownagent.complete_unchanged_document_replace_upload(uuid, uuid, uuid, text) to service_role;

create or replace function ownagent.claim_document_ingest(p_document_id uuid)
returns setof ownagent.knowledge_documents
language plpgsql security definer set search_path = ownagent, public as $$
begin
  return query
    update ownagent.knowledge_documents
      set status = case when status = 'ready' then 'ready' else 'processing' end,
          ingest_status = 'processing', ingest_attempt = ingest_attempt + 1,
          updated_at = now()
      where id = p_document_id and status in ('queued', 'processing', 'ready')
        and ingest_status = 'queued'
      returning *;
end $$;
grant execute on function ownagent.claim_document_ingest(uuid) to service_role;

create or replace function ownagent.enqueue_document_ingest(
  p_document_id uuid,
  p_stream text,
  p_payload jsonb,
  p_delay_ms integer default 0,
  p_allow_processing boolean default false
) returns boolean
language plpgsql security definer set search_path = ownagent, public as $$
declare
  d ownagent.knowledge_documents%rowtype;
begin
  select * into d from ownagent.knowledge_documents
    where id = p_document_id and status <> 'deleted' for update;
  if not found then return false; end if;
  if d.ingest_status in ('queued', 'processing') and not p_allow_processing then return false; end if;
  update ownagent.knowledge_documents set
    status = case when status = 'ready' then 'ready' else 'queued' end,
    ingest_status = 'queued', error_code = null, error_message = null, updated_at = now()
    where id = p_document_id;
  insert into ownagent.task_outbox(document_id, workspace_id, stream, payload, available_at)
    values (p_document_id, d.workspace_id, p_stream, p_payload,
      now() + make_interval(secs => greatest(0, p_delay_ms)::double precision / 1000));
  return true;
end $$;
grant execute on function ownagent.enqueue_document_ingest(uuid, text, jsonb, integer, boolean) to service_role;

create or replace function ownagent.activate_document_version(
  p_document_id uuid,
  p_version_id uuid
) returns boolean
language plpgsql security definer set search_path = ownagent, public as $$
declare
  v ownagent.knowledge_document_versions%rowtype;
begin
  select * into v from ownagent.knowledge_document_versions
    where id = p_version_id and document_id = p_document_id and status = 'ready';
  if not found then return false; end if;
  update ownagent.knowledge_document_versions set active = false where document_id = p_document_id;
  update ownagent.knowledge_document_versions set active = true,
    completed_at = coalesce(completed_at, now()), error_code = null, error_message = null
    where id = p_version_id;
  update ownagent.knowledge_documents set status = 'ready', ingest_status = 'idle',
    content = v.content, parser_version = v.parser_version,
    chunking_version = v.chunking_version, embedding_model = v.embedding_model,
    content_hash = coalesce(v.content_hash, content_hash),
    original_filename = coalesce(v.source_filename, original_filename),
    file_size = coalesce(v.source_file_size, file_size),
    mime_type = coalesce(v.source_mime_type, mime_type),
    storage_bucket = coalesce(v.source_storage_bucket, storage_bucket),
    storage_key = coalesce(v.source_storage_key, storage_key),
    error_code = null, error_message = null, updated_at = now()
    where id = p_document_id;
  return true;
end $$;
grant execute on function ownagent.activate_document_version(uuid, uuid) to service_role;
