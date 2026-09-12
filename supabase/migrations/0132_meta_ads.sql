-- ============================================================
-- 0132 — Meta Ads: what the ads cost, next to what they produced
--
-- The CRM already knows what an ad PRODUCED — the WhatsApp chats it opened,
-- which of them became leads, which booked a call. It has never known what
-- the ad COST, so "is this campaign working?" was answered from two screens
-- and a calculator. These tables hold the Meta side, so /ads can put spend
-- and bookings in one funnel.
--
--   meta_ad_entities   campaigns, ad sets and ads (one row per Meta id)
--   meta_ad_insights   daily delivery + spend per entity (ad-account day)
--   meta_ad_syncs      one row per sync: when, what, and the analyst's read
--   wa_contacts.ad_*   first-touch Click-to-WhatsApp referral, from the webhook
--
-- WHO WRITES: nobody through the anon key. There is no Meta token in this
-- app on purpose (the owner's choice, Sept 2026): a Claude Code session with
-- a Meta Ads connector pulls the numbers and runs `scripts/ads-sync.mjs`,
-- which upserts with the service role. So there are no insert/update/delete
-- policies for `authenticated` at all — spend is not something a browser
-- session should be able to rewrite (the anon key ships to it; see 0129).
--
-- WHO READS: admins only. Ad spend is commercial data about the business,
-- in the same class as Web Analytics and AI Projects' billing.
--
-- Money is stored in MAJOR units of the ad account's currency (LKR 2,500.00,
-- not Meta's 250000 minor units) because every reader wants the major unit
-- and a conversion in each reader is one forgotten `/ 100` away from a 100×
-- error on a number people act on.
--
-- Additive and idempotent. Until it is applied /ads shows a setup screen and
-- the webhook's first-touch stamp is a logged no-op — messages still store.
-- ============================================================

-- 1. Entities -------------------------------------------------------------------
-- The id IS Meta's id: an upsert keyed on it is the whole sync, and a renamed
-- ad keeps its history because the history hangs off the id, not the name.

create table if not exists public.meta_ad_entities (
  id                text primary key,
  level             text not null check (level in ('campaign', 'adset', 'ad')),
  ad_account_id     text not null,
  name              text not null default '',
  -- Denormalised parents so "every ad in this campaign" is one indexed read.
  -- For a campaign row campaign_id = id; for an ad set, adset_id = id.
  campaign_id       text,
  adset_id          text,
  status            text,
  effective_status  text,
  objective         text,
  optimization_goal text,
  daily_budget      numeric(14, 2),
  lifetime_budget   numeric(14, 2),
  currency          text,
  start_time        timestamptz,
  end_time          timestamptz,
  targeting         jsonb,
  -- headline, body, description, prefill, image_hash, cta. The PREFILL is
  -- load-bearing: it is how a chat is attributed to an ad when WhatsApp did
  -- not deliver a referral (src/lib/meta-ads/attribution-core.ts).
  creative          jsonb,
  raw               jsonb,
  first_seen_at     timestamptz not null default now(),
  synced_at         timestamptz not null default now()
);

create index if not exists meta_ad_entities_campaign_idx
  on public.meta_ad_entities (campaign_id);
create index if not exists meta_ad_entities_level_idx
  on public.meta_ad_entities (level, synced_at desc);

-- 2. Daily insights --------------------------------------------------------------
-- One row per (level, entity, day). `date` is the AD ACCOUNT's day
-- (Asia/Colombo for this account), exactly as Meta reports it with
-- time_increment=1 — never re-bucketed here, or the totals stop matching
-- Ads Manager and nobody trusts either screen.
--
-- The unique key is what makes a re-sync safe: pulling the same window
-- twice overwrites, it never double-counts spend.

create table if not exists public.meta_ad_insights (
  id             uuid primary key default gen_random_uuid(),
  level          text not null check (level in ('campaign', 'adset', 'ad')),
  entity_id      text not null,
  campaign_id    text,
  adset_id       text,
  date           date not null,
  spend          numeric(14, 2) not null default 0,
  currency       text,
  impressions    integer not null default 0,
  reach          integer not null default 0,
  clicks         integer not null default 0,
  link_clicks    integer not null default 0,
  -- Meta's "messaging conversations started" — the ad's own count of chats.
  conversations  integer not null default 0,
  frequency      numeric,
  cpm            numeric,
  ctr            numeric,
  raw            jsonb,
  synced_at      timestamptz not null default now(),
  constraint meta_ad_insights_level_entity_date_key unique (level, entity_id, date)
);

create index if not exists meta_ad_insights_campaign_date_idx
  on public.meta_ad_insights (campaign_id, date);

-- 3. Syncs -----------------------------------------------------------------------
-- Written LAST by the sync script, after every upsert succeeded — so the
-- newest row here means "the numbers on screen are complete as of then",
-- and a sync that died half-way leaves "last synced" where it was.

create table if not exists public.meta_ad_syncs (
  id                 uuid primary key default gen_random_uuid(),
  source             text not null default 'claude'
                       check (source in ('claude', 'api', 'manual')),
  ad_account_id      text,
  window_start       date,
  window_end         date,
  entities_upserted  integer not null default 0,
  insights_upserted  integer not null default 0,
  -- The analyst's plain-English read of the numbers at sync time.
  summary            text,
  health             text check (health in ('good', 'watch', 'act')),
  recommendations    jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists meta_ad_syncs_account_idx
  on public.meta_ad_syncs (ad_account_id, created_at desc);

-- 4. First-touch ad referral on WhatsApp contacts --------------------------------
-- Meta attaches a `referral` object (ad id, ctwa_clid, headline…) to the
-- FIRST message after someone taps a Click-to-WhatsApp ad, and never again.
-- The webhook stamps it here once (guarded by ad_source_id IS NULL), so the
-- first ad that brought a person keeps the credit.
--
-- Deliberately NOT wa_contacts.campaign_id: that column means "whichever
-- wa_campaigns row was active when they first wrote", and the Sept 2026
-- Smart Websites row is the same row id the August ad used — it mixes two
-- campaigns and every organic chat that arrived while it was active.

alter table public.wa_contacts add column if not exists ad_source_id  text;
alter table public.wa_contacts add column if not exists ad_ctwa_clid  text;
alter table public.wa_contacts add column if not exists ad_referral   jsonb;
alter table public.wa_contacts add column if not exists ad_entered_at timestamptz;

create index if not exists wa_contacts_ad_source_idx
  on public.wa_contacts (ad_source_id);

-- 5. Access ----------------------------------------------------------------------
-- Admin read only. No write policy exists for `authenticated`, so with RLS on
-- every anon-key write is refused; the service role bypasses RLS.

do $$
declare t text;
begin
  foreach t in array array['meta_ad_entities', 'meta_ad_insights', 'meta_ad_syncs'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['meta_ad_entities', 'meta_ad_insights', 'meta_ad_syncs'] loop
    begin
      execute format(
        'create policy "%s: admin read" on public.%I for select to authenticated using (public.is_admin(auth.uid()))', t, t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- 6. Record ----------------------------------------------------------------------

insert into public.schema_migrations (version, note)
values ('0132_meta_ads', 'Meta Ads: meta_ad_* tables (admin read, service-role write) + wa_contacts first-touch ad referral')
on conflict (version) do nothing;
