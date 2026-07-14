-- ============================================================
-- 0058_outreach_campaigns.sql
-- Bulk outreach campaigns — "email every cold lead", optionally
-- with NO manual approval step.
--
--   0056 built the per-lead pipeline: pending → drafting → ready,
--   which HARD-STOPS at 'ready' until a human clicks Approve.
--   This migration adds the second mode the owner asked for:
--
--     outreach_campaigns : one row per bulk run — the launch config
--                          (auto_send, daily_cap, filters) and the
--                          pause/cancel switch. Every lead_outreach
--                          row it enqueues points back at it.
--
--   lead_outreach gains:
--     auto_send          : per-row approval mode. TRUE = the tick
--                          sends it once drafted, no human. FALSE =
--                          the 0056 draft-then-approve behaviour.
--                          Defaults FALSE so nothing that already
--                          exists starts sending itself.
--     campaign_id        : the run that enqueued it (null = manual).
--     research_started_at: anchors the research-wait timeout in the
--                          new 'researching' step (NOT updated_at —
--                          the set_updated_at trigger bumps that on
--                          every lease claim; see research.ts).
--
--   The 'researching' status was already reserved in 0056's CHECK
--   but never used, so no constraint change is needed for it.
-- ============================================================

-- ---- Campaigns -----------------------------------------------
create table if not exists public.outreach_campaigns (
  id           uuid primary key default gen_random_uuid(),
  name         text not null default 'Untitled campaign',
  status       text not null default 'running'
               check (status in ('running','paused','done','cancelled')),
  -- TRUE = send without approval. FALSE = drafts land on each lead
  -- for the owner to Approve & send one-by-one (the 0056 flow).
  auto_send    boolean not null default false,
  -- Deliverability guard. arcai.agency also carries the invoice mail,
  -- so a burst here would put transactional email at risk.
  daily_cap    int not null default 40 check (daily_cap between 1 and 500),
  -- Snapshot of the targeting rules used, for the audit trail.
  filters      jsonb not null default '{}'::jsonb,
  -- How many lead_outreach rows this run actually enqueued.
  queued       int not null default 0,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);

drop trigger if exists outreach_campaigns_set_updated_at on public.outreach_campaigns;
create trigger outreach_campaigns_set_updated_at
  before update on public.outreach_campaigns
  for each row execute function public.set_updated_at();

-- ---- lead_outreach: approval mode + campaign link -------------
alter table public.lead_outreach
  add column if not exists auto_send boolean not null default false,
  add column if not exists campaign_id uuid
    references public.outreach_campaigns (id) on delete set null,
  add column if not exists research_started_at timestamptz;

-- 'campaign' joins 'prospecting' | 'manual' as a draft origin.
alter table public.lead_outreach drop constraint if exists lead_outreach_source_check;
alter table public.lead_outreach add constraint lead_outreach_source_check
  check (source in ('prospecting','manual','campaign'));

-- Claim index for the auto-send queue (ready + auto_send, oldest first).
create index if not exists lead_outreach_autosend_idx
  on public.lead_outreach (status, updated_at)
  where auto_send;

-- Powers the "how many went out today?" daily-cap count.
create index if not exists lead_outreach_sent_at_idx
  on public.lead_outreach (sent_at)
  where sent_at is not null;

create index if not exists lead_outreach_campaign_idx
  on public.lead_outreach (campaign_id)
  where campaign_id is not null;

-- ---- RLS + realtime (single-workspace: any authenticated) ----
do $$
declare t text;
begin
  foreach t in array array['outreach_campaigns'] loop
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
