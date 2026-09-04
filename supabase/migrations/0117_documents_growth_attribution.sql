-- ============================================================
-- 0117_documents_growth_attribution.sql
-- ============================================================
-- Track 2 of the next wave: the client and growth machine.
--
-- Four gaps this closes, all of them places where work leaves the system and
-- comes back as a guess:
--
--   1. A proposal has no accept flow. A quote can be signed on a link; a
--      proposal — the bigger document — can only be emailed and chased.
--   2. Nothing records WHERE a lead came from. `leads.source` is free text,
--      and the website form sends no UTM at all, so "what is working" is
--      answered from memory.
--   3. A testimonial is collected and then retyped onto the website by hand.
--   4. Cold outreach is one email. There is no follow-up, and no record of
--      who opened anything.
--
-- Adds: proposal sharing + signing; agreements (contract/SOW) and their
-- templates; client-visible deliverables; a per-project booking slug; a
-- client statement token; referral codes and the referrals ledger; lead
-- attribution columns; review publishing state; the insight→to-do link;
-- outreach sequences and their steps; and the free site-audit requests.
--
-- Additive and idempotent. Nothing is backfilled or deleted.
-- Apply BEFORE pushing the code that reads these columns.
-- ============================================================

-- 1. Proposals become signable ---------------------------------------

alter table public.proposals
  add column if not exists share_token uuid not null default gen_random_uuid(),
  add column if not exists status text not null default 'draft',
  add column if not exists sent_at timestamptz,
  add column if not exists viewed_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists declined_at timestamptz,
  add column if not exists declined_reason text,
  add column if not exists signed_name text,
  add column if not exists signature_data text,
  add column if not exists signed_ip text,
  add column if not exists invoice_id uuid references public.invoices (id) on delete set null,
  add column if not exists currency text not null default 'LKR';

-- Same states as quotes (0060), so the two documents read alike.
alter table public.proposals drop constraint if exists proposals_status_check;
alter table public.proposals add constraint proposals_status_check
  check (status in ('draft', 'sent', 'viewed', 'accepted', 'declined'));

create unique index if not exists proposals_share_token_key
  on public.proposals (share_token);

comment on column public.proposals.share_token is
  'The /p/<token> link. Unguessable, and the whole credential — same model as /q.';

-- 2. Agreements (contract / SOW / NDA) --------------------------------

