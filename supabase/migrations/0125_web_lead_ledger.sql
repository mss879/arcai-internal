-- ============================================================
-- 0125_web_lead_ledger.sql
--
-- THE LEAD LEDGER: every website conversion, reconciled.
--
-- The Web Analytics page reported 17 conversions in a month. Fifteen were
-- footer-newsletter signups made by one spam script, two were WhatsApp
-- clicks, and none was an enquiry — but the number sat on the dashboard
-- as "conversions", next to a funnel in which only two sessions had
-- shown any intent. A conversion count that cannot be walked back to a
-- list of actual people is not a number a business can decide with.
--
-- This table is that list. One row per conversion EVENT the website
-- recorded (keyed by the lead id the tracker mints, so a form success and
-- the CRM lead it created share one key), with:
--
--   * where it came from — page, landing page, channel, campaign, country,
--   * who it was — the CRM lead it matched, or the email the visitor typed,
--   * a verdict — lead | test | spam | unreviewed — set by a rule on the
--     way in and overridable by a person, never the other way round,
--   * the outcome — read live from the matched lead (open / won / lost).
--
-- Every conversion figure the dashboard shows (web_daily.conversions, the
-- funnel's Converted stage, the per-page counts, the AI scan's evidence)
-- is computed FROM this table once it exists: a row counts when it is a
-- confirmed lead, or an enquiry nobody has marked spam or test. Contact
-- clicks (WhatsApp, tel:, mailto:) are recorded as intent and count only
-- when a person confirms them.
-- ============================================================

create table if not exists public.web_leads (
  id                 uuid primary key default gen_random_uuid(),
  site               text not null default 'arcai.agency',

  -- The tracker's lead id (`lead_…`) for enquiries; `<kind>:<session_id>`
  -- for contact clicks so repeated clicks collapse; `session:<session_id>`
  -- for a session flagged converted whose conversion event never arrived.
  lead_key           text not null,
  session_id         text not null,
  visitor_id         text,

  -- contact_form | chat_lead | job_request | whatsapp_click | call_click |
  -- email_click | … (whatever the website's tracker named it)
  kind               text not null,
  category           text not null default 'enquiry'
                     check (category in ('enquiry', 'contact_click', 'other')),
  occurred_at        timestamptz not null,
  -- UTC day, denormalised so the rollup can group without a cast per row.
  day                date not null,

  -- ---- Where ----
  path               text,
  entry_path         text,
  landing_page_title text,
  channel            text,
  utm_source         text,
  utm_medium         text,
  utm_campaign       text,
  referrer_domain    text,
  country            text,
  device_type        text,

  -- ---- Who ----
  identified_email   text,
  contact_name       text,
  contact_email      text,
  contact_phone      text,
  crm_lead_id        uuid references public.leads (id) on delete set null,
  -- lead_id | hook | session | email | chat | null
  match_method       text,

  -- ---- Verdict ----
  status             text not null default 'unreviewed'
                     check (status in ('unreviewed', 'lead', 'test', 'spam')),
  -- none: nobody has said; rule: the ledger's own classifier; manual: a
  -- person, which the classifier never overrides.
  status_source      text not null default 'none'
                     check (status_source in ('none', 'rule', 'manual')),
  status_reason      text,
  status_set_by      uuid references public.profiles (id) on delete set null,
  status_set_at      timestamptz,

  -- The web_events row this was built from; null for hook- or session-derived rows.
  source_event_id    bigint,
  -- How many conversion events collapsed into this row (a WhatsApp button
  -- clicked four times is one row with occurrences = 4).
  occurrences        integer not null default 1,
  -- Signals the classifier saw: untouched, implicit_start, zero_engagement,
  -- quoted_user_agent, dotted_gmail, test_mode, bot.
  flags              jsonb not null default '{}',

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists web_leads_key_idx on public.web_leads (site, lead_key);
create index if not exists web_leads_time_idx on public.web_leads (site, occurred_at desc);
create index if not exists web_leads_day_idx on public.web_leads (site, day);
create index if not exists web_leads_session_idx on public.web_leads (session_id);
create index if not exists web_leads_crm_lead_idx on public.web_leads (crm_lead_id);
create index if not exists web_leads_status_idx on public.web_leads (site, status);

drop trigger if exists web_leads_set_updated_at on public.web_leads;
create trigger web_leads_set_updated_at
  before update on public.web_leads
  for each row execute function public.set_updated_at();

-- Same shape as 0105: the sync writes with the service role, people read.
alter table public.web_leads enable row level security;
do $$
begin
  begin
    create policy "web_leads: read all" on public.web_leads
      for select to authenticated using (true);
  exception when duplicate_object then null; end;
  begin
    create policy "web_leads: insert all" on public.web_leads
      for insert to authenticated with check (true);
  exception when duplicate_object then null; end;
  begin
    create policy "web_leads: update all" on public.web_leads
      for update to authenticated using (true) with check (true);
  exception when duplicate_object then null; end;
  begin
    create policy "web_leads: delete all" on public.web_leads
      for delete to authenticated using (true);
  exception when duplicate_object then null; end;
end $$;

-- ---- The lead's side of the key --------------------------------------
-- The website's contact form mints a lead id BEFORE it sends, posts it to
-- the inbound webhook with the enquiry, and records the same id on the
-- analytics conversion. Storing it here is what makes "this conversion is
-- this lead" a join and not a guess by time and email.
alter table public.leads
  add column if not exists website_lead_id text,
  add column if not exists web_session_id  text,
  add column if not exists web_visitor_id  text;

create index if not exists leads_website_lead_idx
  on public.leads (website_lead_id) where website_lead_id is not null;
create index if not exists leads_web_session_idx
  on public.leads (web_session_id) where web_session_id is not null;

-- ---- Daily rollup: what was counted and what was set aside -----------
alter table public.web_daily
  -- WhatsApp / tel: / mailto: clicks that day — intent, shown beside conversions, not inside them.
  add column if not exists contact_clicks       integer not null default 0,
  -- Conversion events the ledger filed as spam or test that day.
  add column if not exists excluded_conversions integer not null default 0;

-- ---- The checklist learns whether its items were actually done -------
-- "Check progress" reads the current numbers against each open item's
-- target and records a verdict here, so the list can be trusted before the
-- next full scan rewrites it.
alter table public.web_insight_tasks
  add column if not exists check_status text
    check (check_status in ('done', 'in_progress', 'not_done', 'cannot_tell')),
  add column if not exists check_note   text,
  add column if not exists checked_at   timestamptz;
