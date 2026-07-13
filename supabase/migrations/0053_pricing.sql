-- ============================================================
-- 0053_pricing.sql
-- Editable pricing page.
--
-- A singleton row holds price OVERRIDES: a { key -> amount } JSON
-- map layered over the code-defined default catalog in
-- src/lib/pricing-catalog.ts. The pricing page, the PDF export and
-- the emailed PDF all read the same current prices. Editing a price
-- upserts into `overrides`; the catalog STRUCTURE (groups, packages,
-- feature lists, labels) stays in code, so adding a new package
-- never needs a migration.
-- ============================================================

create table if not exists public.pricing_config (
  id          integer primary key default 1 check (id = 1),
  overrides   jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- Reuse the shared updated_at trigger (defined in earlier migrations,
-- e.g. wa_agent_config).
drop trigger if exists pricing_config_set_updated_at on public.pricing_config;
create trigger pricing_config_set_updated_at
  before update on public.pricing_config
  for each row execute function public.set_updated_at();

-- Seed the single row.
insert into public.pricing_config (id) values (1)
on conflict (id) do nothing;

-- ---- Row level security (same convention as every other table) ----
-- Single-workspace app: any authenticated user has full access.
alter table public.pricing_config enable row level security;

drop policy if exists "pricing_config: read all" on public.pricing_config;
create policy "pricing_config: read all"
  on public.pricing_config for select to authenticated using (true);

drop policy if exists "pricing_config: insert all" on public.pricing_config;
create policy "pricing_config: insert all"
  on public.pricing_config for insert to authenticated with check (true);

drop policy if exists "pricing_config: update all" on public.pricing_config;
create policy "pricing_config: update all"
  on public.pricing_config for update to authenticated using (true) with check (true);

drop policy if exists "pricing_config: delete all" on public.pricing_config;
create policy "pricing_config: delete all"
  on public.pricing_config for delete to authenticated using (true);