create table if not exists public.agreements (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null default 'contract'
                 check (kind in ('contract', 'sow', 'nda', 'custom')),
  title          text not null,
  -- Markdown, rendered by src/lib/markdown.ts. Not HTML: this text ends up
  -- in a PDF and on a public page, and accepting HTML there is a liability.
  body_md        text not null default '',
  client_id      uuid references public.clients (id)   on delete set null,
  lead_id        uuid references public.leads (id)     on delete set null,
  project_id     uuid references public.projects (id)  on delete set null,
  proposal_id    uuid references public.proposals (id) on delete set null,
  quote_id       uuid references public.quotes (id)    on delete set null,
  status         text not null default 'draft'
                 check (status in ('draft', 'sent', 'viewed', 'signed', 'declined', 'void')),
  share_token    uuid not null default gen_random_uuid(),
  sent_at        timestamptz,
  viewed_at      timestamptz,
  signed_at      timestamptz,
  signed_name    text,
  signature_data text,
  signed_ip      text,
  signer_email   text,
  declined_at    timestamptz,
  declined_reason text,
  -- Where the countersigned PDF was stored, once signed.
  pdf_path       text,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists agreements_share_token_key
  on public.agreements (share_token);
create index if not exists agreements_client_idx
  on public.agreements (client_id, created_at desc);
create index if not exists agreements_project_idx
  on public.agreements (project_id, created_at desc);

drop trigger if exists agreements_set_updated_at on public.agreements;
create trigger agreements_set_updated_at
  before update on public.agreements
  for each row execute function public.set_updated_at();

create table if not exists public.agreement_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  kind       text not null default 'contract',
  body_md    text not null default '',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists agreement_templates_set_updated_at on public.agreement_templates;
create trigger agreement_templates_set_updated_at
  before update on public.agreement_templates
  for each row execute function public.set_updated_at();

-- 3. Deliverables the client can actually download --------------------
-- Until now `projects.documents` was two URLs on the portal. A file the
-- client is meant to receive is a row, with a version and a visibility.

create table if not exists public.project_deliverables (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  title            text not null,
  /* Storage path inside the project-docs bucket. */
  file_path        text not null,
  mime             text,
  size_bytes       bigint,
  version          int not null default 1,
  -- Off by default: a file lands in the project first and is shared on
  -- purpose, never by being uploaded.
  visible_to_client boolean not null default false,
  uploaded_by      uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists project_deliverables_project_idx
  on public.project_deliverables (project_id, created_at desc);

-- 4. Booking + statement links ----------------------------------------

alter table public.projects
  add column if not exists booking_slug text;

comment on column public.projects.booking_slug is
  'Overrides delivery_settings.portal_booking_slug for this project''s "book a call" link.';

alter table public.clients
  add column if not exists statement_token uuid not null default gen_random_uuid(),
  -- Minted lazily by src/lib/referrals.ts the first time it is needed, so an
  -- existing client only gets a code when somebody actually shares one.
  add column if not exists referral_code text;

create unique index if not exists clients_statement_token_key
  on public.clients (statement_token);
create unique index if not exists clients_referral_code_key
  on public.clients (referral_code)
  where referral_code is not null;

-- 5. Referrals ---------------------------------------------------------

create table if not exists public.referrals (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null,
  referrer_client_id uuid references public.clients (id) on delete set null,
  referred_lead_id   uuid references public.leads (id)   on delete set null,
  referred_client_id uuid references public.clients (id) on delete set null,
  status             text not null default 'pending'
                     check (status in ('pending', 'won', 'rewarded', 'void')),
  reward_kind        text,
  reward_amount      numeric,
  reward_note        text,
  won_at             timestamptz,
  rewarded_at        timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists referrals_code_idx on public.referrals (code);
create index if not exists referrals_referrer_idx
  on public.referrals (referrer_client_id, created_at desc);
-- One referral row per referred lead: a re-submitted form must not create a
-- second reward for the same introduction.
create unique index if not exists referrals_lead_key
  on public.referrals (referred_lead_id)
  where referred_lead_id is not null;

-- 6. Where a lead actually came from ----------------------------------

alter table public.leads
  add column if not exists utm jsonb not null default '{}'::jsonb,
  add column if not exists referrer text,
  add column if not exists landing_url text,
  add column if not exists referral_code text,
  add column if not exists referred_by_client_id uuid
    references public.clients (id) on delete set null,
  -- Same generated expression as clients.phone_norm (0112), so the two can be
  -- compared directly when deduping an inbound enquiry against a client.
  add column if not exists contact_phone_norm text
    generated always as (public.normalize_lk_phone(contact_phone)) stored;

create index if not exists leads_contact_phone_norm_idx
  on public.leads (contact_phone_norm);
create index if not exists leads_utm_source_idx
  on public.leads ((utm ->> 'utm_source'));

-- 7. Publishing a testimonial to the website --------------------------
-- The website is a SEPARATE Supabase project, so this records the far-side
-- id rather than referencing it. A failed publish stays visible instead of
-- looking like it worked.

alter table public.project_reviews
  add column if not exists publish_status text not null default 'unpublished'
    check (publish_status in ('unpublished', 'published', 'failed')),
  add column if not exists published_at timestamptz,
  add column if not exists website_review_id uuid,
  add column if not exists publish_error text;

-- 8. A web insight becomes a to-do -------------------------------------

alter table public.web_insight_tasks
  add column if not exists todo_id uuid references public.todos (id) on delete set null;

-- 9. Outreach sequences ------------------------------------------------

create table if not exists public.outreach_sequences (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  enabled     boolean not null default true,
  -- [{ delay_days, subject, body, stop_on_reply }]
  steps       jsonb not null default '[]'::jsonb,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists outreach_sequences_set_updated_at on public.outreach_sequences;
create trigger outreach_sequences_set_updated_at
  before update on public.outreach_sequences
  for each row execute function public.set_updated_at();

alter table public.lead_outreach
  add column if not exists sequence_id uuid
    references public.outreach_sequences (id) on delete set null;

create table if not exists public.lead_outreach_steps (
  id               uuid primary key default gen_random_uuid(),
  outreach_id      uuid not null references public.lead_outreach (id) on delete cascade,
  sequence_id      uuid references public.outreach_sequences (id) on delete set null,
  step_no          int not null,
  due_at           timestamptz not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'sent', 'skipped', 'stopped', 'failed')),
  email_message_id uuid references public.email_messages (id) on delete set null,
  error            text,
  sent_at          timestamptz,
  created_at       timestamptz not null default now()
);

-- The queue's own index: what is due, oldest first.
create index if not exists lead_outreach_steps_due_idx
  on public.lead_outreach_steps (due_at)
  where status = 'pending';
-- A step fires once per outreach row, whatever happens on a retry.
create unique index if not exists lead_outreach_steps_key
  on public.lead_outreach_steps (outreach_id, step_no);

-- 10. The free site audit ---------------------------------------------

create table if not exists public.site_audit_requests (
  id          uuid primary key default gen_random_uuid(),
  url         text not null,
  email       text not null,
  name        text,
  phone       text,
  lead_id     uuid references public.leads (id) on delete set null,
  status      text not null default 'queued'
              check (status in ('queued', 'running', 'sent', 'failed')),
  verdict     jsonb,
  report      jsonb,
  error       text,
  ip          text,
  emailed_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists site_audit_requests_status_idx
  on public.site_audit_requests (status, created_at);

-- 11. RLS --------------------------------------------------------------
-- Workspace-shared, like the rest of the operational tables. The public
-- pages that read agreements and proposals do so through the service-role
-- client with hand-picked columns, never through these policies.

alter table public.agreements           enable row level security;
alter table public.agreement_templates  enable row level security;
alter table public.project_deliverables enable row level security;
alter table public.referrals            enable row level security;
alter table public.outreach_sequences   enable row level security;
alter table public.lead_outreach_steps  enable row level security;
alter table public.site_audit_requests  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'agreements', 'agreement_templates', 'project_deliverables',
    'referrals', 'outreach_sequences', 'lead_outreach_steps',
    'site_audit_requests'
  ] loop
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

-- 12. Realtime (0021 guard pattern) ------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['agreements', 'project_deliverables'] loop
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
