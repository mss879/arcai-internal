-- ============================================================
-- 0002_profiles.sql
-- Workspace members. One row per auth user.
-- The FIRST account ever created becomes the workspace admin (owner).
-- ============================================================

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null default '',
  username    text not null unique,
  email       text not null,
  role        text not null default 'member' check (role in ('admin', 'member')),
  title       text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Returns true when the given user is a workspace admin.
-- SECURITY DEFINER so it bypasses RLS and never recurses into profile policies.
create or replace function public.is_admin(uid uuid)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  return exists (
    select 1 from public.profiles where id = uid and role = 'admin'
  );
end;
$$;

-- Auto-create a profile whenever an auth user is created.
-- Reads full_name / username / role / title from user metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_count int;
  resolved_role  text;
begin
  select count(*) into existing_count from public.profiles;
  resolved_role := coalesce(new.raw_user_meta_data ->> 'role', 'member');

  -- The very first user is always the owner/admin.
  if existing_count = 0 then
    resolved_role := 'admin';
  end if;

  insert into public.profiles (id, full_name, username, email, role, title, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    new.email,
    resolved_role,
    new.raw_user_meta_data ->> 'title',
    new.raw_user_meta_data ->> 'avatar_url'
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Policies -----------------------------------------------------
-- Everyone in the workspace can see everyone (needed for @mentions & assignment).
create policy "profiles: read all"
  on public.profiles for select
  to authenticated
  using (true);

-- A user can edit their own profile; an admin can edit anyone.
create policy "profiles: update own or admin"
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_admin(auth.uid()))
  with check (id = auth.uid() or public.is_admin(auth.uid()));
