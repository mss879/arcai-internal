-- ============================================================
-- 0105_web_analytics.sql
--
-- WEB ANALYTICS — www.arcai.agency, mirrored into the CRM.
--
-- This is NOT the `visitor_events` table from 0034. That one is the
-- app's own lightweight snippet for sites we manage, and it stays
-- exactly as it is. This is a separate warehouse for one specific
-- site — the agency's own — pulled from the WEBSITE's Supabase
-- project on a schedule, because the two live in different
-- projects and always will.
--
-- Why mirror at all rather than query the site's database live:
--
--   • The dashboard has to join website behaviour against CRM leads,
--     projects and revenue. You cannot join across two Postgres
--     projects, so one side has to come to the other.
--   • Rollups computed once a night are cheap to read a hundred
--     times a day. Recomputing "top pages, last 90 days" from raw
--     events on every page load is not.
--   • The site prunes its raw events on a rolling window. The CRM
--     is where the history is meant to live, so the mirror is the
--     archive, not just a cache.
--
--   web_sessions       : one row per visit — source, device, geo,
--                        journey endpoints, engagement, conversion
--   web_events         : the ordered event stream inside each visit
--   web_daily          : per-day rollup, the dashboard's fast path
--   web_page_daily     : per-page-per-day rollup
--   web_journeys       : page-to-page transitions and whole paths
--   web_chat_sessions  : the site's AI agent, one row per conversation
--   web_chat_messages  : every message in those conversations
--   web_reports        : AI-written analytics reports
--   web_sync_state     : the incremental cursor per stream
--   web_sync_runs      : the audit trail of every pull
-- ============================================================

-- ---- Sessions ----------------------------------------------
create table if not exists public.web_sessions (
  id                   uuid primary key default gen_random_uuid(),
  -- The site's own session id. Natural key for the mirror: re-pulling
  -- a session that has since gained ten more events must update the
  -- row, never duplicate it.
  session_id           text not null unique,
  visitor_id           text not null,
  site                 text not null default 'arcai.agency',

  first_seen_at        timestamptz not null,
  last_seen_at         timestamptz not null,

  entry_path           text not null default '/',
  exit_path            text,
  page_count           integer not null default 0,
  event_count          integer not null default 0,
  duration_seconds     integer not null default 0,
  engaged_seconds      integer not null default 0,
  is_bounce            boolean not null default true,
  max_scroll_pct       integer not null default 0,

  landing_referrer     text,
  referrer_domain      text,
  channel              text not null default 'direct',
  utm_source           text,
  utm_medium           text,
  utm_campaign         text,
  utm_term             text,
  utm_content          text,
  gclid                text,
  fbclid               text,
  msclkid              text,
  first_touch_channel  text,
  first_touch_campaign text,
  landing_page_title   text,

  device_type          text not null default 'unknown',
  browser              text,
  browser_version      text,
  os                   text,
  os_version           text,
  screen_w             integer,
  screen_h             integer,
  viewport_w           integer,
  viewport_h           integer,
  device_pixel_ratio   numeric(4,2),
  language             text,
  timezone             text,
  connection_type      text,
  user_agent           text,

  country              text,
  country_code         text,
  region               text,
  city                 text,

  converted            boolean not null default false,
  conversion_kind      text,
  conversion_at        timestamptz,
  chat_engaged         boolean not null default false,
  chat_message_count   integer not null default 0,
  identified_email     text,
  forms_started        integer not null default 0,
  forms_abandoned      integer not null default 0,
  outbound_clicks      integer not null default 0,
  rage_clicks          integer not null default 0,
  is_bot               boolean not null default false,

  -- Set when identified_email matches a lead or client already in the
  -- CRM. This is the whole point of mirroring into this database: an
  -- anonymous session becomes a named person with a deal value.
  matched_lead_id      uuid references public.leads (id) on delete set null,
  matched_client_id    uuid references public.clients (id) on delete set null,

  -- updated_at on the SOURCE row. The sync watermark reads this, so a
  -- session that gains events after it was first pulled comes back.
  source_updated_at    timestamptz not null default now(),
  synced_at            timestamptz not null default now()
);

create index if not exists web_sessions_seen_idx on public.web_sessions (first_seen_at desc);
create index if not exists web_sessions_visitor_idx on public.web_sessions (visitor_id, first_seen_at desc);
create index if not exists web_sessions_channel_idx on public.web_sessions (channel, first_seen_at desc);
create index if not exists web_sessions_converted_idx on public.web_sessions (converted, first_seen_at desc);
create index if not exists web_sessions_country_idx on public.web_sessions (country_code, first_seen_at desc);
create index if not exists web_sessions_source_updated_idx on public.web_sessions (source_updated_at desc);
create index if not exists web_sessions_email_idx on public.web_sessions (identified_email) where identified_email is not null;

