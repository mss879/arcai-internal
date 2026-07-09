-- ============================================================
-- 0046_carousels.sql
-- Carousel Planner — the Content Studio's automated carousel
-- system. The user types topics into a content calendar; the
-- automation tick then generates TWO complete carousel design
-- options per post (5–8 Instagram 4:5 slides each, on-brand via
-- the content_references library) starting 3 days before the
-- scheduled date, so designs are waiting when the user returns.
--
--   carousel_posts   : one row per calendar entry. A state
--                      machine the tick advances (like research):
--                        planned → copywriting → rendering
--                                → ready → approved   (or error)
--   carousel_options : the 2 design options per post. Slide copy
--                      + rendered images live in `slides` jsonb:
--                      [{ index, headline, body, image_url,
--                         image_path }]
--
-- One storage bucket: carousel-slides (public, like the other
-- content buckets).
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ---- Calendar posts ------------------------------------------
create table if not exists public.carousel_posts (
  id               uuid primary key default gen_random_uuid(),
  topic            text not null,
  notes            text not null default '',
  scheduled_for    date not null,
  status           text not null default 'planned'
                   check (status in (
                     'planned', 'copywriting', 'rendering',
                     'ready', 'approved', 'error'
                   )),
  -- Post caption + hashtags, written once at the copywriting step
  -- and shared by both design options.
  caption          text not null default '',
  hashtags         text[] not null default '{}',
  -- Set when the user picks a design in the review screen.
  chosen_option_id uuid,
  -- Working state: render cursor + counters (jsonb, replaced per step).
  analysis         jsonb not null default '{}'::jsonb,
  error            text,
  locked_at        timestamptz,
  created_by       uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists carousel_posts_status_idx
  on public.carousel_posts (status, updated_at);
create index if not exists carousel_posts_scheduled_idx
  on public.carousel_posts (scheduled_for);

create or replace function public.set_carousel_posts_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists carousel_posts_set_updated_at on public.carousel_posts;
create trigger carousel_posts_set_updated_at
  before update on public.carousel_posts
  for each row execute function public.set_carousel_posts_updated_at();

-- ---- Design options (2 per post) -----------------------------
create table if not exists public.carousel_options (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.carousel_posts (id) on delete cascade,
  variant     int  not null check (variant in (1, 2)),
  -- One-line design direction ("Bold typographic, navy + electric
  -- blue, oversized numbers") shown in the review UI and fed to
  -- the image prompts.
  concept     text not null default '',
  -- Ordered slides. Copy fields are filled at the copywriting
  -- step; image fields as each slide renders:
  --   [{ index, headline, body, image_url, image_path }]
  slides      jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  unique (post_id, variant)
);

create index if not exists carousel_options_post_idx
  on public.carousel_options (post_id);

-- `chosen_option_id` points at an option; add the FK after both
-- tables exist (no cascade — clearing the choice shouldn't delete
-- the post).
do $$
begin
  alter table public.carousel_posts
    add constraint carousel_posts_chosen_option_fkey
    foreign key (chosen_option_id)
    references public.carousel_options (id) on delete set null;
exception when duplicate_object then null;
end $$;

-- ---- RLS (single-workspace: any authenticated member) -------
alter table public.carousel_posts   enable row level security;
alter table public.carousel_options enable row level security;

do $$ begin
  create policy "carousel_posts: read all"
    on public.carousel_posts for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "carousel_posts: write all"
    on public.carousel_posts for insert to authenticated with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "carousel_posts: update all"
    on public.carousel_posts for update to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "carousel_posts: delete all"
    on public.carousel_posts for delete to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "carousel_options: read all"
    on public.carousel_options for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "carousel_options: write all"
    on public.carousel_options for insert to authenticated with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "carousel_options: update all"
    on public.carousel_options for update to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "carousel_options: delete all"
    on public.carousel_options for delete to authenticated using (true);
exception when duplicate_object then null; end $$;

-- ---- Storage bucket ------------------------------------------
insert into storage.buckets (id, name, public)
values ('carousel-slides', 'carousel-slides', true)
on conflict (id) do nothing;

do $$ begin
  create policy "storage: public read carousel-slides"
    on storage.objects for select
    using (bucket_id = 'carousel-slides');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "storage: auth insert carousel-slides"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'carousel-slides');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "storage: auth update carousel-slides"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'carousel-slides')
    with check (bucket_id = 'carousel-slides');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "storage: auth delete carousel-slides"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'carousel-slides');
exception when duplicate_object then null; end $$;

-- ---- Live updates (optional; ignored if FOR ALL TABLES) -----
do $$
begin
  alter publication supabase_realtime add table public.carousel_posts;
exception when others then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.carousel_options;
exception when others then null;
end $$;
