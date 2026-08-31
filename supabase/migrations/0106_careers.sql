-- ============================================================
-- 0106_careers.sql
--
-- CAREERS — run hiring for www.arcai.agency from inside the CRM.
--
-- Today the careers page is edited in the website's own Supabase
-- tables and applications are read there too, which means hiring
-- happens in a database console instead of in the workspace where
-- everything else about the business lives.
--
-- This makes the CRM the control surface:
--
--   careers_vacancies    : write a role here, publish it, and it
--                          appears on the website's careers page.
--                          Unpublish and it disappears. The website's
--                          `career_vacancies` row is the published
--                          copy, this is the editable original.
--
--   careers_applications : every application ever submitted on the
--                          site, mirrored in, with the hiring
--                          workflow the website has no concept of —
--                          stage, rating, notes, who is reviewing.
--
-- Two things worth knowing about the direction of data:
--
--   • VACANCIES flow CRM → website. The CRM row is the original;
--     `source_id` is the id of the published copy on the site.
--     A vacancy that already existed on the website is pulled in
--     once, and from then on the CRM owns it.
--
--   • APPLICATIONS flow website → CRM, and only `status` is ever
--     written back. Everything else about an application is a fact
--     about what a candidate submitted and is never edited here.
--
-- The sync cursor lives in `web_sync_state` (0105) rather than in a
-- new table: that table is keyed on a stream name and holds nothing
-- specific to analytics, and a second identical table would mean the
-- Setup panel had two places to look for "when did this last run".
-- ============================================================

-- ---- Vacancies ----------------------------------------------
create table if not exists public.careers_vacancies (
  id                uuid primary key default gen_random_uuid(),

  -- The id of the published row in the WEBSITE's `career_vacancies`.
  -- Null means this role has never been published — it is a draft
  -- that exists only here.
  source_id         uuid unique,

  title             text not null default '',
  department        text not null default '',
  location          text not null default '',
  -- Maps to the website's `type` column. Named in full here because
  -- a bare `type` column in a CRM full of typed entities reads as a
  -- discriminator rather than as "Full-time".
  employment_type   text not null default 'Full-time',
  description       text not null default '',
  requirements      text not null default '',

  -- ---- CRM-only. None of this reaches the website. ----
  salary_range      text,
  headcount         integer not null default 1,
  internal_notes    text,
  closes_on         date,
  hiring_manager    uuid references public.profiles (id) on delete set null,

  -- ---- Publication ----
  -- draft     : never pushed
  -- published : live on the site
  -- archived  : pushed, then taken down (is_active=false on the site)
  -- failed    : the last push errored; `sync_error` says why
  status            text not null default 'draft'
                    check (status in ('draft', 'published', 'archived', 'failed')),
  published_at      timestamptz,
  unpublished_at    timestamptz,
  sync_error        text,
  synced_at         timestamptz,

  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists careers_vacancies_status_idx
  on public.careers_vacancies (status, created_at desc);
create index if not exists careers_vacancies_source_idx
  on public.careers_vacancies (source_id);

-- ---- Applications -------------------------------------------
create table if not exists public.careers_applications (
  id                  uuid primary key default gen_random_uuid(),

  -- The website row's id. Natural key for the mirror.
  source_id           uuid not null unique,
  -- The website vacancy this was submitted against, and the local
  -- vacancy it resolves to once that vacancy is known here.
  vacancy_source_id   uuid,
  vacancy_id          uuid references public.careers_vacancies (id) on delete set null,
  -- Denormalised so an application still says what it was for after a
  -- vacancy is archived and the join goes cold.
  vacancy_title       text not null default '',

  -- ---- What the candidate submitted. Never edited here. ----
  name                text not null default '',
  email               text not null default '',
  phone               text not null default '',
  personal_statement  text not null default '',
  earliest_start_date date,
  currently_employed  boolean not null default false,
  -- Public URL in the website's `career-cvs` bucket.
  cv_url              text not null default '',
  applied_at          timestamptz not null default now(),

  -- ---- The hiring workflow, which the website has no concept of ----
  stage               text not null default 'new'
                      check (stage in ('new', 'screening', 'interview',
                                       'offer', 'hired', 'rejected', 'withdrawn')),
  rating              integer check (rating between 1 and 5),
  notes               text,
  assigned_to         uuid references public.profiles (id) on delete set null,
  reviewed_at         timestamptz,
  rejected_reason     text,

  -- The website's own `status` column, mirrored so the two are never
  -- confused. `stage` is ours; this is theirs.
  website_status      text not null default 'pending',

  synced_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists careers_applications_stage_idx
  on public.careers_applications (stage, applied_at desc);
create index if not exists careers_applications_vacancy_idx
  on public.careers_applications (vacancy_id, applied_at desc);
create index if not exists careers_applications_applied_idx
  on public.careers_applications (applied_at desc);
create index if not exists careers_applications_email_idx
  on public.careers_applications (email);

-- ---- updated_at ---------------------------------------------
create or replace function public.touch_careers_row()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists careers_vacancies_touch on public.careers_vacancies;
create trigger careers_vacancies_touch
  before update on public.careers_vacancies
  for each row execute function public.touch_careers_row();

drop trigger if exists careers_applications_touch on public.careers_applications;
create trigger careers_applications_touch
  before update on public.careers_applications
  for each row execute function public.touch_careers_row();

-- ---- RLS ----------------------------------------------------
-- Same shape as every other table in the app: the team reads and
-- writes, the sync job goes in through the service role.
do $$
declare t text;
begin
  foreach t in array array['careers_vacancies', 'careers_applications'] loop
    execute format('alter table public.%I enable row level security', t);
    begin
      execute format('create policy "%s: read all" on public.%I for select to authenticated using (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: insert all" on public.%I for insert to authenticated with check (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: update all" on public.%I for update to authenticated using (true) with check (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: delete all" on public.%I for delete to authenticated using (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then null; end;
  end loop;
end $$;
