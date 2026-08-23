-- ============================================================
-- 0092_projects_planning.sql
--
-- PROJECTS, THEME 3 (PLAN) — the layer that was missing.
--
-- A project knew its client, its price and its delivery stage.
-- It did not know who was building it, what was left to do,
-- when any of that was due, or what it cost in people's time.
-- This migration adds that layer:
--
--   1. PROJECT_TEMPLATES (+ items) — "E-commerce Website"
--      stops being a label and becomes a plan: the tasks, the
--      asset checklist, the milestones and the launch checks
--      that every job of that type needs, seeded in one click.
--      The asset checklist already worked this way in code
--      (delivery-checklists.ts); this makes the whole plan
--      editable by the team instead of hard-coded.
--
--   2. PROJECT_MILESTONES — named phases between the six
--      coarse delivery stages, each with a date, an owner and
--      a done state, and each optionally shown to the client.
--      `kind` separates client-facing milestones from the
--      internal launch checklist that gates "delivered".
--
--   3. PROJECT_MEMBERS — who is actually on the job. Until now
--      the only hint was who had been allocated a commission,
--      which is a payment record, not a staffing one.
--
--   4. TIME_ENTRIES (+ profiles.hourly_cost) — "log 2h" on a
--      task, nothing heavier. With a cost rate it turns the
--      margin figure from an estimate into the truth.
--
--   5. BLOCKED — "waiting on the client" as a real state with
--      a reason and a since-date, so the chaser can stand down
--      and the days lost can be quoted back later.
--
--   6. WEBSITE_PROJECTS ↔ PROJECTS — the second, parallel
--      build tracker (0026) can finally point at the project
--      it belongs to instead of duplicating it.
--
--   7. TODOS.DEPENDS_ON_ID — "can't start until content
--      lands", which is what makes a launch date honest.
--
--   8. AFTERCARE — a delivered project can keep generating its
--      monthly maintenance work instead of going silent.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- 1. Templates ------------------------------------------------
create table if not exists public.project_templates (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  -- Matching a project's service_type offers this template on creation.
  service_type text,
  description  text,
  -- Pre-fills the new project's money and dates. NULL = leave blank.
  default_value    numeric(14, 2),
  default_currency text not null default 'LKR',
  default_days     integer,
  is_active    boolean not null default true,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists project_templates_service_idx
  on public.project_templates (service_type)
  where is_active;

create table if not exists public.project_template_items (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.project_templates (id) on delete cascade,
  -- One items table for the whole plan: what gets seeded where.
  --   task         → a to-do on the project
  --   asset        → a client asset request on the portal checklist
  --   milestone    → a client-visible phase
  --   launch_check → an internal gate before the project may be delivered
  kind        text not null default 'task'
              check (kind in ('task', 'asset', 'milestone', 'launch_check')),
  title       text not null,
  detail      text,
  category    text,
  position    integer not null default 0,
  -- Days after the project start date. NULL = no date.
  offset_days integer,
  required    boolean not null default true,
  -- For tasks: which project role it lands on, matched against
  -- project_members.role. NULL = unassigned.
  role        text,
  priority    text not null default 'medium'
              check (priority in ('low', 'medium', 'high', 'urgent')),
  created_at  timestamptz not null default now()
);

create index if not exists project_template_items_template_idx
  on public.project_template_items (template_id, kind, position);

-- 2. Milestones -----------------------------------------------
create table if not exists public.project_milestones (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  title         text not null,
  detail        text,
  kind          text not null default 'milestone'
                check (kind in ('milestone', 'launch_check')),
  status        text not null default 'pending'
                check (status in ('pending', 'done', 'blocked')),
  due_date      date,
  position      integer not null default 0,
  -- Milestones are shown on the client portal; launch checks never are.
  client_visible boolean not null default true,
  owner_id      uuid references public.profiles (id) on delete set null,
  completed_at  timestamptz,
  completed_by  uuid references public.profiles (id) on delete set null,
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists project_milestones_project_idx
  on public.project_milestones (project_id, kind, position);

create index if not exists project_milestones_due_idx
  on public.project_milestones (due_date)
  where status = 'pending';

comment on column public.project_milestones.kind is
  '''milestone'' = a phase of the work, shown to the client when client_visible. ''launch_check'' = an internal gate (SSL, analytics, backups, handover) that must pass before the project may be marked delivered.';

-- 3. Who is on the project ------------------------------------
create table if not exists public.project_members (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  -- Free text so the agency can name its own roles; the seeder matches
  -- template items against it.
  role       text,
  -- Exactly one owner per project is expected, but not enforced in SQL:
  -- a handover briefly has two, and blocking that is worse than allowing it.
  is_owner   boolean not null default false,
  added_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create index if not exists project_members_user_idx
  on public.project_members (user_id);

-- 4. Time ------------------------------------------------------
alter table public.profiles
  add column if not exists hourly_cost numeric(12, 2);

comment on column public.profiles.hourly_cost is
  'What an hour of this member''s time costs the agency, in LKR. Used only to turn logged time into a cost figure inside project margin — never shown to the member and never used for payroll.';

create table if not exists public.time_entries (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  -- Optional: the task the time went into.
  todo_id    uuid references public.todos (id) on delete set null,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  minutes    integer not null check (minutes > 0 and minutes <= 24 * 60),
  note       text,
  worked_on  date not null default current_date,
  created_at timestamptz not null default now()
);

create index if not exists time_entries_project_idx
  on public.time_entries (project_id, worked_on desc);
create index if not exists time_entries_user_idx
  on public.time_entries (user_id, worked_on desc);

-- 5 + 8. Project columns --------------------------------------
alter table public.projects
  add column if not exists blocked_reason text,
  add column if not exists blocked_since timestamptz,
  add column if not exists template_id uuid
    references public.project_templates (id) on delete set null,
  add column if not exists aftercare_enabled boolean not null default false,
  add column if not exists aftercare_last_run_on date;

comment on column public.projects.blocked_reason is
  'Why the project cannot move — almost always something owed by the client. Set together with blocked_since. While set, the delivery chaser and the stalled-project alert stand down (the project is not stalled, it is waiting), the board shows it as blocked, and the portal tells the client politely what we are waiting for.';
comment on column public.projects.aftercare_enabled is
  'TRUE = a delivered project keeps generating its monthly maintenance to-dos (backups, updates, uptime) instead of going silent. Guarded against repeats by aftercare_last_run_on.';

-- 6. The other build tracker ----------------------------------
alter table public.website_projects
  add column if not exists project_id uuid
    references public.projects (id) on delete set null;

comment on column public.website_projects.project_id is
  'The project this website build belongs to (0026 predates Projects having a delivery pipeline). Linked rows show their build progress on the project page instead of only on /website-progress, so the same job is not tracked in two disconnected places.';

create index if not exists website_projects_project_idx
  on public.website_projects (project_id);

-- 7. Task dependencies ----------------------------------------
alter table public.todos
  add column if not exists depends_on_id uuid
    references public.todos (id) on delete set null;

comment on column public.todos.depends_on_id is
  'The task that must be done first. A task whose dependency is unfinished shows as blocked and is skipped by "what should I do next". Self-reference is prevented in the write path, not in SQL — a cycle check belongs where the friendly error can be shown.';

create index if not exists todos_depends_on_idx
  on public.todos (depends_on_id)
  where depends_on_id is not null;

-- ---- RLS ----------------------------------------------------
-- Same access model as projects/payments (0006): one workspace, every
-- signed-in member works the same board. Time entries are the exception:
-- a member may only write their OWN, so nobody can log hours against
-- someone else's name.
do $$
declare
  t text;
begin
  foreach t in array array[
    'project_templates',
    'project_template_items',
    'project_milestones',
    'project_members'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s: read all" on public.%I', t, t);
    execute format('create policy "%s: read all" on public.%I for select to authenticated using (true)', t, t);
    execute format('drop policy if exists "%s: insert all" on public.%I', t, t);
    execute format('create policy "%s: insert all" on public.%I for insert to authenticated with check (true)', t, t);
    execute format('drop policy if exists "%s: update all" on public.%I', t, t);
    execute format('create policy "%s: update all" on public.%I for update to authenticated using (true) with check (true)', t, t);
    execute format('drop policy if exists "%s: delete all" on public.%I', t, t);
    execute format('create policy "%s: delete all" on public.%I for delete to authenticated using (true)', t, t);
  end loop;
end $$;

alter table public.time_entries enable row level security;

drop policy if exists "time_entries: read all" on public.time_entries;
create policy "time_entries: read all" on public.time_entries
  for select to authenticated using (true);

drop policy if exists "time_entries: insert own" on public.time_entries;
create policy "time_entries: insert own" on public.time_entries
  for insert to authenticated
  with check (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "time_entries: update own" on public.time_entries;
create policy "time_entries: update own" on public.time_entries
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()))
  with check (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "time_entries: delete own" on public.time_entries;
create policy "time_entries: delete own" on public.time_entries
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

-- ---- updated_at ---------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['project_templates', 'project_milestones'] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      t, t);
  end loop;
end $$;

-- ---- Realtime (0021 guard pattern) --------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'project_milestones',
    'project_members',
    'time_entries'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null; -- already published
      when others then null;           -- e.g. publication is FOR ALL TABLES
    end;
  end loop;
end $$;

-- ---- Member-change audit (0081 pattern) ---------------------
do $$
declare
  t text;
begin
  if to_regclass('public.member_changes') is null then return; end if;
  foreach t in array array[
    'project_milestones',
    'project_members',
    'time_entries'
  ] loop
    execute format('drop trigger if exists member_changes_audit on public.%I', t);
    execute format(
      'create trigger member_changes_audit after insert or update or delete on public.%I for each row execute function public.log_member_change()',
      t);
  end loop;
end $$;