-- ---- Events -------------------------------------------------
create table if not exists public.web_events (
  id            bigserial primary key,
  -- Which stream the row came from and its id THERE. Two sources feed
  -- this table — the rich `analytics_events` stream and the site's older
  -- `page_visits` log, whose ids are uuids and would collide with a
  -- bigint key. The pair is unique, so re-pulling either stream updates
  -- rather than duplicates.
  source        text not null default 'analytics_events',
  source_id     text not null,
  session_id    text not null,
  visitor_id    text not null,
  site          text not null default 'arcai.agency',
  seq           integer not null default 0,
  occurred_at   timestamptz not null,
  kind          text not null,
  path          text not null default '/',
  page_title    text,
  referrer      text,
  element       text,
  element_text  text,
  href          text,
  value         numeric,
  meta          jsonb not null default '{}',
  synced_at     timestamptz not null default now()
);

create unique index if not exists web_events_source_idx on public.web_events (source, source_id);
create index if not exists web_events_session_idx on public.web_events (session_id, seq);
create index if not exists web_events_time_idx on public.web_events (occurred_at desc);
create index if not exists web_events_kind_idx on public.web_events (kind, occurred_at desc);
create index if not exists web_events_path_idx on public.web_events (path, occurred_at desc);

-- ---- Daily rollup -------------------------------------------
-- Recomputed by the sync for every day it touched. Whole-day rows are
-- stable; today's row is rewritten on each run.
create table if not exists public.web_daily (
  id                    uuid primary key default gen_random_uuid(),
  site                  text not null default 'arcai.agency',
  day                   date not null,

  sessions              integer not null default 0,
  visitors              integer not null default 0,
  new_visitors          integer not null default 0,
  returning_visitors    integer not null default 0,
  pageviews             integer not null default 0,
  bounces               integer not null default 0,
  bounce_rate           numeric(5,2) not null default 0,
  avg_duration_seconds  numeric(10,2) not null default 0,
  avg_engaged_seconds   numeric(10,2) not null default 0,
  avg_pages_per_session numeric(6,2) not null default 0,
  avg_scroll_pct        numeric(5,2) not null default 0,

  conversions           integer not null default 0,
  conversion_rate       numeric(5,2) not null default 0,
  forms_started         integer not null default 0,
  forms_abandoned       integer not null default 0,
  chat_sessions         integer not null default 0,
  chat_messages         integer not null default 0,
  rage_clicks           integer not null default 0,
  outbound_clicks       integer not null default 0,
  errors                integer not null default 0,

  -- Breakdowns kept as jsonb rather than as their own tables: they are
  -- always read whole, alongside the row they belong to, and never
  -- filtered on. A table per dimension would be five more joins for
  -- data that is already one screen's worth.
  by_channel            jsonb not null default '{}',
  by_device             jsonb not null default '{}',
  by_country            jsonb not null default '{}',
  by_browser            jsonb not null default '{}',
  by_source             jsonb not null default '{}',
  by_campaign           jsonb not null default '{}',
  top_pages             jsonb not null default '[]',
  top_entry_pages       jsonb not null default '[]',
  top_exit_pages        jsonb not null default '[]',
  top_referrers         jsonb not null default '[]',
  web_vitals            jsonb not null default '{}',

  computed_at           timestamptz not null default now()
);

create unique index if not exists web_daily_day_idx on public.web_daily (site, day);

-- ---- Per-page daily -----------------------------------------
create table if not exists public.web_page_daily (
  id                   uuid primary key default gen_random_uuid(),
  site                 text not null default 'arcai.agency',
  day                  date not null,
  path                 text not null,
  page_title           text,

  pageviews            integer not null default 0,
  unique_visitors      integer not null default 0,
  entries              integer not null default 0,
  exits                integer not null default 0,
  bounces              integer not null default 0,
  avg_seconds_on_page  numeric(10,2) not null default 0,
  avg_scroll_pct       numeric(5,2) not null default 0,
  conversions          integer not null default 0,
  form_starts          integer not null default 0,
  form_abandons        integer not null default 0,
  rage_clicks          integer not null default 0,
  cta_clicks           integer not null default 0,

  computed_at          timestamptz not null default now()
);

create unique index if not exists web_page_daily_idx on public.web_page_daily (site, day, path);
create index if not exists web_page_daily_path_idx on public.web_page_daily (path, day desc);

-- ---- Journeys -----------------------------------------------
-- Two shapes in one table because they answer the same question at two
-- zoom levels. `transition` is "from this page, where next" — the edge
-- list you need to see where people leak out. `path` is the whole
-- ordered route, which is what "do they land on home and then go where"
-- actually means.
create table if not exists public.web_journeys (
  id             uuid primary key default gen_random_uuid(),
  site           text not null default 'arcai.agency',
  period_start   date not null,
  period_end     date not null,
  kind           text not null default 'transition' check (kind in ('transition', 'path')),

  from_path      text,
  to_path        text,
  -- For kind='path': the whole route, e.g. "/ > /services > /contact".
  path_sequence  text,
  step_index     integer,

  sessions       integer not null default 0,
  conversions    integer not null default 0,
  -- Sessions whose visit ENDED on this transition — the drop-off rate
  -- is the number everyone actually looks at.
  drop_offs      integer not null default 0,
  avg_seconds    numeric(10,2) not null default 0,

  computed_at    timestamptz not null default now()
);

