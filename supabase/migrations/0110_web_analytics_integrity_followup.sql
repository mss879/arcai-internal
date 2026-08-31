-- 0110 — Web Analytics integrity, part two.
--
-- 0109 was edited after it had already been run, so which of its statements
-- landed depends on when it was run. Every statement here is `if not exists`
-- and re-states the whole set, so running this after any version of 0109 —
-- or after none of it — leaves the same schema. It is safe to run twice.

-- ---- web_daily: measured vs reconstructed -------------------------------
--
-- The table mixes two populations that look identical in a count and are
-- nothing alike in a behavioural average: sessions the first-party tracker
-- instrumented, and sessions reconstructed from the site's old `page_visits`
-- log, which recorded a visitor, a path, a referrer and a timestamp and
-- nothing else. Averaging the second group's structural zeroes into the first
-- is what produced the contradiction that discredited the dashboard — an
-- average visit of 443 seconds reported beside an average engaged time of
-- 0.08 seconds, and a funnel showing 2 engaged sessions out of 775.
--
-- Behavioural averages are now computed over the measured subset only, and a
-- per-day average can only be re-weighted correctly across days if the day
-- also records how many sessions it was computed over.

alter table public.web_daily
  add column if not exists measured_sessions integer not null default 0;

alter table public.web_daily
  add column if not exists legacy_sessions integer not null default 0;

alter table public.web_daily
  add column if not exists measured_pageviews integer not null default 0;

comment on column public.web_daily.measured_sessions is
  'Sessions recorded by the first-party tracker. Every avg_* behavioural column is an average over exactly these, so cross-day weighting must use this and not sessions.';

comment on column public.web_daily.legacy_sessions is
  'Sessions reconstructed from the old page_visits log: real traffic, but carrying no device, country, engagement, scroll, form or conversion data.';

comment on column public.web_daily.measured_pageviews is
  'Page views from tracker sessions. The denominator Core Web Vital sample counts should be read against; total pageviews includes the reconstructed archive.';

-- ---- web_page_daily: tell "zero" apart from "never measured" ------------
--
-- avg_seconds_on_page and avg_scroll_pct average over page_exit and
-- scroll_depth events. The reconstructed archive emits neither, so those
-- averages were computed over an empty list, stored as 0, and then weighted
-- by pageviews on read — turning "we never measured this page" into a
-- confident "nobody spent any time here and nobody scrolled", which the
-- health report read as a site-wide content failure.

alter table public.web_page_daily
  add column if not exists time_samples integer not null default 0;

alter table public.web_page_daily
  add column if not exists scroll_samples integer not null default 0;

comment on column public.web_page_daily.time_samples is
  'page_exit events behind avg_seconds_on_page. Zero means not measured, not zero seconds — weight by this, never by pageviews.';

comment on column public.web_page_daily.scroll_samples is
  'scroll_depth events behind avg_scroll_pct. Zero means not measured.';

-- ---- indexes the rebuild leans on ---------------------------------------
--
-- The rebuild sweeps a window of days, and the cutover prune deletes legacy
-- rows by session-id prefix and legacy events by source. Both are sequential
-- scans without these.

create index if not exists web_sessions_site_legacy_idx
  on public.web_sessions (site, first_seen_at desc)
  where session_id like 'legacy:%';

create index if not exists web_events_source_time_idx
  on public.web_events (source, occurred_at desc);

-- ---- one-off cleanup ----------------------------------------------------
--
-- `rollupJourneys` clears the exact (period_start, period_end) pair it is
-- about to write, but the window is a rolling 30 days whose endpoints move
-- every night — so yesterday's pair was never matched and the table has been
-- accumulating roughly 600 rows a day since the feature shipped. The rollup
-- now also prunes anything that ended before the current window; this clears
-- the backlog that built up before it did.

delete from public.web_journeys
where period_end < (current_date - interval '30 days');
