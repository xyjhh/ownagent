-- Add delayed release support for event-driven Outbox retries.
-- This migration is intentionally not applied automatically.
create schema if not exists ownagent;

create or replace function ownagent.release_task_outbox(
  p_id uuid,
  p_worker_id text,
  p_error text,
  p_delay_ms integer default 0
) returns boolean
language plpgsql security definer set search_path = ownagent, public
as $$
declare changed boolean;
begin
  update ownagent.task_outbox
     set processing_at = null,
         locked_by = null,
         last_error = left(coalesce(p_error, 'unknown outbox error'), 2000),
         available_at = now() + make_interval(secs => greatest(0, least(coalesce(p_delay_ms, 0), 86400000)) / 1000.0)
   where id = p_id and locked_by = p_worker_id and published_at is null;
  changed := found;
  return changed;
end;
$$;

revoke all on function ownagent.release_task_outbox(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function ownagent.release_task_outbox(uuid, text, text, integer) to service_role;
