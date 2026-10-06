-- Conversation titles are generated asynchronously after completed agent turns.
alter table ownagent.memory_tasks
  drop constraint if exists memory_tasks_task_type_check;

alter table ownagent.memory_tasks
  add constraint memory_tasks_task_type_check
  check (task_type in (
    'persist_candidate',
    'review_candidate',
    'summarize_conversation',
    'update_conversation_title',
    'consolidate_memories',
    'embed_memory',
    'expire_memories'
  ));

create or replace function ownagent.update_conversation_title_if_latest(
  p_conversation_id uuid,
  p_title text,
  p_expected_last_message_id uuid
) returns boolean
language sql
security invoker
set search_path = ownagent, pg_temp
as $$
  with updated as (
    update ownagent.conversations c
    set title = p_title,
        updated_at = now()
    where c.id = p_conversation_id
      and exists (
        select 1
        from ownagent.conversation_messages m
        where m.conversation_id = p_conversation_id
          and m.id = p_expected_last_message_id
          and not exists (
            select 1
            from ownagent.conversation_messages newer
            where newer.conversation_id = p_conversation_id
              and (newer.created_at, newer.id) > (m.created_at, m.id)
          )
      )
    returning 1
  )
  select exists(select 1 from updated);
$$;

grant execute on function ownagent.update_conversation_title_if_latest(uuid, text, uuid) to service_role;
