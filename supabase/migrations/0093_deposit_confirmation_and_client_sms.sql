-- ============================================================
-- 0093_deposit_confirmation_and_client_sms.sql
--
-- Two things a project should do the moment money lands, and
-- one thing it should be able to do at any point after.
--
--   1. SHAREABLE INVOICES — `invoices.share_token` gives every
--      invoice its own unguessable public link. Opening that
--      link shows the invoice and NOTHING else: no portal, no
--      project, no workspace. It is the only thing a client
--      ever receives at deposit time.
--
--   2. DEPOSIT CONFIRMATION — a project records when its
--      deposit was confirmed against the bank, by whom, and
--      which invoice that produced. The stamp is what makes
--      "confirm" a one-time action: the button disappears once
--      it's set, so a second click can't raise a second
--      invoice or send a second text.
--
--   3. CLIENT SMS ON MILESTONES — a milestone can be marked as
--      one the client should hear about. When it's completed
--      the client gets a text; `notified_at` guarantees they
--      get it exactly once, however many times the milestone
--      is ticked and un-ticked.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- 1. Shareable invoices ---------------------------------------
alter table public.invoices
  add column if not exists share_token uuid default gen_random_uuid(),
  add column if not exists shared_at timestamptz;

-- Invoices written before this migration have no token; give them one so an
-- old invoice can be sent to a client without being re-issued.
update public.invoices set share_token = gen_random_uuid() where share_token is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invoices_share_token_key'
  ) then
    alter table public.invoices add constraint invoices_share_token_key unique (share_token);
  end if;
end $$;

create index if not exists invoices_share_token_idx
  on public.invoices (share_token);

comment on column public.invoices.share_token is
  'Unguessable token for the public invoice page (/public/invoice/<token>). The client sees the invoice and nothing else — no portal, no project, no workspace. Regenerating it silently invalidates any link already sent.';
comment on column public.invoices.shared_at is
  'When the link was last texted or emailed to the client. NULL = never sent.';

-- 2. Deposit confirmation -------------------------------------
alter table public.projects
  add column if not exists deposit_confirmed_at timestamptz,
  add column if not exists deposit_confirmed_by uuid references public.profiles (id) on delete set null,
  add column if not exists deposit_invoice_id uuid references public.invoices (id) on delete set null;

comment on column public.projects.deposit_confirmed_at is
  'When a human confirmed, against the bank, that the deposit had actually arrived — NOT when it was typed into deposit_paid. Setting it is what raises the stamped invoice and texts the client, and its presence is what stops that happening twice.';
comment on column public.projects.deposit_invoice_id is
  'The deposit-stamped invoice raised by that confirmation, so the same link can be re-sent without issuing a new document.';

-- 3. Milestones the client hears about ------------------------
alter table public.project_milestones
  add column if not exists notify_sms boolean not null default false,
  add column if not exists notified_at timestamptz;

comment on column public.project_milestones.notify_sms is
  'TRUE = text the client when this milestone is completed. Off by default: most milestones are internal rhythm, and a client texted about every one of them stops reading them.';
comment on column public.project_milestones.notified_at is
  'When that text went out. The guard against re-texting when a milestone is ticked, un-ticked and ticked again.';

-- 4. sms_messages: let a text name the project it was about ---
alter table public.sms_messages
  add column if not exists project_id uuid
    references public.projects (id) on delete set null;

create index if not exists sms_messages_project_idx
  on public.sms_messages (project_id);

comment on column public.sms_messages.project_id is
  'The project this text was about, when it was sent from one. Lets a project show every message its client has been sent without trawling the global SMS history.';
