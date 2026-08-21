-- ============================================================
-- 0084_delivery_core.sql
--
-- CLIENT DELIVERY HUB — part 1 of 3 (0084 → 0086).
--
--   1. PROJECTS gain a delivery pipeline: a `delivery_stage`
--      (onboarding → assets → build → review → delivered →
--      aftercare) that is separate from the existing `status`
--      column so nothing that reads status breaks. Plus the
--      stamps the new automations need: when onboarding was
--      kicked off (one kickoff per project, ever — the column
--      doubles as the claim), when the stage last moved, when
--      a stalled alert last fired, and a real `updated_at`
--      so "stalled" is measurable at all.
--
--   2. PROJECT_DOCUMENT_REQUESTS (0016) grows from a plain
--      portal checklist into the asset-collection engine:
--      category, required/optional, ordering, where the file
--      came from (portal upload, WhatsApp, team), a link to
--      the WhatsApp message that carried it, file metadata,
--      and the chaser bookkeeping (how many nudges, when the
--      last one went out). Status gains 'na' — "client
--      doesn't have this one".
--
--   3. DELIVERY_SETTINGS singleton (id = 1, same shape as
--      wa_agent_config) — chaser cadence, stalled threshold,
--      the onboarding kickoff template, and every message the
--      automations send, all editable from the hub.
--
--   4. DELIVERY_EVENTS — the per-project activity feed the
--      hub's Activity tab renders (kickoffs, chases, stage
--      moves, assets landing).
--
--   5. SECURITY FIX — 0016 shipped anon RLS policies whose
--      predicates were effectively USING (true): anonymous
--      users could read every project and read/UPDATE every
--      document request. The public portal never used them —
--      it runs entirely through server code with the service
--      role — so they are pure attack surface. Dropped.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- 1. Projects: delivery pipeline columns ---------------------
alter table public.projects
  add column if not exists delivery_stage text,
  add column if not exists delivery_stage_changed_at timestamptz,
  add column if not exists onboarding_started_at timestamptz,
  add column if not exists stalled_alerted_at timestamptz,
  add column if not exists chaser_paused boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

alter table public.projects drop constraint if exists projects_delivery_stage_check;
alter table public.projects add constraint projects_delivery_stage_check check (
  delivery_stage is null or delivery_stage in
    ('onboarding', 'assets', 'build', 'review', 'delivered', 'aftercare')
);

-- Keep updated_at honest (generic touch function from 0001).
drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- 2. Document requests → asset-collection engine -------------
alter table public.project_document_requests
  add column if not exists category text,
  add column if not exists required boolean not null default true,
  add column if not exists position integer not null default 0,
  add column if not exists source text not null default 'team',
  add column if not exists wa_message_id uuid references public.wa_messages (id) on delete set null,
  add column if not exists file_size bigint,
  add column if not exists file_type text,
  add column if not exists chase_count integer not null default 0,
  add column if not exists last_chased_at timestamptz;

alter table public.project_document_requests
  drop constraint if exists project_document_requests_status_check;
alter table public.project_document_requests
  add constraint project_document_requests_status_check
  check (status in ('pending', 'submitted', 'na'));

alter table public.project_document_requests
  drop constraint if exists project_document_requests_category_check;
alter table public.project_document_requests
  add constraint project_document_requests_category_check
  check (category is null or category in ('brand', 'content', 'photos', 'access'));

alter table public.project_document_requests
  drop constraint if exists project_document_requests_source_check;
alter table public.project_document_requests
  add constraint project_document_requests_source_check
  check (source in ('portal', 'whatsapp', 'team'));

create index if not exists project_document_requests_pending_idx
  on public.project_document_requests (project_id)
  where status = 'pending';

-- 3. delivery_settings singleton -----------------------------
create table if not exists public.delivery_settings (
  id                        integer primary key check (id = 1),
  chaser_enabled            boolean not null default false,
  chaser_interval_days      integer not null default 3,
  chaser_max_touches        integer not null default 3,
  chaser_message            text not null default 'Hi {{name}}! Quick nudge from ARC AI — to keep your project moving we still need: {{missing_items}}. You can send them right here on WhatsApp, or upload everything at once: {{portal_link}}',
  chaser_template_name      text,
  chaser_template_lang      text not null default 'en',
  stalled_days              integer not null default 5,
  stalled_alerts_enabled    boolean not null default true,
  onboarding_template_name  text,
  onboarding_template_lang  text not null default 'en',
  welcome_message           text not null default 'Hi {{name}}! 🎉 Payment received — your project with ARC AI is officially underway. I''ll be collecting a few things here to get the build started (logo, photos, content). First up: could you send over your logo?',
  milestone_notify_enabled  boolean not null default true,
  milestone_messages        jsonb not null default '{}'::jsonb,
  review_ask_enabled        boolean not null default false,
  google_review_url         text,
  updated_at                timestamptz not null default now()
);

insert into public.delivery_settings (id) values (1)
on conflict (id) do nothing;

drop trigger if exists delivery_settings_set_updated_at on public.delivery_settings;
create trigger delivery_settings_set_updated_at
  before update on public.delivery_settings
  for each row execute function public.set_updated_at();

alter table public.delivery_settings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'delivery_settings'
      and policyname = 'delivery_settings: read authenticated'
  ) then
    create policy "delivery_settings: read authenticated"
      on public.delivery_settings for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'delivery_settings'
      and policyname = 'delivery_settings: update authenticated'
  ) then
    create policy "delivery_settings: update authenticated"
      on public.delivery_settings for update to authenticated
      using (true) with check (true);
  end if;
end $$;

-- 4. delivery_events activity feed ---------------------------
create table if not exists public.delivery_events (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  kind       text not null check (kind in (
    'kickoff', 'stage_changed', 'asset_submitted', 'asset_filed', 'asset_na',
    'chase_sent', 'stalled_alert', 'assets_complete', 'milestone_sent'
  )),
  detail     text,
  actor      text,
  meta       jsonb,
  created_at timestamptz not null default now()
);

create index if not exists delivery_events_project_idx
  on public.delivery_events (project_id, created_at desc);

alter table public.delivery_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'delivery_events'
      and policyname = 'delivery_events: read authenticated'
  ) then
    create policy "delivery_events: read authenticated"
      on public.delivery_events for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'delivery_events'
      and policyname = 'delivery_events: insert authenticated'
  ) then
    create policy "delivery_events: insert authenticated"
      on public.delivery_events for insert to authenticated with check (true);
  end if;
end $$;

-- 5. SECURITY FIX: drop the over-broad anon policies from 0016.
-- The public portal reads and writes exclusively through server code
-- using the service role, so nothing legitimate uses these.
drop policy if exists "projects: public read by share_token" on public.projects;
drop policy if exists "project_document_requests: public read" on public.project_document_requests;
drop policy if exists "project_document_requests: public update" on public.project_document_requests;

-- 6. Realtime for the new feed (0021 guard pattern) ----------
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.delivery_events';
  exception
    when duplicate_object then null;
  end;
end $$;

-- 7. Member-change audit (0081 pattern) for the tables members
-- now edit from the hub. Service-role writes stay unlogged, by design.
do $$
declare
  t text;
begin
  foreach t in array array['project_document_requests', 'delivery_events'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists member_changes_audit on public.%I', t);
      execute format(
        'create trigger member_changes_audit
           after insert or update or delete on public.%I
           for each row execute function public.log_member_change()',
        t
      );
    end if;
  end loop;
end $$;