create index if not exists web_journeys_period_idx on public.web_journeys (site, period_start, kind);
create index if not exists web_journeys_from_idx on public.web_journeys (from_path, sessions desc);

-- ---- Website AI agent conversations -------------------------
create table if not exists public.web_chat_sessions (
  id                uuid primary key default gen_random_uuid(),
  -- The site's chat session id (or the chat_logs row id for the older
  -- single-blob format). Unique so re-pulling updates rather than dupes.
  source_id         text not null unique,
  site              text not null default 'arcai.agency',
  -- 'chat_messages' (per-message rows) or 'chat_logs' (one JSON blob).
  source_table      text not null default 'chat_messages',

  started_at        timestamptz not null,
  last_message_at   timestamptz not null,
  message_count     integer not null default 0,
  user_messages     integer not null default 0,
  assistant_messages integer not null default 0,

  first_user_message text,
  transcript         text not null default '',

  -- Filled by the AI pass over the transcript, not by the sync.
  topic             text,
  intent            text,
  sentiment         text,
  summary           text,
  buying_signals    jsonb not null default '[]',
  questions_asked   jsonb not null default '[]',
  analysed_at       timestamptz,

  -- Whatever the site knew about who was talking.
  ip_location       text,
  captured_email    text,
  captured_phone    text,
  metadata          jsonb not null default '{}',

  -- Stitched to the browsing session when the ids line up, and to the
  -- CRM when the email does.
  web_session_id    text,
  matched_lead_id   uuid references public.leads (id) on delete set null,

  synced_at         timestamptz not null default now()
);

create index if not exists web_chat_sessions_started_idx on public.web_chat_sessions (started_at desc);
create index if not exists web_chat_sessions_topic_idx on public.web_chat_sessions (topic);

create table if not exists public.web_chat_messages (
  id           uuid primary key default gen_random_uuid(),
  source_id    text not null unique,
  chat_id      uuid references public.web_chat_sessions (id) on delete cascade,
  session_id   text not null,
  role         text not null default 'user',
  content      text not null default '',
  char_count   integer not null default 0,
  created_at   timestamptz not null,
  synced_at    timestamptz not null default now()
);

create index if not exists web_chat_messages_chat_idx on public.web_chat_messages (chat_id, created_at);
create index if not exists web_chat_messages_session_idx on public.web_chat_messages (session_id, created_at);

-- ---- Generated reports --------------------------------------
create table if not exists public.web_reports (
  id            uuid primary key default gen_random_uuid(),
  site          text not null default 'arcai.agency',
  kind          text not null default 'weekly'
                check (kind in ('daily', 'weekly', 'monthly', 'quarterly', 'custom')),
  period_start  date not null,
  period_end    date not null,
  title         text not null default '',
  -- Markdown. Rendered in the app, pasteable into an email or a deck.
  content       text not null default '',
  -- The numbers the narrative was written from, so a claim in the prose
  -- can always be checked against the figure it came from.
  stats         jsonb not null default '{}',
  highlights    jsonb not null default '[]',
  recommendations jsonb not null default '[]',
  generated_by  text not null default 'ai',
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists web_reports_period_idx on public.web_reports (site, kind, period_start desc);

-- ---- Sync bookkeeping ---------------------------------------
-- One row per stream. `cursor_ts` is the high-water mark; `cursor_id`
-- breaks ties for streams keyed on a bigint id, so a batch that lands
-- inside the same second is not skipped or re-read forever.
create table if not exists public.web_sync_state (
  stream        text primary key,
  cursor_ts     timestamptz,
  cursor_id     bigint,
  last_run_at   timestamptz,
  last_ok_at    timestamptz,
  rows_synced   bigint not null default 0,
  last_error    text,
  updated_at    timestamptz not null default now()
);

create table if not exists public.web_sync_runs (
  id           uuid primary key default gen_random_uuid(),
  stream       text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  rows_synced  integer not null default 0,
  ok           boolean not null default false,
  error        text,
  duration_ms  integer
);

create index if not exists web_sync_runs_started_idx on public.web_sync_runs (started_at desc);

-- ---- RLS ----------------------------------------------------
-- Every write happens through the service-role client inside the sync
-- job; authenticated users read. Same shape as 0034.
do $$
declare t text;
begin
  foreach t in array array[
    'web_sessions', 'web_events', 'web_daily', 'web_page_daily',
    'web_journeys', 'web_chat_sessions', 'web_chat_messages',
    'web_reports', 'web_sync_state', 'web_sync_runs'
  ] loop
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
  end loop;
end $$;

-- Realtime only where a live screen benefits: the dashboard header and
-- the sync status strip. Streaming raw events into every open browser
-- would be a lot of traffic for numbers nobody reads per-row.
do $$
declare t text;
begin
  foreach t in array array['web_daily', 'web_reports', 'web_sync_state'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then null; end;
  end loop;
end $$;
