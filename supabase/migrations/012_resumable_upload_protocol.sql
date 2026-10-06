-- The current web client uses signed S3 multipart parts. Keep compatibility
-- with the original Tus design while allowing the implemented protocol.
alter table ownagent.document_uploads
  drop constraint if exists document_uploads_upload_protocol_check;

alter table ownagent.document_uploads
  add constraint document_uploads_upload_protocol_check
  check (upload_protocol in ('tus', 's3-multipart'));
