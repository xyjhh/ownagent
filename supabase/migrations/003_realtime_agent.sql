-- Realtime Agent controls. This file is intentionally not applied automatically.
create schema if not exists ownagent;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'agent_runs_status_check' and conrelid = 'ownagent.agent_runs'::regclass) then
    alter table ownagent.agent_runs drop constraint agent_runs_status_check;
  end if;
end $$;
alter table ownagent.agent_runs add constraint agent_runs_status_check
  check (status in ('queued', 'running', 'waiting_approval', 'waiting_user', 'completed', 'failed', 'interrupted', 'canceled'));

alter table ownagent.agent_run_events add column if not exists workspace_id uuid references ownagent.workspaces(id) on delete cascade;
update ownagent.agent_run_events e set workspace_id = r.workspace_id from ownagent.agent_runs r where r.id = e.run_id and e.workspace_id is null;
create index if not exists agent_run_events_workspace_idx on ownagent.agent_run_events(workspace_id, run_id, sequence_no);
alter table ownagent.task_outbox add column if not exists workspace_id uuid references ownagent.workspaces(id) on delete cascade;
update ownagent.task_outbox o set workspace_id = r.workspace_id from ownagent.agent_runs r where r.id = o.run_id and o.workspace_id is null;
create or replace function ownagent.populate_task_workspace() returns trigger language plpgsql security definer set search_path = ownagent, public as $$
begin
  if new.workspace_id is null then select workspace_id into new.workspace_id from ownagent.agent_runs where id = new.run_id; end if;
  return new;
end;
$$;
drop trigger if exists task_outbox_workspace_trigger on ownagent.task_outbox;
create trigger task_outbox_workspace_trigger before insert on ownagent.task_outbox for each row execute function ownagent.populate_task_workspace();

create table if not exists ownagent.agent_run_controls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ownagent.agent_runs(id) on delete cascade,
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  control_id text not null,
  control_type text not null check (control_type in ('approve', 'reject', 'interrupt', 'follow_up')),
  payload jsonb not null default '{}',
  requested_by uuid not null references ownagent.app_users(id),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, control_id)
);
create index if not exists agent_run_controls_pending_idx on ownagent.agent_run_controls(run_id, created_at) where processed_at is null;

create table if not exists ownagent.agent_run_approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ownagent.agent_runs(id) on delete cascade,
  workspace_id uuid not null references ownagent.workspaces(id) on delete cascade,
  approval_id text not null,
  prompt text not null,
  options jsonb not null default '[]',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  expires_at timestamptz not null,
  resolved_by uuid references ownagent.app_users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, approval_id)
);
create index if not exists agent_run_approvals_pending_idx on ownagent.agent_run_approvals(workspace_id, expires_at) where status = 'pending';

create or replace function ownagent.assert_agent_run_workspace()
returns trigger language plpgsql security definer set search_path = ownagent, public as $$
begin
  if not exists (select 1 from ownagent.agent_runs where id = new.run_id and workspace_id = new.workspace_id) then
    raise exception 'agent run does not belong to workspace';
  end if;
  return new;
end;
$$;
drop trigger if exists agent_run_controls_workspace_trigger on ownagent.agent_run_controls;
create trigger agent_run_controls_workspace_trigger before insert or update of run_id, workspace_id on ownagent.agent_run_controls
  for each row execute function ownagent.assert_agent_run_workspace();
drop trigger if exists agent_run_approvals_workspace_trigger on ownagent.agent_run_approvals;
create trigger agent_run_approvals_workspace_trigger before insert or update of run_id, workspace_id on ownagent.agent_run_approvals
  for each row execute function ownagent.assert_agent_run_workspace();

create or replace function ownagent.append_agent_run_event(
  p_run_id uuid,
  p_event_type text,
  p_payload jsonb default '{}'
) returns ownagent.agent_run_events
language plpgsql security definer set search_path = ownagent, public as $$
declare result ownagent.agent_run_events;
begin
  perform 1 from ownagent.agent_runs where id = p_run_id for update;
  if not found then raise exception 'agent run not found'; end if;
  insert into ownagent.agent_run_events(run_id, workspace_id, sequence_no, event_type, payload)
  values (
    p_run_id,
    (select workspace_id from ownagent.agent_runs where id = p_run_id),
    coalesce((select max(sequence_no) + 1 from ownagent.agent_run_events where run_id = p_run_id), 1),
    p_event_type,
    coalesce(p_payload, '{}')
  ) returning * into result;
  return result;
end;
$$;

create or replace function ownagent.expire_agent_run_approvals()
returns integer language plpgsql security definer set search_path = ownagent, public as $$
declare count_expired integer;
begin
  with expired as (
    update ownagent.agent_run_approvals
      set status = 'expired', resolved_at = now()
      where status = 'pending' and expires_at <= now()
      returning run_id
  ), canceled as (
    update ownagent.agent_runs r set status = 'canceled', finished_at = now(), updated_at = now()
    where r.id in (select run_id from expired) and r.status = 'waiting_approval'
    returning r.id
  )
  insert into ownagent.agent_run_events(run_id, sequence_no, event_type, payload)
  select c.id, coalesce((select max(e.sequence_no) + 1 from ownagent.agent_run_events e where e.run_id = c.id), 1), 'approval_expired', jsonb_build_object('reason', 'approval_timeout')
  from canceled c;
  get diagnostics count_expired = row_count;
  return count_expired;
end;
$$;

alter table ownagent.agent_run_controls enable row level security;
alter table ownagent.agent_run_approvals enable row level security;
revoke all on table ownagent.agent_run_controls, ownagent.agent_run_approvals from anon, authenticated;
grant select, insert, update, delete on ownagent.agent_run_controls, ownagent.agent_run_approvals to service_role;
grant execute on function ownagent.append_agent_run_event(uuid, text, jsonb) to service_role;
grant execute on function ownagent.expire_agent_run_approvals() to service_role;
