-- 0109 — Web Analytics: separate measured traffic from reconstructed history
--
-- `web_daily` mixes two populations that look identical in a count and are
-- nothing alike in a behavioural average:
--
--   * sessions the first-party tracker instrumented, which know their device,
--     country, engaged time, scroll depth, form interactions and conversions;
--   * sessions reconstructed from the site's old `page_visits` log, which
--     recorded a visitor, a path, a referrer and a timestamp — and nothing
--     else, because nothing else was ever captured.
--
-- Averaging the second group's structural zeroes into the first produced the
-- contradiction that made the whole dashboard untrustworthy: an average visit
-- duration of 443 seconds reported next to an average engaged time of 0.08
-- seconds, and a funnel showing 2 engaged sessions out of 775.
--
-- The rollup now computes every behavioural average over the measured subset
-- only. That average can only be re-weighted correctly across days if each day
-- also stores how many sessions it was computed over — which is what these two
-- columns are for. Both default to 0; the next rebuild fills them in.

alter table public.web_daily
  add column if not exists measured_sessions integer not null default 0;

alter table public.web_daily
  add column if not exists legacy_sessions integer not null default 0;

comment on column public.web_daily.measured_sessions is
  'Sessions recorded by the first-party tracker. Every avg_* behavioural column is an average over exactly these, so cross-day weighting must use this and not sessions.';

comment on column public.web_daily.legacy_sessions is
  'Sessions reconstructed from the old page_visits log: real traffic, but carrying no device, country, engagement, scroll, form or conversion data.';

-- The same distinction for page views. Core Web Vitals fire once per full
-- document load and only from the tracker, so "4 samples" read against 1,035
-- pageviews looks like a broken pipeline when it is really 4 out of the dozen
-- tracked loads that existed. Judged against the right denominator it is
-- simply a small sample, which is a different conversation.
alter table public.web_daily
  add column if not exists measured_pageviews integer not null default 0;

comment on column public.web_daily.measured_pageviews is
  'Page views from tracker sessions. The denominator Core Web Vital sample counts should be read against; total pageviews includes the reconstructed archive.';

-- ---- per-page: tell "zero" apart from "never measured" ------------------
--
-- avg_seconds_on_page and avg_scroll_pct are averages over page_exit and
-- scroll_depth events. The reconstructed archive emits neither, so those
-- averages were computed over an empty list, stored as 0, and then weighted
-- by pageviews on read — turning "we did not measure this page" into a
-- confident "nobody spent any time on this page and nobody scrolled", which
-- is what the health report read as a site-wide content failure.
alter table public.web_page_daily
  add column if not exists time_samples integer not null default 0;

alter table public.web_page_daily
  add column if not exists scroll_samples integer not null default 0;

comment on column public.web_page_daily.time_samples is
  'page_exit events behind avg_seconds_on_page. Zero means not measured, not zero seconds — weight by this, never by pageviews.';

comment on column public.web_page_daily.scroll_samples is
  'scroll_depth events behind avg_scroll_pct. Zero means not measured.';

-- The rebuild sweeps a window of days and the legacy prune deletes by
-- session-id prefix; both are seq scans without these.
create index if not exists web_sessions_site_legacy_idx
  on public.web_sessions (site, first_seen_at desc)
  where session_id like 'legacy:%';

create index if not exists web_events_source_time_idx
  on public.web_events (source, occurred_at desc);
