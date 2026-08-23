-- ============================================================
-- 0094_client_experience.sql
--
-- PROJECTS, THEME 4 (CX) — the portal stops being a file drop
-- and becomes the thing a client is happy to be sent.
--
--   1. PORTAL PASSCODE — the share link is unguessable, but
--      "unguessable" stops meaning much once a client forwards
--      it. A project can now carry a passcode: the link asks
--      for it, and only then shows anything. Optional and off
--      by default, so every link already in the wild keeps
--      working exactly as it does today. An optional expiry
--      and a revoke stamp sit alongside it.
--
--      Brute force is the only real attack on a 4-digit PIN,
--      so failed attempts are counted and the portal locks
--      itself for a while — the counter, not the length of the
--      code, is what makes it safe.
--
--   2. REVIEWS — a completed project can ask its client for a
--      review over SMS. The client lands on a page of its own
--      (not the portal), leaves a rating and a few words, and
--      says whether we may publish it.
--
--   3. APPROVALS — "approve this design", signed with a typed
--      name and a timestamp, so "I never approved that" stops
--      being a conversation.
--
--   4. CHANGE REQUESTS — the client asks for something extra
--      on the portal; it arrives as a request the team can
--      price, and accepting it writes the billable expense.
--      Scope creep was previously absorbed in silence.
--
--   5. COMMENTS — feedback attached to the milestone it is
--      about, from either side.
--
--   6. PULSES — a one-tap "how's it going" at each milestone.
--      An unhappy tap raises a churn alert while there is
--      still time to do something about it.
--
--   7. PORTAL LANGUAGE — the WhatsApp agent has detected and
--      switched language per contact since 0055; the portal
--      has been English-only. Same language codes.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- 1 + 7. Portal access and language ---------------------------
alter table public.projects
  add column if not exists portal_passcode text,
  add column if not exists portal_passcode_set_at timestamptz,
  add column if not exists portal_expires_at timestamptz,
  add column if not exists portal_revoked_at timestamptz,
  add column if not exists portal_last_sent_at timestamptz,
  add column if not exists portal_failed_attempts integer not null default 0,
  add column if not exists portal_locked_until timestamptz,
  add column if not exists portal_language text not null default 'en',
  -- 2 + 7 bookkeeping
  add column if not exists review_requested_at timestamptz,
  add column if not exists handover_sent_at timestamptz;

alter table public.projects drop constraint if exists projects_portal_language_check;
alter table public.projects add constraint projects_portal_language_check
  check (portal_language in ('en', 'si', 'ta'));

comment on column public.projects.portal_passcode is
  'Optional passcode for the client portal. NULL = the link opens straight away, which is how every project created before 0094 behaves and stays behaving. Stored as typed: this is a convenience gate on a page showing a client their own project, not a credential — the protection that matters is portal_failed_attempts, which stops a 4-digit code being guessed.';
comment on column public.projects.portal_failed_attempts is
  'Consecutive wrong passcodes. Reset to zero on a correct one. Crossing the limit sets portal_locked_until, which is what makes a short code safe.';
comment on column public.projects.portal_expires_at is
  'When the link stops working. NULL = no expiry.';
comment on column public.projects.portal_revoked_at is
  'Set to kill a link that has been forwarded somewhere it shouldn''t be, without regenerating the token. Cleared by re-sharing.';
comment on column public.projects.portal_language is
  'Language the portal renders in for this client: en | si | ta. Matches the WhatsApp agent''s own language handling (0055).';

-- 2. Reviews --------------------------------------------------
create table if not exists public.project_reviews (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  -- Its own token: a review link is NOT a portal link, and asking for a
  -- review must never hand over access to the project.
  share_token   uuid not null default gen_random_uuid() unique,
  status        text not null default 'requested'
                check (status in ('requested', 'submitted', 'declined')),
  rating        integer check (rating is null or (rating >= 1 and rating <= 5)),
  headline      text,
  body          text,
  -- Whether we may use their words publicly. Defaults to FALSE: consent is
  -- given, never assumed.
  publishable   boolean not null default false,
  client_name   text,
  requested_at  timestamptz not null default now(),
  requested_by  uuid references public.profiles (id) on delete set null,
  reminded_at   timestamptz,
  submitted_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists project_reviews_project_idx
  on public.project_reviews (project_id, created_at desc);
create index if not exists project_reviews_token_idx
  on public.project_reviews (share_token);

comment on table public.project_reviews is
  'A review asked for by SMS after delivery. One row per ask, so a re-ask is visible rather than overwriting the first attempt.';

-- 3. Approvals ------------------------------------------------
create table if not exists public.project_approvals (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  milestone_id  uuid references public.project_milestones (id) on delete set null,
  title         text not null,
  detail        text,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'changes_requested')),
  -- What the client typed to sign it, and when. This pair is the record.
  signer_name   text,
  signed_at     timestamptz,
  response_note text,
  requested_by  uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists project_approvals_project_idx
  on public.project_approvals (project_id, created_at desc);

