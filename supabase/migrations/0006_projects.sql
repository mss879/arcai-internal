-- ============================================================
-- 0006_projects.sql
-- Project planner + customer payments (with receipts) + commissions.
-- Commissions can ONLY be created/edited by an admin; each member
-- sees the commissions allocated to them on their own profile.
-- ============================================================

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  client_id   uuid references public.clients (id) on delete set null,
  status      text not null default 'planning'
              check (status in ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  budget      numeric(14, 2),
  currency    text not null default 'USD',
  start_date  date,
  due_date    date,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists projects_client_idx on public.projects (client_id);
create index if not exists projects_status_idx on public.projects (status);

alter table public.projects enable row level security;

create policy "projects: read all" on public.projects
  for select to authenticated using (true);
create policy "projects: insert all" on public.projects
  for insert to authenticated with check (true);
create policy "projects: update all" on public.projects
  for update to authenticated using (true) with check (true);
create policy "projects: delete all" on public.projects
  for delete to authenticated using (true);

-- Payments -----------------------------------------------------
create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  amount       numeric(14, 2) not null,
  currency     text not null default 'USD',
  status       text not null default 'paid'
               check (status in ('pending', 'paid', 'overdue')),
  paid_at      date,
  method       text,
  notes        text,
  receipt_url  text,
  receipt_path text,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now()
);

create index if not exists payments_project_idx on public.payments (project_id);

alter table public.payments enable row level security;

create policy "payments: read all" on public.payments
  for select to authenticated using (true);
create policy "payments: insert all" on public.payments
  for insert to authenticated with check (true);
create policy "payments: update all" on public.payments
  for update to authenticated using (true) with check (true);
create policy "payments: delete all" on public.payments
  for delete to authenticated using (true);

-- Commissions --------------------------------------------------
create table if not exists public.commissions (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.projects (id) on delete set null,
  payment_id   uuid references public.payments (id) on delete set null,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  amount       numeric(14, 2) not null,
  percentage   numeric(5, 2),
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'paid')),
  note         text,
  allocated_by uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists commissions_user_idx on public.commissions (user_id);
create index if not exists commissions_project_idx on public.commissions (project_id);

alter table public.commissions enable row level security;

-- Members see only their own commissions; admins see everything.
create policy "commissions: read own or admin" on public.commissions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

-- Only admins may allocate / edit / remove commissions.
create policy "commissions: admin insert" on public.commissions
  for insert to authenticated
  with check (public.is_admin(auth.uid()));
create policy "commissions: admin update" on public.commissions
  for update to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));
create policy "commissions: admin delete" on public.commissions
  for delete to authenticated
  using (public.is_admin(auth.uid()));
