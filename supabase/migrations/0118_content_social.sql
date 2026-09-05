-- ============================================================
-- 0118_content_social.sql
-- ============================================================
-- Content Studio grows a client, an approval and a way out (Track 2).
--
-- Today the Studio writes captions and renders carousels beautifully and then
-- stops at a ZIP file. Three things are missing and each of them is where the
-- work actually leaks:
--
--   1. Nothing knows WHICH CLIENT a piece of content is for, so a month of
--      posts cannot be shown to the person paying for them.
--   2. There is no way for a client to approve a post. Approval happens in
--      WhatsApp, in screenshots, and is lost.
--   3. Nothing publishes. Somebody downloads a ZIP and posts by hand, which
--      is the step that quietly doesn't happen on a busy week.
--
-- Adds: client links + an approval token on generations and calendar posts;
-- three more carousel states; connected social accounts (encrypted tokens);
-- and the publish queue.
--
-- Additive and idempotent. Apply BEFORE pushing the code that reads these.
-- ============================================================

-- 1. Content belongs to a client ---------------------------------------

alter table public.content_generations
  add column if not exists client_id uuid
    references public.clients (id) on delete set null;

alter table public.carousel_posts
  add column if not exists client_id uuid
    references public.clients (id) on delete set null,
  -- The link a client opens to approve or ask for changes. Unguessable, and
  -- the whole credential — same model as /q, /p and /a.
  add column if not exists approval_token uuid not null default gen_random_uuid(),
  add column if not exists client_status text not null default 'not_sent',
  add column if not exists client_feedback text,
  add column if not exists client_decided_at timestamptz;

alter table public.carousel_posts
  drop constraint if exists carousel_posts_client_status_check;
alter table public.carousel_posts
  add constraint carousel_posts_client_status_check
  check (client_status in ('not_sent', 'sent', 'approved', 'changes_requested'));

create unique index if not exists carousel_posts_approval_token_key
  on public.carousel_posts (approval_token);
create index if not exists carousel_posts_client_idx
  on public.carousel_posts (client_id, scheduled_for desc)
  where client_id is not null;
create index if not exists content_generations_client_idx
  on public.content_generations (client_id, created_at desc)
  where client_id is not null;

-- 2. Three more states for a post --------------------------------------
-- Widening REPLACES the constraint, so every value 0046 allowed is repeated
-- here. Leaving one out would reject rows that already exist.
alter table public.carousel_posts
  drop constraint if exists carousel_posts_status_check;
alter table public.carousel_posts
  add constraint carousel_posts_status_check
  check (status in (
    -- 0046
    'planned', 'copywriting', 'rendering', 'ready', 'approved', 'error',
    -- 0118
    'scheduled', 'published', 'publish_failed'
  ));

-- 3. Connected social accounts ------------------------------------------

create table if not exists public.social_accounts (
  id               uuid primary key default gen_random_uuid(),
  platform         text not null check (platform in ('instagram', 'facebook')),
  -- What to call it in the picker, e.g. "@arcai.agency".
  name             text not null,
  -- The IG user id or the FB page id, as Meta knows it.
  external_id      text not null,
  -- Instagram publishing goes through the linked Facebook Page, so an IG
  -- account carries its page id too.
  page_id          text,
  -- AES-GCM, keyed by SOCIAL_TOKEN_KEY. Never the raw token: a long-lived
  -- Page token can post as the business for sixty days.
  access_token_enc text,
  token_expires_at timestamptz,
  -- null = the agency's own account; set = a client's, connected for them.
  client_id        uuid references public.clients (id) on delete cascade,
  active           boolean not null default true,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists social_accounts_platform_external_key
  on public.social_accounts (platform, external_id);

drop trigger if exists social_accounts_set_updated_at on public.social_accounts;
create trigger social_accounts_set_updated_at
  before update on public.social_accounts
  for each row execute function public.set_updated_at();

comment on column public.social_accounts.access_token_enc is
  'AES-GCM ciphertext. Decrypted only in src/lib/social/crypto.ts, only on the server, and never returned to a client component.';

-- 4. The publish queue ---------------------------------------------------

create table if not exists public.social_posts (
  id                uuid primary key default gen_random_uuid(),
  platform          text not null check (platform in ('instagram', 'facebook')),
  account_id        uuid references public.social_accounts (id) on delete set null,
  carousel_post_id  uuid references public.carousel_posts (id) on delete set null,
  generation_id     uuid references public.content_generations (id) on delete set null,
  client_id         uuid references public.clients (id) on delete set null,
  caption           text not null default '',
  -- [{ url }] in order. Public URLs: Meta fetches them itself, which is why
  -- the carousel-slides bucket is public.
  media             jsonb not null default '[]'::jsonb,
  scheduled_for     timestamptz not null default now(),
  status            text not null default 'draft'
                    check (status in (
                      'draft', 'scheduled', 'publishing',
                      'published', 'failed', 'cancelled'
                    )),
  external_post_id  text,
  permalink         text,
  error             text,
  attempts          int not null default 0,
  -- Lease, so two ticks can't publish the same post twice. A duplicate post
  -- on a client's feed is not something you can quietly undo.
  locked_at         timestamptz,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists social_posts_due_idx
  on public.social_posts (scheduled_for)
  where status = 'scheduled';
create index if not exists social_posts_client_idx
  on public.social_posts (client_id, scheduled_for desc)
  where client_id is not null;

drop trigger if exists social_posts_set_updated_at on public.social_posts;
create trigger social_posts_set_updated_at
  before update on public.social_posts
  for each row execute function public.set_updated_at();

-- 5. RLS ------------------------------------------------------------------
-- social_accounts is READ-RESTRICTED to admins: the row carries an encrypted
-- token, and even ciphertext is not something a member needs. Everything
-- server-side uses the service-role client, which bypasses this anyway.

alter table public.social_accounts enable row level security;
alter table public.social_posts    enable row level security;

do $$
begin
  begin
    create policy "social_accounts: admin read" on public.social_accounts
      for select to authenticated using (public.is_admin(auth.uid()));
  exception when duplicate_object then null; end;
  begin
    create policy "social_accounts: admin write" on public.social_accounts
      for all to authenticated
      using (public.is_admin(auth.uid()))
      with check (public.is_admin(auth.uid()));
  exception when duplicate_object then null; end;

  begin
    create policy "social_posts: read all" on public.social_posts
      for select to authenticated using (true);
  exception when duplicate_object then null; end;
  begin
    create policy "social_posts: write all" on public.social_posts
      for all to authenticated using (true) with check (true);
  exception when duplicate_object then null; end;
end $$;

-- 6. Realtime (0021 guard pattern) ---------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['social_posts'] loop
    begin
      execute format(
        'alter publication supabase_realtime add table public.%I', t
      );
    exception
      when duplicate_object then null;
      when others then null;
    end;
  end loop;
end $$;
