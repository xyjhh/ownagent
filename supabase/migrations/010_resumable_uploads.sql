create table if not exists ownagent.document_uploads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null,
  document_id uuid references ownagent.knowledge_documents(id) on delete set null,
  storage_bucket text not null,
  storage_key text not null,
  original_filename text not null,
  mime_type text not null,
  file_size bigint not null check (file_size > 0),
  content_hash text,
  fingerprint text not null,
  upload_protocol text not null default 'tus' check (upload_protocol = 'tus'),
  provider_upload_id text not null,
  status text not null default 'initiated' check (status in ('initiated','uploading','completing','completed','aborted','expired','failed')),
  uploaded_bytes bigint not null default 0 check (uploaded_bytes >= 0),
  total_parts integer,
  expires_at timestamptz not null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(provider_upload_id)
);
create unique index if not exists document_uploads_active_fingerprint_idx
  on ownagent.document_uploads(workspace_id, fingerprint)
  where status in ('initiated','uploading','completing');
create index if not exists document_uploads_workspace_status_idx on ownagent.document_uploads(workspace_id, status);
create index if not exists document_uploads_fingerprint_idx on ownagent.document_uploads(fingerprint);
create index if not exists document_uploads_expires_idx on ownagent.document_uploads(expires_at) where status in ('initiated','uploading','completing');
alter table ownagent.task_outbox add column if not exists document_upload_id uuid references ownagent.document_uploads(id) on delete set null;
