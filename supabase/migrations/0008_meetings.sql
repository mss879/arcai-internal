-- ============================================================
-- 0008_meetings.sql
-- Public meeting / booking links. A member generates a shareable
-- link; clients open it and book a slot (default 9am–9pm, up to
-- 2 weeks ahead). The public booking page reads/writes via the
-- service role server-side, so only authenticated policies live here.
-- ============================================================

create table if not exists public.meeting_links (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  title            text not null,
  description      text,
  duration_minutes int  not null default 60,
  start_hour       int  not null default 9   check (start_hour between 0 and 23),
  end_hour         int  not null default 21  check (end_hour between 1 and 24),
  advance_days     int  not null default 14,
  location         text,
  active           boolean not null default true,
  created_by       uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now()
);

create index if not exists meeting_links_slug_idx on public.meeting_links (slug);

alter table public.meeting_links enable row level security;

create policy "meeting_links: read all" on public.meeting_links
  for select to authenticated using (true);
create policy "meeting_links: insert all" on public.meeting_links
  for insert to authenticated with check (true);
create policy "meeting_links: update all" on public.meeting_links
  for update to authenticated using (true) with check (true);
create policy "meeting_links: delete all" on public.meeting_links
  for delete to authenticated using (true);

-- Bookings -----------------------------------------------------
create table if not exists public.meeting_bookings (
  id              uuid primary key default gen_random_uuid(),
  meeting_link_id uuid not null references public.meeting_links (id) on delete cascade,
  client_name     text not null,
  client_email    text,
  client_phone    text,
  notes           text,
  booking_date    date not null,
  start_time      text not null,
  end_time        text not null,
  status          text not null default 'confirmed'
                  check (status in ('confirmed', 'cancelled')),
  created_at      timestamptz not null default now(),
  unique (meeting_link_id, booking_date, start_time)
);

create index if not exists meeting_bookings_link_idx on public.meeting_bookings (meeting_link_id);
create index if not exists meeting_bookings_date_idx on public.meeting_bookings (booking_date);

alter table public.meeting_bookings enable row level security;

create policy "meeting_bookings: read all" on public.meeting_bookings
  for select to authenticated using (true);
create policy "meeting_bookings: insert all" on public.meeting_bookings
  for insert to authenticated with check (true);
create policy "meeting_bookings: update all" on public.meeting_bookings
  for update to authenticated using (true) with check (true);
create policy "meeting_bookings: delete all" on public.meeting_bookings
  for delete to authenticated using (true);
