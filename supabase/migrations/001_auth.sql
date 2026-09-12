create extension if not exists pgcrypto;

-- ownagent uses a dedicated schema in the shared Supabase/PostgreSQL instance.
-- Keep this schema separate from public tables owned by other projects.
create schema if not exists ownagent;

create table if not exists ownagent.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ownagent.auth_refresh_tokens (
  id uuid primary key,
  family_id uuid not null,
  user_id uuid not null references ownagent.app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by uuid references ownagent.auth_refresh_tokens(id),
  created_at timestamptz not null default now()
);

create index if not exists auth_refresh_tokens_user_idx
  on ownagent.auth_refresh_tokens(user_id, created_at desc);
create index if not exists auth_refresh_tokens_family_idx
  on ownagent.auth_refresh_tokens(family_id);

alter table ownagent.app_users enable row level security;
alter table ownagent.auth_refresh_tokens enable row level security;

grant usage on schema ownagent to service_role;
revoke all on schema ownagent from anon, authenticated;
revoke all on table ownagent.app_users from anon, authenticated;
revoke all on table ownagent.auth_refresh_tokens from anon, authenticated;
grant select, insert, update, delete on table ownagent.app_users to service_role;
grant select, insert, update, delete on table ownagent.auth_refresh_tokens to service_role;
