-- ============================================================
-- 0063_wa_cold_outreach.sql
-- Automatic WhatsApp cold outreach — top of "New Lead" → template DM:
--
--   Every day the WhatsApp agent takes the top leads of the "New Lead"
--   column (board order), runs company research first, then opens a
--   cold conversation with a Meta-approved template — capped at
--   cold_daily_cap per Colombo day and spread ~90 min apart to protect
--   the WhatsApp number. A number that turns out not to be on WhatsApp
--   is tagged "no-whatsapp" with a remark on the lead and the next
--   lead takes its slot the same day.
--
--   wa_cold_outreach : one row per lead ever attempted (unique) — the
--                      pipeline state machine + the immutable sent copy.
--   wa_agent_config  : new cold_* columns; disabled by default so
--                      nothing fires until the team switches it on.
-- ============================================================

-- ---- Cold outreach pipeline + sent copy -----------------------
create table if not exists public.wa_cold_outreach (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null unique references public.leads (id) on delete cascade,
  -- Normalized digits-only phone; unique so a number shared by two
  -- leads can only ever be cold-messaged once.
  wa_id         text not null unique,
  status        text not null default 'researching'
                check (status in ('researching','ready','sent','delivered',
                                  'replied','no_whatsapp','failed','skipped')),
  -- Colombo-local date of the slot this pick was made for.
  picked_for    date not null,
  research_started_at timestamptz,
  -- Immutable snapshot of what actually went out.
  template_name text,
  template_lang text,
  template_params text[] not null default '{}',
  contact_id    uuid references public.wa_contacts (id) on delete set null,
  -- Meta wamid of the template send — the delivery-status join key.
  wa_message_id text,
  sent_at       timestamptz,
  error         text,
  attempts      int not null default 0,
  locked_at     timestamptz,                          -- lease (CAS), see research.ts
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Cheap claim index for the tick; unique(lead_id) is the dedupe backbone.
create index if not exists wa_cold_outreach_claim_idx
  on public.wa_cold_outreach (status, updated_at);
create index if not exists wa_cold_outreach_sent_idx
  on public.wa_cold_outreach (sent_at);

drop trigger if exists wa_cold_outreach_set_updated_at on public.wa_cold_outreach;
create trigger wa_cold_outreach_set_updated_at
  before update on public.wa_cold_outreach
  for each row execute function public.set_updated_at();

-- ---- Agent config: cold outreach settings ---------------------
alter table public.wa_agent_config
  add column if not exists cold_outreach_enabled boolean not null default false;
alter table public.wa_agent_config
  add column if not exists cold_daily_cap int not null default 5
    check (cold_daily_cap between 1 and 20);
-- Meta-approved template that legally opens the conversation
-- (approved in Meta Business Manager; we only store its name).
alter table public.wa_agent_config
  add column if not exists cold_template_name text;
alter table public.wa_agent_config
  add column if not exists cold_template_lang text not null default 'en';
-- Token strings rendered per-lead into the template's {{1}},{{2}}…
-- e.g. '{"{{business}}","{{first_name}}"}'.
alter table public.wa_agent_config
  add column if not exists cold_template_params text[] not null default '{}';
-- Where to pick from; null = the first pipeline's "New Lead" stage.
alter table public.wa_agent_config
  add column if not exists cold_pipeline_id uuid references public.pipelines (id) on delete set null;
alter table public.wa_agent_config
  add column if not exists cold_stage_id uuid references public.pipeline_stages (id) on delete set null;

-- ---- RLS + realtime (single-workspace: any authenticated) ----
do $$
declare t text;
begin
  foreach t in array array['wa_cold_outreach'] loop
    execute format('alter table public.%I enable row level security', t);
    begin
      execute format('create policy "%s: read all" on public.%I for select to authenticated using (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: insert all" on public.%I for insert to authenticated with check (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: update all" on public.%I for update to authenticated using (true) with check (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: delete all" on public.%I for delete to authenticated using (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then null; end;
  end loop;
end $$;
