-- ============================================================
-- 0112_project_tracking_portal_send.sql
--
-- PROJECTS — the client tracking link, from the moment a
-- project exists.
--
-- The portal (/public/project/<share_token>, 0016 → 0094) has
-- shown a client WHERE their project is for a long time; it
-- has never shown HOW FAR ALONG it is, nor the site itself,
-- and the link only ever went out by SMS from a card on the
-- project's Client tab. This migration carries what the rest
-- of the feature needs:
--
--   1. PROGRESS + SITE LINKS on the project. The percentage is
--      computed in code (src/lib/project-progress.ts) from the
--      delivery stage and the client-visible milestones;
--      `progress_override` is the team's manual number when
--      the milestones don't describe a build well. The preview
--      and live URLs, the launch stamp and the "latest update"
--      line are what the client actually wants to see.
--
--      `package_key` records which catalogue package was sold
--      (web_smart_site, web_smart_business, …) — the sales
--      vocabulary the service_type CHECK never could express.
--
--   2. PORTAL SEND SETTINGS. The link now goes out on WhatsApp
--      automatically when a project is created with a client
--      on it (SMS fallback). Outside the 24h window WhatsApp
--      only accepts an approved template; its name lives here
--      like the onboarding and chaser templates already do.
--
--   3. Two more delivery-event kinds for the History tab.
--
--   4. INVOICES REMEMBER WHO THEY BILL. Converting a quote
--      dropped the client, the lead and the currency on the
--      floor; the columns now exist for the converter to fill.
--
--   5. CLIENTS ARE FINDABLE BY PHONE. A generated, normalised
--      copy of `phone` (Notify.lk shape, 94XXXXXXXXX — the same
--      rule as src/lib/sms-utils.ts) so a signed quote, an
--      inbound WhatsApp contact or a public booking can find
--      the client record without a full scan.
--
--   6. A public booking can belong to a client (nullable FK).
--
-- Additive and idempotent. Apply BEFORE pushing the code that
-- reads these columns — the app selects them by name.
-- ============================================================

-- 1. Progress and site links ------------------------------------
alter table public.projects
  add column if not exists progress_override int,
  add column if not exists preview_url text,
  add column if not exists live_url text,
  add column if not exists launched_at timestamptz,
  add column if not exists client_note text,
  add column if not exists client_note_at timestamptz,
  add column if not exists package_key text;

alter table public.projects drop constraint if exists projects_progress_override_check;
alter table public.projects add constraint projects_progress_override_check
  check (progress_override is null or progress_override between 0 and 100);

comment on column public.projects.progress_override is
  'Manual 0-100 progress set by the team. NULL = computed from delivery stage + client-visible milestones (src/lib/project-progress.ts).';
comment on column public.projects.preview_url is
  'Staging/preview site the client may look at before launch. Team-entered; never a URL that carries credentials.';
comment on column public.projects.live_url is
  'The launched site. Set by the Launch action together with launched_at.';
comment on column public.projects.client_note is
  'The latest one-line update shown to the client on their portal ("what is happening now").';
comment on column public.projects.package_key is
  'Pricing-catalogue package key that was sold (e.g. web_smart_site). NULL for projects created before 0112 or outside the catalogue.';

-- 2. Portal send settings ---------------------------------------
alter table public.delivery_settings
  add column if not exists portal_auto_send boolean not null default true,
  add column if not exists portal_template_name text,
  add column if not exists portal_template_lang text not null default 'en';

comment on column public.delivery_settings.portal_auto_send is
  'Send the client their tracking link automatically when a project is created with a client that has a phone number.';
comment on column public.delivery_settings.portal_template_name is
  'Approved WhatsApp template used for the portal link when the client''s 24h window is closed. Body {{1}} first name, {{2}} project name, {{3}} passcode line; URL button suffix = share token. Empty = fall back to SMS.';

-- 3. New delivery-event kinds -----------------------------------
alter table public.delivery_events drop constraint if exists delivery_events_kind_check;
alter table public.delivery_events add constraint delivery_events_kind_check check (kind in (
  'kickoff', 'stage_changed', 'asset_submitted', 'asset_filed', 'asset_na',
  'chase_sent', 'stalled_alert', 'assets_complete', 'milestone_sent',
  -- 0094
  'portal_sent', 'portal_unlocked', 'portal_locked',
  'review_requested', 'review_received',
  'approval_requested', 'approval_signed',
  'change_requested', 'change_accepted',
  'comment', 'pulse', 'handover_sent',
  -- 0112
  'client_note', 'site_launched'
));

-- 4. Invoices remember who they bill ----------------------------
alter table public.invoices
  add column if not exists client_id uuid references public.clients(id) on delete set null,
  add column if not exists lead_id uuid references public.leads(id) on delete set null,
  add column if not exists currency text;

create index if not exists invoices_client_idx on public.invoices (client_id);
create index if not exists invoices_lead_idx on public.invoices (lead_id);

comment on column public.invoices.currency is
  'ISO code the invoice was raised in. NULL = LKR (every invoice before 0112).';

-- 5. Clients are findable by phone ------------------------------
-- Mirrors normalizePhone() in src/lib/sms-utils.ts exactly: digits only;
-- 0094… → 94…; a leading 0 → 94…; nine bare digits → 94 + digits; anything
-- that does not end up as 94 followed by nine digits is NULL.
create or replace function public.normalize_lk_phone(raw text)
returns text
language plpgsql
immutable
as $$
declare
  digits text := regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g');
  normalized text;
begin
  if digits = '' then
    return null;
  end if;
  if digits like '0094%' then
    normalized := substr(digits, 3);
  elsif digits like '94%' then
    normalized := digits;
  elsif digits like '0%' then
    normalized := '94' || substr(digits, 2);
  elsif length(digits) = 9 then
    normalized := '94' || digits;
  else
    normalized := digits;
  end if;
  if normalized !~ '^94[0-9]{9}$' then
    return null;
  end if;
  return normalized;
end;
$$;

alter table public.clients
  add column if not exists phone_norm text
    generated always as (public.normalize_lk_phone(phone)) stored;

create index if not exists clients_phone_norm_idx on public.clients (phone_norm);
create index if not exists clients_email_lower_idx on public.clients (lower(email));

-- 6. Public bookings can belong to a client ---------------------
alter table public.meeting_bookings
  add column if not exists client_id uuid references public.clients(id) on delete set null;

create index if not exists meeting_bookings_client_idx on public.meeting_bookings (client_id);
