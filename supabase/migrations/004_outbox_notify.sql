-- Event-driven transactional outbox. This migration is intentionally not applied automatically.
create schema if not exists ownagent;

alter table ownagent.task_outbox add column if not exists processing_at timestamptz;
alter table ownagent.task_outbox add column if not exists locked_by text;
alter table ownagent.task_outbox add column if not exists last_error text;

create index if not exists task_outbox_claim_idx
  on ownagent.task_outbox (available_at, created_at)
  where published_at is null;

create or replace function ownagent.claim_task_outbox(
  p_limit integer default 50,
  p_worker_id text default 'outbox-dispatcher'
) returns table(
  id uuid,
  run_id uuid,
  workspace_id uuid,
  stream text,
  payload jsonb,
  attempts integer
)
language plpgsql security definer set search_path = ownagent, public
as $$
begin
  return query
  with candidates as (
    select o.id
    from ownagent.task_outbox o
    where o.published_at is null
      and o.available_at <= now()
      and (o.processing_at is null or o.processing_at < now() - interval '5 minutes')
    order by o.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 500))
  )
  update ownagent.task_outbox o
     set processing_at = now(), locked_by = p_worker_id, attempts = o.attempts + 1
    from candidates c
   where o.id = c.id
  returning o.id, o.run_id, o.workspace_id, o.stream, o.payload, o.attempts;
end;
$$;

create or replace function ownagent.release_task_outbox(
  p_id uuid,
  p_worker_id text,
  p_error text
) returns boolean
language plpgsql security definer set search_path = ownagent, public
as $$
declare changed boolean;
begin
  update ownagent.task_outbox
     set processing_at = null,
         locked_by = null,
         last_error = left(coalesce(p_error, 'unknown outbox error'), 2000)
   where id = p_id and locked_by = p_worker_id and published_at is null;
  changed := found;
  return changed;
end;
$$;

create or replace function ownagent.notify_task_outbox()
returns trigger
language plpgsql security definer set search_path = ownagent, public
as $$
begin
  perform pg_notify('ownagent_outbox', new.id::text);
  return new;
end;
$$;

drop trigger if exists task_outbox_after_insert_notify on ownagent.task_outbox;
create trigger task_outbox_after_insert_notify
after insert on ownagent.task_outbox
for each row execute function ownagent.notify_task_outbox();

-- Keep task_outbox.workspace_id populated for rows inserted by older RPCs.
create or replace function ownagent.populate_task_workspace()
returns trigger
language plpgsql security definer set search_path = ownagent, public
as $$
begin
  if new.workspace_id is null then
    select workspace_id into new.workspace_id from ownagent.agent_runs where id = new.run_id;
  end if;
  return new;
end;
$$;
drop trigger if exists task_outbox_workspace_trigger on ownagent.task_outbox;
create trigger task_outbox_workspace_trigger
before insert on ownagent.task_outbox
for each row execute function ownagent.populate_task_workspace();

revoke all on function ownagent.claim_task_outbox(integer, text) from public, anon, authenticated;
revoke all on function ownagent.release_task_outbox(uuid, text, text) from public, anon, authenticated;
grant execute on function ownagent.claim_task_outbox(integer, text) to service_role;
grant execute on function ownagent.release_task_outbox(uuid, text, text) to service_role;
