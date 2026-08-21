-- ============================================================
-- 0086_wa_onboarding.sql
--
-- CLIENT DELIVERY HUB — part 3 of 3.
--
-- Gives the WhatsApp agent a second brain. Until now every
-- conversation ran the SALES prompt (with campaign focus as
-- the only variation, 0065). A client who has already PAID
-- must never be re-pitched — so a contact can now be flipped
-- into 'onboarding' mode, where the agent becomes the delivery
-- coordinator: it collects the project's assets (logo, photos,
-- content, access), files what the client sends against the
-- checklist, and hands back to the team when everything is in.
--
--   • wa_contacts.mode — 'sales' (default, unchanged behavior)
--     or 'onboarding'. The mode also shields the contact from
--     the sales machinery: follow-up cadence, promises and
--     revival all skip onboarding threads.
--   • wa_contacts.onboarding_project_id — which project the
--     collection is for (kept after onboarding finishes, as
--     history).
--   • Five new agent tools, appended to the allowed set so
--     they're live without a visit to the Agent tab.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

alter table public.wa_contacts
  add column if not exists mode text not null default 'sales',
  add column if not exists onboarding_project_id uuid
    references public.projects (id) on delete set null;

alter table public.wa_contacts drop constraint if exists wa_contacts_mode_check;
alter table public.wa_contacts add constraint wa_contacts_mode_check
  check (mode in ('sales', 'onboarding'));

-- Partial index: almost every contact stays 'sales'; the scanners only
-- ever look for the exceptions.
create index if not exists wa_contacts_mode_idx
  on public.wa_contacts (mode) where mode <> 'sales';

-- New onboarding tools → allowed by default (guarded appends).
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{get_asset_checklist}'
  where not ('get_asset_checklist' = any (allowed_tools));
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{file_asset}'
  where not ('file_asset' = any (allowed_tools));
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{skip_asset}'
  where not ('skip_asset' = any (allowed_tools));
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{send_portal_link}'
  where not ('send_portal_link' = any (allowed_tools));
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{finish_onboarding}'
  where not ('finish_onboarding' = any (allowed_tools));
