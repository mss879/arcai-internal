-- ============================================================
-- 0003_invitations.sql
-- Email invitations. Only the admin can create/see these.
-- The public /join flow validates the token using the service role
-- (server-side), so no anonymous policy is required here.
-- ============================================================

create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  role        text not null default 'member' check (role in ('admin', 'member')),
  token       text not null unique,
  status      text not null default 'pending'
              check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by  uuid references public.profiles (id) on delete set null,
  accepted_at timestamptz,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  created_at  timestamptz not null default now()
);

create index if not exists invitations_email_idx on public.invitations (email);
create index if not exists invitations_status_idx on public.invitations (status);

alter table public.invitations enable row level security;

-- Only admins can view / manage invitations.
create policy "invitations: admin all"
  on public.invitations for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));
