-- ============================================================
-- 0133 — meta_ad_syncs.synced_at: when the numbers were READ, not written
--
-- 0132 was applied before review added this column, so it ships as its own
-- migration rather than as a silent edit to a file the database already ran.
--
-- "Last synced" and the stale-sync rule on /ads mean "when were these numbers
-- read from Meta" — the payload's synced_at. created_at only says when the
-- row was written: re-running an old payload would stamp it "just now" and
-- dress old numbers as fresh. scripts/ads-sync.mjs also refuses a payload
-- older than the newest synced_at already stored, so an old file can never
-- overwrite newer numbers.
--
-- Note for whoever audits access next: the wa_contacts.ad_* columns 0132
-- added are NOT admin-only. They sit under 0048's open member read/update
-- policies, exactly like call_booked_at and lead_id, which /ads also reads.
-- A member could move an ad's credit; they cannot raise their own
-- privileges. Guarding only those four columns would not make the numbers
-- trustworthy while the booking columns stay open, so that belongs to a
-- wa_contacts access pass, not the webhook's hot path.
--
-- Additive and idempotent.
-- ============================================================

alter table public.meta_ad_syncs
  add column if not exists synced_at timestamptz not null default now();

-- The latest sync is now picked by synced_at, so the index follows it.
drop index if exists public.meta_ad_syncs_account_idx;
create index if not exists meta_ad_syncs_account_synced_idx
  on public.meta_ad_syncs (ad_account_id, synced_at desc);

insert into public.schema_migrations (version, note)
values ('0133_meta_ad_syncs_synced_at', 'Meta Ads: meta_ad_syncs.synced_at (read time) + index; the stale-payload guard reads it')
on conflict (version) do nothing;
