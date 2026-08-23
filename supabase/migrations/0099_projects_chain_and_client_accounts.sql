-- ============================================================
-- 0099_projects_chain_and_client_accounts.sql
--
-- PROJECTS ROADMAP — theme 8 (BIG), parts 1 and 2.
--
-- ------------------------------------------------------------
-- BIG-2 — LINK THE WHOLE CHAIN
-- ------------------------------------------------------------
-- lead → quote → proposal → project → invoice → payment.
--
-- Most of that chain already exists: quotes carry lead_id,
-- client_id and invoice_id (0028/0031); invoices, payments,
-- company_payments and payment_plans all carry project_id
-- (0083/0091). Two links were never made, and they are the two
-- that break every report:
--
--   • PROPOSALS point at nothing. They have a client_name TEXT
--     column and that is all — so a proposal cannot be traced
--     to the deal it closed. AI-1 (0098) already pays for this:
--     it matches proposals by NAME because there is no key.
--
--   • PROJECTS point forward but not back. A project knows its
--     client; it does not know which lead became it, which
--     quote priced it, or which proposal described it.
--
-- With both, "what did this lead eventually earn us, and what
-- did it cost to deliver" becomes one query instead of a
-- morning of spreadsheet work.
--
-- Every column is NULLABLE and nothing is enforced: eight
-- months of history has no links to backfill, and refusing to
-- save a project without a quote would be a worse product than
-- the one this replaces. The links are recorded when they are
-- known.
--
-- ------------------------------------------------------------
-- BIG-1 — CLIENT ACCOUNTS
-- ------------------------------------------------------------
-- Today a client gets one unguessable URL per project. Three
-- projects means three links to keep, and a forwarded message
-- is a permanent grant. CX-6's passcode helped; it did not make
-- the link an account.
--
-- A client now signs in with their PHONE and a 6-digit SMS
-- code, and sees everything of theirs in one place. Phone, not
-- email, because it is the channel this agency actually reaches
-- clients on — Notify.lk is already wired, and phone numbers
-- are far more reliable than email addresses in `clients`.
--
-- The share token does NOT go away. It stays as the
-- convenience it always was, for the client who just wants the
-- link in WhatsApp — it is simply no longer the only way in.
--
-- Codes are stored HASHED with the same service-role key that
-- signs the portal cookie: a leaked table row must not be a
-- working login. Attempts are counted, because with a 6-digit
-- code the counter — not the length — is the protection.
--
-- Additive and idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- BIG-2 — the missing links
-- ------------------------------------------------------------

alter table public.proposals
  add column if not exists lead_id    uuid references public.leads (id) on delete set null,
  add column if not exists client_id  uuid references public.clients (id) on delete set null,
  add column if not exists quote_id   uuid references public.quotes (id) on delete set null,
  add column if not exists project_id uuid references public.projects (id) on delete set null;

alter table public.projects
  add column if not exists lead_id     uuid references public.leads (id) on delete set null,
  add column if not exists quote_id    uuid references public.quotes (id) on delete set null,
  add column if not exists proposal_id uuid references public.proposals (id) on delete set null;

comment on column public.projects.lead_id is
  'BIG-2: the CRM lead this project came from. NULL for work that never went through the pipeline.';
comment on column public.projects.quote_id is
  'BIG-2: the quotation that priced this project. The join that makes "quoted vs delivered" answerable.';
comment on column public.proposals.project_id is
  'BIG-2: the project this proposal became. Set when a project is created from it.';

create index if not exists proposals_lead_idx    on public.proposals (lead_id);
create index if not exists proposals_client_idx  on public.proposals (client_id);
create index if not exists proposals_project_idx on public.proposals (project_id);
create index if not exists projects_lead_idx     on public.projects (lead_id);
create index if not exists projects_quote_idx    on public.projects (quote_id);

-- Best-effort backfill of the link that is safely inferable.
--
-- ONLY proposals → clients, and only on an EXACT case-insensitive
-- name match with exactly one candidate. A fuzzy match here would
-- attach one client's proposal to another's file, which is worse
-- than no link at all. Everything else is left for the UI to record
-- as it happens.
update public.proposals p
   set client_id = c.id
  from public.clients c
 where p.client_id is null
   and lower(trim(p.client_name)) = lower(trim(c.name))
   and (
     select count(*) from public.clients c2
      where lower(trim(c2.name)) = lower(trim(p.client_name))
   ) = 1;

-- ------------------------------------------------------------
-- BIG-1 — client accounts
-- ------------------------------------------------------------

create table if not exists public.client_login_codes (
  id           uuid primary key default gen_random_uuid(),
  /** Normalised E.164, so "0771852522" and "+94771852522" are one row. */
  phone        text not null,
  /** HMAC of the code — never the code itself. */
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     integer not null default 0,
  consumed_at  timestamptz,
  /** Rate limiting: how many codes this number has asked for today. */
  requested_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

comment on table public.client_login_codes is
  'BIG-1: one-time SMS codes for the client portal login. Codes are stored hashed — a leaked row must not be a working login. Rows are disposable; anything past expires_at can be deleted at will.';
comment on column public.client_login_codes.attempts is
  'Wrong guesses against this code. With six digits the counter is the protection, not the length.';

create index if not exists client_login_codes_phone_idx
  on public.client_login_codes (phone, created_at desc);

-- Sessions are a signed cookie, not a table — the same choice
-- portal-access.ts made in 0094, for the same reason: nothing to
-- clean up, and rotating the service-role key logs everyone out.
-- What IS worth keeping is the fact that a client has ever signed
-- in, so the team can see the portal is actually being used.
alter table public.clients
  add column if not exists portal_last_login_at timestamptz,
  add column if not exists portal_login_count integer not null default 0;

comment on column public.clients.portal_last_login_at is
  'BIG-1: when this client last signed in to their portal. NULL = never — which is itself worth knowing before assuming they have seen anything.';

-- ---- RLS ----------------------------------------------------
-- The login-code table is only ever touched by the admin client
-- from a server action, never from the browser. RLS on with NO
-- permissive policy is deliberate: authenticated team members
-- have no business reading login codes either.
alter table public.client_login_codes enable row level security;
drop policy if exists "client_login_codes: none" on public.client_login_codes;
