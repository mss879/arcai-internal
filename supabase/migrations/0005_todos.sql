-- ============================================================
-- 0005_todos.sql
-- Shared to-do list with priority, assignment, due dates (calendar)
-- and @mentions of other workspace members.
-- ============================================================

create table if not exists public.todos (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  priority     text not null default 'medium'
               check (priority in ('low', 'medium', 'high', 'urgent')),
  status       text not null default 'todo'
               check (status in ('todo', 'in_progress', 'done')),
  due_date     timestamptz,
  assigned_to  uuid references public.profiles (id) on delete set null,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists todos_due_date_idx on public.todos (due_date);
create index if not exists todos_assigned_to_idx on public.todos (assigned_to);
create index if not exists todos_status_idx on public.todos (status);

alter table public.todos enable row level security;

create policy "todos: read all" on public.todos
  for select to authenticated using (true);
create policy "todos: insert all" on public.todos
  for insert to authenticated with check (true);
create policy "todos: update all" on public.todos
  for update to authenticated using (true) with check (true);
create policy "todos: delete all" on public.todos
  for delete to authenticated using (true);

-- @mentions ----------------------------------------------------
create table if not exists public.todo_mentions (
  id         uuid primary key default gen_random_uuid(),
  todo_id    uuid not null references public.todos (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (todo_id, user_id)
);

create index if not exists todo_mentions_user_idx on public.todo_mentions (user_id);

alter table public.todo_mentions enable row level security;

create policy "todo_mentions: read all" on public.todo_mentions
  for select to authenticated using (true);
create policy "todo_mentions: insert all" on public.todo_mentions
  for insert to authenticated with check (true);
create policy "todo_mentions: delete all" on public.todo_mentions
  for delete to authenticated using (true);