comment on column public.project_approvals.signer_name is
  'Typed by the client on the portal at the moment they approved. Together with signed_at this is what "they signed off" means here — not a legal signature, but a dated record with a name on it.';

-- 4. Change requests ------------------------------------------
create table if not exists public.project_change_requests (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  body          text not null,
  status        text not null default 'new'
                check (status in ('new', 'quoted', 'accepted', 'declined')),
  -- What we said it would cost. NULL until someone prices it.
  quoted_amount numeric(14, 2),
  quote_note    text,
  -- The billable expense accepting it produced — the whole point.
  expense_id    uuid references public.project_expenses (id) on delete set null,
  todo_id       uuid references public.todos (id) on delete set null,
  source        text not null default 'portal'
                check (source in ('portal', 'team', 'whatsapp')),
  client_name   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists project_change_requests_project_idx
  on public.project_change_requests (project_id, created_at desc);
create index if not exists project_change_requests_open_idx
  on public.project_change_requests (project_id)
  where status in ('new', 'quoted');

comment on table public.project_change_requests is
  'Something the client asked for beyond the agreed scope. Priced, then accepted into a billable project expense — the difference between absorbing scope creep and charging for it.';

-- 5. Comments -------------------------------------------------
create table if not exists public.project_comments (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  milestone_id uuid references public.project_milestones (id) on delete cascade,
  -- 'client' rows are written by the portal with no signed-in user, so the
  -- name is carried rather than joined.
  author_type  text not null default 'team' check (author_type in ('team', 'client')),
  author_id    uuid references public.profiles (id) on delete set null,
  author_name  text not null default '',
  body         text not null,
  created_at   timestamptz not null default now()
);

create index if not exists project_comments_project_idx
  on public.project_comments (project_id, created_at desc);
create index if not exists project_comments_milestone_idx
  on public.project_comments (milestone_id, created_at);

-- 6. Pulses ---------------------------------------------------
create table if not exists public.project_pulses (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  -- 1 unhappy · 2 fine · 3 delighted. Three options, because five is a survey.
  score        integer not null check (score between 1 and 3),
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists project_pulses_project_idx
  on public.project_pulses (project_id, created_at desc);

-- 7. New delivery-event kinds ---------------------------------
-- Everything above belongs in the project's one History tab (0084), so the
-- kind list grows the same way 0085 grew the automation trigger list.
alter table public.delivery_events drop constraint if exists delivery_events_kind_check;
alter table public.delivery_events add constraint delivery_events_kind_check check (kind in (
  'kickoff', 'stage_changed', 'asset_submitted', 'asset_filed', 'asset_na',
  'chase_sent', 'stalled_alert', 'assets_complete', 'milestone_sent',
  -- 0094
  'portal_sent', 'portal_unlocked', 'portal_locked',
  'review_requested', 'review_received',
  'approval_requested', 'approval_signed',
  'change_requested', 'change_accepted',
  'comment', 'pulse', 'handover_sent'
));

-- ---- RLS ----------------------------------------------------
-- Same one-workspace model as projects (0006). The portal writes through
-- server code with the service role, so nothing here is reachable by anon.
do $$
declare
  t text;
begin
  foreach t in array array[
    'project_reviews',
    'project_approvals',
    'project_change_requests',
    'project_comments',
    'project_pulses'
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

-- ---- updated_at ---------------------------------------------
drop trigger if exists project_change_requests_set_updated_at on public.project_change_requests;
create trigger project_change_requests_set_updated_at
  before update on public.project_change_requests
  for each row execute function public.set_updated_at();

-- ---- Realtime (0021 guard pattern) --------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'project_reviews',
    'project_approvals',
    'project_change_requests',
    'project_comments'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when others then null;
    end;
  end loop;
end $$;
