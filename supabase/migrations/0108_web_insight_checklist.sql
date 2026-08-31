-- ============================================================
-- 0108_web_insight_checklist.sql
--
-- The improvement checklist that comes out of an AI Insights scan.
--
-- A finding tells you what is wrong. A checklist is the thing you
-- actually work through, so it needs to be a ROW, not a string in a
-- jsonb blob: you tick items off, and that tick has to survive the
-- next scan.
--
-- Which is the whole design point. Re-scanning does NOT wipe the
-- checklist. Open items from a previous scan stay open — if the same
-- leak is still there next month it should still be on the list, and
-- if you fixed something in week one it should stay ticked rather
-- than reappearing as a fresh suggestion. `insight_id` records which
-- scan first raised an item, not which scan owns it.
-- ============================================================

create table if not exists public.web_insight_tasks (
  id            uuid primary key default gen_random_uuid(),
  site          text not null default 'arcai.agency',
  -- The scan that first raised this. Null once that scan is deleted —
  -- the task outlives it, because the work still needs doing.
  insight_id    uuid references public.web_insights (id) on delete set null,

  title         text not null default '',
  detail        text not null default '',
  area          text not null default 'general',

  priority      text not null default 'medium'
                check (priority in ('critical', 'high', 'medium', 'low')),
  impact        text not null default 'medium'
                check (impact in ('high', 'medium', 'low')),
  effort        text not null default 'medium'
                check (effort in ('high', 'medium', 'low')),

  -- The number that motivates it ("/pricing bounce 71% vs 44% site-wide")
  -- and what good would look like ("under 55%"). Kept as text because the
  -- metric differs per task and a shared numeric column would be a lie.
  metric        text,
  target        text,

  -- A stable identity for the SAME underlying problem across scans, so a
  -- re-scan can recognise "the pricing page still leaks" rather than adding
  -- a second copy of it. Derived from area + a slug of the title.
  fingerprint   text not null default '',

  done          boolean not null default false,
  done_at       timestamptz,
  done_by       uuid references public.profiles (id) on delete set null,
  dismissed     boolean not null default false,

  sort_order    integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- How many scans in a row have raised this. A 4 means it has been
  -- ignored for four scans, which is itself worth knowing.
  seen_count    integer not null default 1,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One row per distinct problem per site. The upsert on re-scan targets this.
create unique index if not exists web_insight_tasks_fingerprint_idx
  on public.web_insight_tasks (site, fingerprint);
create index if not exists web_insight_tasks_open_idx
  on public.web_insight_tasks (site, done, priority, sort_order);

create or replace function public.touch_web_insight_task()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists web_insight_tasks_touch on public.web_insight_tasks;
create trigger web_insight_tasks_touch
  before update on public.web_insight_tasks
  for each row execute function public.touch_web_insight_task();

-- ---- RLS ----------------------------------------------------
alter table public.web_insight_tasks enable row level security;

do $$
begin
  begin
    create policy "web_insight_tasks: read all" on public.web_insight_tasks
      for select to authenticated using (true);
  exception when duplicate_object then null; end;
  begin
    create policy "web_insight_tasks: insert all" on public.web_insight_tasks
      for insert to authenticated with check (true);
  exception when duplicate_object then null; end;
  begin
    create policy "web_insight_tasks: update all" on public.web_insight_tasks
      for update to authenticated using (true) with check (true);
  exception when duplicate_object then null; end;
  begin
    create policy "web_insight_tasks: delete all" on public.web_insight_tasks
      for delete to authenticated using (true);
  exception when duplicate_object then null; end;
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table public.web_insight_tasks;
  exception when others then null; end;
end $$;
