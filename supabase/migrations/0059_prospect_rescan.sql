-- ============================================================
-- 0059_prospect_rescan.sql
-- Let a re-scan actually find businesses again.
--
--   0044 made prospect_candidates.place_id GLOBALLY unique, so a business
--   seen by ANY earlier scan was silently dropped from every later scan
--   (runSearch upserts with ignoreDuplicates). Re-scanning an area therefore
--   returned almost nothing — and because `found` counts only rows carrying
--   the CURRENT scan_id, the dropped ones were invisible: Places could return
--   a full 40 and the UI would report "Businesses found: 11". It read like
--   Google running out of businesses. It wasn't.
--
--   Cross-scan dedupe was the wrong layer for this. Not re-pitching someone
--   is a CRM concern, and runSearch already enforces it properly: every
--   candidate is matched against existing leads by website domain and by
--   company name, and marked 'duplicate' when it hits. That check is what
--   protects the prospect; the unique index only hid businesses from view.
--
--   Uniqueness moves to (scan_id, place_id): still no dupes WITHIN a scan,
--   but each scan gets a clean look at the area.
--
--   Safe on existing data: place_id was globally unique, so every existing
--   row trivially satisfies the narrower (scan_id, place_id) constraint.
-- ============================================================

-- Drop the global constraint. Postgres names it <table>_<column>_key; the
-- DO block covers installs where it materialised as a plain unique index.
alter table public.prospect_candidates
  drop constraint if exists prospect_candidates_place_id_key;

do $$
begin
  if exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename  = 'prospect_candidates'
      and indexname  = 'prospect_candidates_place_id_key'
  ) then
    execute 'drop index public.prospect_candidates_place_id_key';
  end if;
end $$;

-- Per-scan uniqueness — this is what runSearch's upsert now conflicts on.
create unique index if not exists prospect_candidates_scan_place_idx
  on public.prospect_candidates (scan_id, place_id);

-- "Has any earlier scan already seen this business?" — powers the honest
-- funnel count (seenBefore) without a full table scan per search.
create index if not exists prospect_candidates_place_idx
  on public.prospect_candidates (place_id);
