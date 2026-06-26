-- ============================================================
-- 0023_proposals.sql
-- Persisted client proposals. Every proposal the generator
-- downloads is saved here so it shows up under "Past proposals".
-- Shared across the workspace, mirroring invoices (0019).
-- ============================================================

create table if not exists public.proposals (
  id            uuid primary key default gen_random_uuid(),
  client_name   text not null default '',
  project_name  text not null default '',
  proposal_date date not null,
  -- What the client picked (drives deterministic pricing):
  -- { type, tier, platform, paymentGateway, delivery, maintenance, monthlySeo }
  selection     jsonb not null default '{}'::jsonb,
  -- Editable narrative + a snapshot of the computed pricing.
  content       jsonb not null default '{}'::jsonb,
  grand_total   numeric(15, 2) not null default 0 check (grand_total >= 0),
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now()
);

create index if not exists proposals_created_at_idx
  on public.proposals (created_at desc);

alter table public.proposals enable row level security;

create policy "proposals: read all"
  on public.proposals for select to authenticated using (true);

create policy "proposals: write all"
  on public.proposals for insert to authenticated with check (true);

create policy "proposals: update all"
  on public.proposals for update to authenticated using (true) with check (true);

create policy "proposals: delete all"
  on public.proposals for delete to authenticated using (true);

-- Live updates for the "Past proposals" tab (optional). Ignored if the
-- realtime publication is FOR ALL TABLES or already includes this table.
do $$
begin
  alter publication supabase_realtime add table public.proposals;
exception
  when others then null;
end $$;
