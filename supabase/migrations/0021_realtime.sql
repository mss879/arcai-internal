-- ============================================================
-- 0021_realtime.sql
-- Turn on Postgres Realtime for every table the app subscribes to, so
-- the UI updates live without a page refresh. The client hooks
-- (useRealtimeSync) listen for postgres_changes, but those only fire
-- for tables in the supabase_realtime publication — this guarantees
-- they're all in it.
--
-- Idempotent: each ADD is guarded, so re-running this — or a project
-- whose publication is defined FOR ALL TABLES — is harmless.
-- ============================================================

do $$
declare
  t text;
  tables text[] := array[
    'todos', 'todo_mentions', 'clients', 'projects', 'payments',
    'commissions', 'project_document_requests', 'leads', 'pipelines',
    'pipeline_stages', 'meeting_bookings', 'meeting_links',
    'company_payments', 'notifications', 'resources', 'invoices',
    'profiles', 'invitations'
  ];
begin
  foreach t in array tables loop
    begin
      execute format(
        'alter publication supabase_realtime add table public.%I', t
      );
    exception
      when duplicate_object then null; -- already published
      when others then null;           -- e.g. publication is FOR ALL TABLES
    end;
  end loop;
end $$;
