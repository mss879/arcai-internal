-- ============================================================
-- 0119_team_intelligence.sql
-- ============================================================
-- Track 3: the team can see its own numbers, and its own queue.
--
-- Four gaps:
--
--   1. Nobody has a target. The dashboard reports what happened; nothing
--      says what was supposed to happen, so "are we having a good month?"
--      is a feeling.
--   2. Seven different things wait for a human decision — assistant drafts,
--      loans, commissions, WhatsApp lessons, outreach drafts, change
--      requests, design picks — on seven different screens. The ones people
--      forget are the ones on the screen they don't open.
--   3. To-Dos can't repeat, can't be templated, can't be labelled, and can't
--      be discussed. So the weekly jobs live in someone's head.
--   4. There is no written-down way of doing anything: what to say, what to
--      charge, what the process is. New people learn by asking, and the
--      WhatsApp agent can only know what fits in one config field.
--
-- Additive and idempotent. Apply BEFORE pushing the code that reads these.
-- ============================================================

-- 1. Targets --------------------------------------------------------------

create table if not exists public.targets (
  id         uuid primary key default gen_random_uuid(),
  -- null = the whole team's target for that period.
  user_id    uuid references public.profiles (id) on delete cascade,
  -- First day of the month it applies to, as a date.
  period     date not null,
  kind       text not null
             check (kind in ('revenue', 'deals_won', 'deliveries', 'leads', 'hours')),
  amount     numeric not null default 0,
  currency   text not null default 'LKR',
  note       text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One target per person per period per kind. The partial pair is needed
-- because NULL never equals NULL in a unique index, so a team-wide target
-- would otherwise be insertable twice.
create unique index if not exists targets_member_key
  on public.targets (user_id, period, kind)
  where user_id is not null;
create unique index if not exists targets_team_key
  on public.targets (period, kind)
  where user_id is null;

drop trigger if exists targets_set_updated_at on public.targets;
create trigger targets_set_updated_at
  before update on public.targets
  for each row execute function public.set_updated_at();

-- 2. To-Dos grow up --------------------------------------------------------

alter table public.todos
  add column if not exists labels text[] not null default '{}',
  add column if not exists estimate_minutes int,
  -- { freq: 'daily'|'weekly'|'monthly', interval: 1, byweekday: [1,3],
  --   until: '2027-01-01' }. Null = it happens once, like every to-do today.
  add column if not exists recurrence jsonb,
  -- The to-do this one was spawned from, so a series can be found.
  add column if not exists recurrence_parent_id uuid
    references public.todos (id) on delete set null,
  add column if not exists next_occurrence_at timestamptz;

create index if not exists todos_labels_idx on public.todos using gin (labels);
create index if not exists todos_recurrence_idx
  on public.todos (next_occurrence_at)
  where recurrence is not null;

create table if not exists public.todo_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  description text,
  -- [{ title, description, priority, estimate_minutes, labels, offset_days }]
  items      jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists todo_templates_set_updated_at on public.todo_templates;
create trigger todo_templates_set_updated_at
  before update on public.todo_templates
  for each row execute function public.set_updated_at();

create table if not exists public.todo_comments (
  id         uuid primary key default gen_random_uuid(),
  todo_id    uuid not null references public.todos (id) on delete cascade,
  author_id  uuid references public.profiles (id) on delete set null,
  body       text not null,
  mentions   uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists todo_comments_todo_idx
  on public.todo_comments (todo_id, created_at);

-- 3. The knowledge base ----------------------------------------------------

create table if not exists public.kb_pages (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null,
  title      text not null,
  body_md    text not null default '',
  category   text not null default 'general',
  tags       text[] not null default '{}',
  -- 'team'  — internal only.
  -- 'agent' — the WhatsApp agent may quote it, the team page hides it.
  -- 'both'  — the usual case.
  visibility text not null default 'team'
             check (visibility in ('team', 'agent', 'both')),
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Generated, so it can never drift from the text it indexes. Title weighted
  -- above the body: somebody searching "refund" wants the refund page, not
  -- every page that mentions one.
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body_md, '')), 'B')
  ) stored
);

create unique index if not exists kb_pages_slug_key on public.kb_pages (slug);
create index if not exists kb_pages_search_idx on public.kb_pages using gin (search);
create index if not exists kb_pages_visibility_idx on public.kb_pages (visibility);

drop trigger if exists kb_pages_set_updated_at on public.kb_pages;
create trigger kb_pages_set_updated_at
  before update on public.kb_pages
  for each row execute function public.set_updated_at();

/**
 * Full-text search over the knowledge base.
 *
 * websearch_to_tsquery so a person can type "refund policy" or "price -vat"
 * and get what they meant; plainto_ would treat the operators as words.
 */
create or replace function public.kb_search(q text, lim int default 10)
returns table (
  id uuid,
  slug text,
  title text,
  category text,
  visibility text,
  snippet text,
  rank real
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    p.id,
    p.slug,
    p.title,
    p.category,
    p.visibility,
    ts_headline('english', p.body_md, websearch_to_tsquery('english', q),
                'MaxWords=30, MinWords=10, ShortWord=3, MaxFragments=1'),
    ts_rank(p.search, websearch_to_tsquery('english', q))
  from public.kb_pages p
  where p.search @@ websearch_to_tsquery('english', q)
  order by ts_rank(p.search, websearch_to_tsquery('english', q)) desc
  limit greatest(1, least(50, lim));
$$;

-- 4. One number for everything waiting on a person -------------------------

/**
 * How many things are waiting for a decision, across every queue.
 *
 * Deliberately one function rather than seven counts in the client: the
 * topbar badge must be one round-trip, and the definition of "waiting" for
 * each queue belongs next to the others so they can be kept honest.
 *
 * security invoker — a member sees the same count an admin does, which is
 * correct: the point is that SOMETHING needs doing, and the page itself
 * decides what they may act on.
 */
create or replace function public.approvals_count()
returns int
language sql
stable
security invoker
set search_path = public
as $$
  select
    (select count(*) from public.assistant_approvals where status = 'pending')
  + (select count(*) from public.member_loans where approval = 'pending')
  + (select count(*) from public.commissions where status = 'pending')
  + (select count(*) from public.wa_lessons where status = 'pending')
  + (select count(*) from public.lead_outreach where status = 'ready')
  + (select count(*) from public.project_change_requests
       where status in ('new', 'quoted'))
  + (select count(*) from public.carousel_posts
       where status = 'ready' and chosen_option_id is null);
$$;

grant execute on function public.kb_search(text, int) to authenticated;
grant execute on function public.approvals_count() to authenticated;

-- 5. RLS -------------------------------------------------------------------

alter table public.targets        enable row level security;
alter table public.todo_templates enable row level security;
alter table public.todo_comments  enable row level security;
alter table public.kb_pages       enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['targets', 'todo_templates', 'todo_comments', 'kb_pages'] loop
    begin
      execute format(
        'create policy "%s: read all" on public.%I for select to authenticated using (true)',
        t, t
      );
    exception when duplicate_object then null; end;
    begin
      execute format(
        'create policy "%s: write all" on public.%I for all to authenticated using (true) with check (true)',
        t, t
      );
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- 6. Realtime (0021 guard pattern) ------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['todo_comments'] loop
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
