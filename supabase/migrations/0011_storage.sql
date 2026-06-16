-- ============================================================
-- 0011_storage.sql
-- Storage buckets + policies.
--   avatars   : public read  (profile pictures)
--   resources : public read  (shared files)
--   receipts  : private      (payment receipts, signed URLs only)
-- ============================================================

insert into storage.buckets (id, name, public)
values
  ('avatars',   'avatars',   true),
  ('resources', 'resources', true),
  ('receipts',  'receipts',  false)
on conflict (id) do nothing;

-- Public read for avatars & resources.
create policy "storage: public read avatars"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "storage: public read resources"
  on storage.objects for select
  using (bucket_id = 'resources');

-- Receipts are readable only by authenticated members.
create policy "storage: auth read receipts"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'receipts');

-- Authenticated members can upload / update / delete in any app bucket.
create policy "storage: auth insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id in ('avatars', 'resources', 'receipts'));

create policy "storage: auth update"
  on storage.objects for update
  to authenticated
  using (bucket_id in ('avatars', 'resources', 'receipts'))
  with check (bucket_id in ('avatars', 'resources', 'receipts'));

create policy "storage: auth delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id in ('avatars', 'resources', 'receipts'));
