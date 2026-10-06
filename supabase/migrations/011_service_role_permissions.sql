-- Tables added after the enterprise foundation migration are not covered by
-- the earlier blanket grant. The API and workers use the service-role client
-- against the ownagent schema, so keep these grants explicit and idempotent.
grant select, insert, update, delete on ownagent.conversation_summaries to service_role;
grant select, insert, update, delete on ownagent.memory_items to service_role;
grant select, insert, update, delete on ownagent.memory_tasks to service_role;
grant select, insert, update, delete on ownagent.document_uploads to service_role;
