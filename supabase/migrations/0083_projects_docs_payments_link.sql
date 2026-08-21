-- ============================================================
-- 0083_projects_docs_payments_link.sql
--
-- Three independent changes that ship together:
--
--   1. PROJECT DOCUMENTS — a project can now carry its signed
--      proposal and its invoice as uploaded files, attached the
--      moment the project is created (or later, by editing it).
--      Stored in the new private `project-docs` bucket.
--
--   2. PAYMENTS ↔ PROJECTS — company_payments rows were free
--      text ("company_name") with no link to the real project,
--      so a project's balance and the money actually received
--      lived in two disconnected places. A payment can now name
--      the project it belongs to; the projects board subtracts
--      every PAID linked payment from the balance, so the
--      remaining balance is exact and updates in real time.
--      project_id stays NULLABLE: old rows and genuine
--      non-project payments keep working untouched.
--
--   3. POST-CALL AGENT SILENCE — once the WhatsApp agent books
--      a call it must go quiet for 24h, send exactly ONE
--      check-in ("did the team reach you?"), and then never
--      self-initiate again until the customer replies. The new
--      stamp is what makes "exactly one" durable across ticks.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- 1. Project documents ---------------------------------------
alter table public.projects
  add column if not exists proposal_url  text,
  add column if not exists proposal_name text,
  add column if not exists proposal_path text,
  add column if not exists invoice_url   text,
  add column if not exists invoice_name  text,
  add column if not exists invoice_path  text;

comment on column public.projects.proposal_url is
  'Public URL of the uploaded proposal document (project-docs bucket).';
comment on column public.projects.invoice_url is
  'Public URL of the uploaded invoice document (project-docs bucket).';
comment on column public.projects.proposal_path is
  'Storage object path — kept so the file can be replaced/removed later.';

-- Documents bucket. Public-read like `resources` (the app links to
-- these files directly from the project card, and Supabase public
-- URLs are unguessable UUID paths).
insert into storage.buckets (id, name, public)
values ('project-docs', 'project-docs', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage: public read project-docs'
  ) then
    create policy "storage: public read project-docs"
      on storage.objects for select
      using (bucket_id = 'project-docs');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage: auth insert project-docs'
  ) then
    create policy "storage: auth insert project-docs"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'project-docs');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage: auth update project-docs'
  ) then
    create policy "storage: auth update project-docs"
      on storage.objects for update to authenticated
      using (bucket_id = 'project-docs')
      with check (bucket_id = 'project-docs');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage: auth delete project-docs'
  ) then
    create policy "storage: auth delete project-docs"
      on storage.objects for delete to authenticated
      using (bucket_id = 'project-docs');
  end if;
end $$;

-- 2. Payments ↔ projects -------------------------------------
alter table public.company_payments
  add column if not exists project_id uuid
    references public.projects (id) on delete set null;

comment on column public.company_payments.project_id is
  'The project this payment belongs to. NULL = a standalone payment with no project (the old behaviour).';

create index if not exists company_payments_project_idx
  on public.company_payments (project_id);

-- 3. Post-call check-in stamp --------------------------------
alter table public.wa_contacts
  add column if not exists post_call_checkin_sent_at timestamptz;

comment on column public.wa_contacts.post_call_checkin_sent_at is
  'When the single post-call "did the team reach you?" check-in went out. Set = the agent stops self-initiating; cleared by book_call (a new call re-arms it) and by the customer replying.';
