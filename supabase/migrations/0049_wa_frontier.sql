-- ============================================================
-- 0049_wa_frontier.sql
-- WhatsApp sales machine — frontier features:
--
--   wa_showcases            : the "live sales showcase" — a personalized
--                             public page (audit + Nano Banana 2 redesign
--                             mockup of the prospect's own homepage) built
--                             by the automation tick and delivered into
--                             the chat as ONE image message with a link.
--                             pending → rendering → ready → sent
--   prospect_scan_schedules : recurring Find Leads scans (the autonomous
--                             hunter-closer loop's discovery cadence).
--   wa_coaching             : weekly auto-generated sales coaching learned
--                             from the agent's own won/lost conversations,
--                             injected back into its system prompt.
--   wa_agent_config         : gains voice_replies ('off' | 'match') for
--                             the voice-note agent.
--
-- One storage bucket: wa-showcases (public — mockups + before shots).
-- Idempotent: safe to re-run.
-- ============================================================

-- ---- Live sales showcases ------------------------------------
create table if not exists public.wa_showcases (
  id                uuid primary key default gen_random_uuid(),
  token             text not null unique
                    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  contact_id        uuid not null references public.wa_contacts (id) on delete cascade,
  lead_id           uuid references public.leads (id) on delete set null,
  status            text not null default 'pending'
                    check (status in ('pending', 'rendering', 'ready', 'sent', 'error')),
  -- What to build from: { url, business, industry?, city? }
  config            jsonb not null default '{}',
  -- What the page renders: scores, issues, summary, whatsapp_number,
  -- booking_url — assembled by the tick worker.
  payload           jsonb not null default '{}',
  before_image_url  text,
  mockup_image_url  text,
  error             text,
  attempts          integer not null default 0,
  locked_at         timestamptz,
  viewed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists wa_showcases_claimable_idx
  on public.wa_showcases (updated_at)
  where status in ('pending', 'rendering', 'ready');
create index if not exists wa_showcases_contact_idx
  on public.wa_showcases (contact_id, created_at desc);

drop trigger if exists wa_showcases_set_updated_at on public.wa_showcases;
create trigger wa_showcases_set_updated_at
  before update on public.wa_showcases
  for each row execute function public.set_updated_at();

-- ---- Recurring prospecting schedules -------------------------
create table if not exists public.prospect_scan_schedules (
  id             uuid primary key default gen_random_uuid(),
  label          text not null default 'Weekly scan',
  -- Mirrors the Find Leads launcher's inputs.
  area           text not null,
  category       text not null,
  threshold      integer not null default 60,
  max_results    integer not null default 40,
  cadence_days   integer not null default 7,
  next_run_at    timestamptz not null default now(),
  -- Cold first-touch: requires an APPROVED Meta template.
  auto_outreach  boolean not null default false,
  template_name  text,
  template_lang  text not null default 'en',
  is_active      boolean not null default true,
  last_scan_id   uuid references public.prospect_scans (id) on delete set null,
  created_by     uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now()
);

create index if not exists prospect_scan_schedules_due_idx
  on public.prospect_scan_schedules (next_run_at) where is_active;

-- ---- Self-improving playbook ---------------------------------
create table if not exists public.wa_coaching (
  id         uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  -- Conversation/deal stats the notes were derived from.
  stats      jsonb not null default '{}',
  -- The coaching bullets injected into the agent's system prompt.
  notes      text not null default '',
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---- Voice replies toggle ------------------------------------
alter table public.wa_agent_config
  add column if not exists voice_replies text not null default 'match'
  check (voice_replies in ('off', 'match'));

-- ---- Ensure new agent tools are allowed on existing installs --
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{audit_website}'
  where not ('audit_website' = any(allowed_tools));
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{send_showcase}'
  where not ('send_showcase' = any(allowed_tools));

-- ---- Storage buckets: showcase images + outbound voice notes --
insert into storage.buckets (id, name, public)
values ('wa-showcases', 'wa-showcases', true)
on conflict (id) do nothing;

do $$ begin
  create policy "storage: public read wa-showcases"
    on storage.objects for select
    using (bucket_id = 'wa-showcases');
exception when duplicate_object then null; end $$;

insert into storage.buckets (id, name, public)
values ('wa-media', 'wa-media', true)
on conflict (id) do nothing;

do $$ begin
  create policy "storage: public read wa-media"
    on storage.objects for select
    using (bucket_id = 'wa-media');
exception when duplicate_object then null; end $$;

-- ---- RLS + realtime (single-workspace: any authenticated) ----
do $$
declare t text;
begin
  foreach t in array array[
    'wa_showcases', 'prospect_scan_schedules', 'wa_coaching'
  ] loop
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
