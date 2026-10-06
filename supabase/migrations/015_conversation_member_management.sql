create index if not exists conversations_workspace_updated_idx
  on ownagent.conversations(workspace_id, updated_at desc);

create index if not exists conversation_messages_conversation_created_idx
  on ownagent.conversation_messages(conversation_id, created_at);

comment on table ownagent.workspace_members is
  'Workspace memberships. status=suspended preserves membership history after removal.';
