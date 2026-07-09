-- ============================================================
-- 0044_prospecting.sql
-- "Find Leads" — the area-based prospecting agent. A scan picks a
-- country + city + business categories; the agent then:
--
--   searching  : Google Places lists real businesses in the area
--   qualifying : no website / Facebook-only / bad website → lead
--                material (with the site's issues); good website
--                or excluded category → skipped, with the reason
--   drafting   : AI relevance pass + personalised cold email/SMS
--                drafts per qualified business
--   importing  : qualified candidates become CRM leads tagged with
--                the city (+ 'prospecting'), issues in the notes
--
--   prospect_scans      : one row per scan run (state machine, the
--                         automation tick advances it like research)
--   prospect_candidates : every business seen, qualified or not.
--                         place_id is globally UNIQUE so re-scanning
--                         an area never re-imports the same business.
--
-- sms_messages.kind gains 'prospecting' so cold-outreach texts show
-- up in the SMS history log.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ---- Scans ---------------------------------------------------
create table if not exists public.prospect_scans (
  id               uuid primary key default gen_random_uuid(),
  status           text not null default 'pending'
                   check (status in (
                     'pending', 'searching', 'qualifying',
                     'drafting', 'importing', 'done', 'error'
                   )),
  country          text not null default 'Sri Lanka',
  city             text not null,
  categories       text[] not null default '{}',
  max_results      int  not null default 40 check (max_results between 5 and 120),
  -- Sites scoring BELOW this are "bad website" leads; at/above → skipped.
  min_score        int  not null default 60 check (min_score between 20 and 90),
  -- When false (default) imported leads do NOT fire lead_created
  -- automations — cold prospects must not get inbound keep-warm flows.
  fire_automations boolean not null default false,
  -- Destination for imported leads.
  pipeline_id      uuid references public.pipelines (id) on delete set null,
  stage_id         uuid references public.pipeline_stages (id) on delete set null,
  -- Working state: step cursor, counters, timings (jsonb, replaced per step).
  analysis         jsonb not null default '{}'::jsonb,
  found            int not null default 0,
  qualified        int not null default 0,
  skipped          int not null default 0,
  imported         int not null default 0,
  error            text,
  locked_at        timestamptz,
  created_by       uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists prospect_scans_status_idx
  on public.prospect_scans (status, updated_at);
create index if not exists prospect_scans_created_idx
  on public.prospect_scans (created_at desc);

create or replace function public.set_prospect_scans_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists prospect_scans_set_updated_at on public.prospect_scans;
create trigger prospect_scans_set_updated_at
  before update on public.prospect_scans
  for each row execute function public.set_prospect_scans_updated_at();

-- ---- Candidates ----------------------------------------------
create table if not exists public.prospect_candidates (
  id              uuid primary key default gen_random_uuid(),
  scan_id         uuid not null references public.prospect_scans (id) on delete cascade,
  -- Google place_id (or the site domain in Firecrawl-fallback mode).
  -- Globally unique = cross-scan dedupe: a business is only ever seen once.
  place_id        text not null unique,
  name            text not null,
  category        text not null default '',
  address         text not null default '',
  phone           text not null default '',
  website         text not null default '',
  rating          numeric,
  rating_count    int not null default 0,
  website_verdict text not null default 'pending'
                  check (website_verdict in (
                    'pending', 'no_website', 'facebook_only', 'bad_website',
                    'broken', 'good_website', 'excluded', 'duplicate'
                  )),
  -- quickSiteScore result for has-website candidates (0-100; null = n/a).
  score           int,
  issues          text[] not null default '{}',
  emails          text[] not null default '{}',
  contact_name    text not null default '',
  draft_subject   text not null default '',
  draft_body      text not null default '',
  draft_sms       text not null default '',
  status          text not null default 'pending'
                  check (status in ('pending', 'qualified', 'skipped', 'imported', 'emailed')),
  -- Why it was skipped / any note the pipeline wants to surface.
  reason          text not null default '',
  lead_id         uuid references public.leads (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists prospect_candidates_scan_idx
  on public.prospect_candidates (scan_id, status);

-- ---- RLS (single-workspace: any authenticated member) --------
alter table public.prospect_scans      enable row level security;
alter table public.prospect_candidates enable row level security;

drop policy if exists "prospect_scans: read all"   on public.prospect_scans;
drop policy if exists "prospect_scans: insert all" on public.prospect_scans;
drop policy if exists "prospect_scans: update all" on public.prospect_scans;
drop policy if exists "prospect_scans: delete all" on public.prospect_scans;

create policy "prospect_scans: read all"
  on public.prospect_scans for select to authenticated using (true);
create policy "prospect_scans: insert all"
  on public.prospect_scans for insert to authenticated with check (true);
create policy "prospect_scans: update all"
  on public.prospect_scans for update to authenticated using (true) with check (true);
create policy "prospect_scans: delete all"
  on public.prospect_scans for delete to authenticated using (true);

drop policy if exists "prospect_candidates: read all"   on public.prospect_candidates;
drop policy if exists "prospect_candidates: insert all" on public.prospect_candidates;
drop policy if exists "prospect_candidates: update all" on public.prospect_candidates;
drop policy if exists "prospect_candidates: delete all" on public.prospect_candidates;

create policy "prospect_candidates: read all"
  on public.prospect_candidates for select to authenticated using (true);
create policy "prospect_candidates: insert all"
  on public.prospect_candidates for insert to authenticated with check (true);
create policy "prospect_candidates: update all"
  on public.prospect_candidates for update to authenticated using (true) with check (true);
create policy "prospect_candidates: delete all"
  on public.prospect_candidates for delete to authenticated using (true);

-- ---- Cold-outreach texts in the SMS history ------------------
alter table public.sms_messages
  drop constraint if exists sms_messages_kind_check;

alter table public.sms_messages
  add constraint sms_messages_kind_check
  check (kind in (
    'custom', 'payment_reminder', 'automation', 'promotion',
    'todo_reminder', 'meeting_reminder', 'prospecting'
  ));

-- ---- Live updates (optional; ignored if FOR ALL TABLES) ------
do $$
begin
  alter publication supabase_realtime add table public.prospect_scans;
exception when others then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.prospect_candidates;
exception when others then null;
end $$;
