-- Document ingestion writes versions after parsing. This table was added in
-- the ingestion migration after the original service-role grants.
grant select, insert, update, delete on ownagent.knowledge_document_versions to service_role;
