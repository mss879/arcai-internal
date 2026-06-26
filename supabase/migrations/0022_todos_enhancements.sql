-- ============================================================
-- 0022_todos_enhancements.sql
-- Makes the to-do list more functional:
--   * link a task to a project (todos.project_id)
--   * manual ordering for the Kanban board (todos.position)
--   * checklist / subtasks (todo_subtasks)
-- Idempotent: safe to re-run.
-- ============================================================

-- --- Link a task to a project --------------------------------
alter table public.todos
  add column if not exists project_id uuid
  references public.projects (id) on delete set null;

create index if not exists todos_project_id_idx on public.todos (project_id);

-- --- Manual ordering (used by the board view) ----------------
alter table public.todos
  add column if not exists position integer not null default 0;

create index if not exists todos_position_idx on public.todos (status, position);

-- --- Subtasks / checklist ------------------------------------
create table if not exists public.todo_subtasks (
  id         uuid primary key default gen_random_uuid(),
  todo_id    uuid not null references public.todos (id) on delete cascade,
  title      text not null,
  is_done    boolean not null default false,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists todo_subtasks_todo_idx
  on public.todo_subtasks (todo_id, position);

alter table public.todo_subtasks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'todo_subtasks'
      and policyname = 'todo_subtasks: read all'
  ) then
    create policy "todo_subtasks: read all" on public.todo_subtasks
      for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'todo_subtasks'
      and policyname = 'todo_subtasks: insert all'
  ) then
    create policy "todo_subtasks: insert all" on public.todo_subtasks
      for insert to authenticated with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'todo_subtasks'
      and policyname = 'todo_subtasks: update all'
  ) then
    create policy "todo_subtasks: update all" on public.todo_subtasks
      for update to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'todo_subtasks'
      and policyname = 'todo_subtasks: delete all'
  ) then
    create policy "todo_subtasks: delete all" on public.todo_subtasks
      for delete to authenticated using (true);
  end if;
end $$;

-- --- Realtime ------------------------------------------------
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.todo_subtasks';
  exception
    when duplicate_object then null; -- already published
    when others then null;           -- e.g. publication is FOR ALL TABLES
  end;
end $$;
