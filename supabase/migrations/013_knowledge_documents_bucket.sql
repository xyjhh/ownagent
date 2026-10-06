-- Keep the private bucket required by the S3 multipart upload route present
-- when a fresh Supabase instance applies the migrations.
insert into storage.buckets (id, name, public)
values ('knowledge-documents', 'knowledge-documents', false)
on conflict (id) do update set public = excluded.public;
