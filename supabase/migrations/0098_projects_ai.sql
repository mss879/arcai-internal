-- ============================================================
-- 0098_projects_ai.sql
--
-- PROJECTS ROADMAP — theme 5 (AI).
--
-- The sales side of this workspace is heavily AI-driven: lead
-- research, cold drafting, coaching, conversation insights and
-- an approve-first lessons queue. Delivery had exactly one AI
-- feature — the WhatsApp onboarding agent. This closes the gap.
--
-- Most of the theme needs NO schema, because the pattern that
-- works here is the one receipt.ts established: draft, show the
-- human, never save on the model's word. A project brief
-- pre-fills a form. An estimate is a read over history. A
-- progress note becomes an ordinary project comment. Only four
-- things need somewhere to live:
--
--   1. PROJECT LESSONS (AI-6) — when a project closes, what it
--      taught us. Same approve-first shape as wa_lessons: the
--      model proposes, a person keeps or dismisses, and only
--      kept lessons are ever quoted back. Its own table rather
--      than wa_lessons because the kinds are different and
--      mixing them would make both queues useless.
--
--   2. RISK RADAR (AI-4) — the nightly pass that ranks open
--      projects by what needs a human today. Stored on the
--      project so the morning digest, the board and the
--      dashboard can all read the same answer instead of each
--      running their own.
--
--   3. SCOPE CREEP (AI-3) — a stamp so the same WhatsApp
--      thread isn't re-read every tick, and a flag on the
--      change request so the team can see which ones the model
--      spotted rather than a person.
--
--   4. ANOMALY GUARDS (AI-9) — the same expense entered twice,
--      a payment on the wrong project, two projects born of one
--      deposit. Deliberately RULE-BASED, not a model: it is
--      arithmetic, it must be explainable to whoever is being
--      told they made a mistake, and it must never cost a
--      token. Fingerprinted so a pair that has been dismissed
--      stays dismissed.
--
-- Additive and idempotent: safe against the live build, and
-- safe to re-run.
-- ============================================================

-- 1. Lessons from a closed project (AI-6) ---------------------
create table if not exists public.project_lessons (
  id          uuid primary key default gen_random_uuid(),
  /** Kept when the project is archived; nulled if it is truly deleted. */
  project_id  uuid references public.projects (id) on delete set null,
  /** The project's name at the time, so a lesson survives its subject. */
  project_name text not null default '',
  title       text not null,
  body        text not null,
  category    text not null default 'delivery',
  /** The numbers the lesson was drawn from — what makes it checkable. */
  evidence    jsonb not null default '{}'::jsonb,
  status      text not null default 'new',
  decided_by  uuid references public.profiles (id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.project_lessons drop constraint if exists project_lessons_category_check;
alter table public.project_lessons add constraint project_lessons_category_check
  check (category in ('pricing', 'scope', 'timeline', 'delivery', 'client'));

alter table public.project_lessons drop constraint if exists project_lessons_status_check;
alter table public.project_lessons add constraint project_lessons_status_check
  check (status in ('new', 'kept', 'dismissed'));

comment on table public.project_lessons is
  'AI-6: what a finished project taught us — where the time went, where the margin leaked, what to quote differently. Approve-first like wa_lessons: only status = kept is ever quoted back into an estimate.';
comment on column public.project_lessons.evidence is
  'The figures behind the lesson (quoted vs actual, days per stage, extras). A lesson nobody can check is a lesson nobody should act on.';

create index if not exists project_lessons_project_idx
  on public.project_lessons (project_id);
create index if not exists project_lessons_status_idx
  on public.project_lessons (status, created_at desc);

-- One set of lessons per project, so re-running the post-mortem
-- refreshes rather than piles up.
create unique index if not exists project_lessons_unique_idx
  on public.project_lessons (project_id, title)
  where project_id is not null;

-- 2. Nightly risk radar (AI-4) --------------------------------
alter table public.projects
  add column if not exists risk_rank integer,
  add column if not exists risk_note text,
  add column if not exists risk_checked_at timestamptz;

comment on column public.projects.risk_rank is
  'AI-4: 1 = the project that most needs a human today. NULL = not in the current ranking. Rewritten wholesale by each nightly pass, so it is never stale by more than a day.';
comment on column public.projects.risk_note is
  'AI-4: one sentence saying WHY, in plain English. A ranking without a reason gets ignored.';

create index if not exists projects_risk_rank_idx
  on public.projects (risk_rank)
  where deleted_at is null and risk_rank is not null;

-- 3. Scope-creep detection bookkeeping (AI-3) -----------------
alter table public.projects
  add column if not exists scope_checked_at timestamptz;

comment on column public.projects.scope_checked_at is
  'AI-3: how far the scope-creep reader has got through this client''s WhatsApp thread. Without it every tick re-reads the whole conversation and re-flags the same request.';

alter table public.project_change_requests
  add column if not exists ai_flagged boolean not null default false,
  add column if not exists ai_reason text;

comment on column public.project_change_requests.ai_flagged is
  'AI-3: raised by the scope-creep reader rather than typed by a person or submitted on the portal. The team sees which is which before quoting.';

-- 4. Duplicate and anomaly guards (AI-9) ----------------------
create table if not exists public.project_anomalies (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects (id) on delete cascade,
  kind        text not null,
  /** Plain English, naming both sides of the problem. */
  detail      text not null,
  evidence    jsonb not null default '{}'::jsonb,
  /** Stable identity of the PAIR, so dismissing one keeps it dismissed. */
  fingerprint text not null,
  status      text not null default 'open',
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.project_anomalies drop constraint if exists project_anomalies_kind_check;
alter table public.project_anomalies add constraint project_anomalies_kind_check
  check (kind in (
    'duplicate_expense',
    'duplicate_payment',
    'duplicate_project',
    'payment_over_value',
    'expense_no_receipt'
  ));

alter table public.project_anomalies drop constraint if exists project_anomalies_status_check;
alter table public.project_anomalies add constraint project_anomalies_status_check
  check (status in ('open', 'dismissed', 'fixed'));

comment on table public.project_anomalies is
  'AI-9: quiet arithmetic guards — the same expense twice, a payment that overshoots the contract, two projects from one deposit. Rule-based on purpose: it must be explainable to the person being told they made a mistake, and it must not cost a token to run.';
comment on column public.project_anomalies.fingerprint is
  'Identity of the problem, not of the row — usually the two record ids in a stable order. Unique, so a dismissed pair is never raised again.';

create unique index if not exists project_anomalies_fingerprint_idx
  on public.project_anomalies (fingerprint);
create index if not exists project_anomalies_open_idx
  on public.project_anomalies (status, created_at desc);

-- ---- RLS ----------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['project_lessons', 'project_anomalies'] loop
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
drop trigger if exists project_lessons_set_updated_at on public.project_lessons;
create trigger project_lessons_set_updated_at
  before update on public.project_lessons
  for each row execute function public.set_updated_at();
