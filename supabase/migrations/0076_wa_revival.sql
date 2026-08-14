-- ============================================================
-- 0076_wa_revival.sql
-- WhatsApp sales machine — Revival: re-open aged dead threads.
--
--   Cold outreach opens NEW doors; revival knocks again on doors
--   that once opened. A contact who really talked to us (they
--   sent at least one message) but has been silent past the
--   configured age gets ONE approved-template re-engagement —
--   capped per day, spaced out, quiet-hours aware, once per 90
--   days per contact, and OFF by default until the team enables
--   it and picks a Meta-approved template.
--
--   Their reply flows into the normal agent pipeline like any
--   inbound message; wa_revival only tracks that the knock
--   happened and whether it worked.
-- ============================================================

create table if not exists public.wa_revival (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.wa_contacts (id) on delete cascade,
  -- Colombo-local date the picker chose this contact (daily-cap accounting).
  picked_for    date not null,
  status        text not null default 'queued'
                check (status in ('queued', 'sent', 'replied', 'skipped', 'failed')),
  template_name text,
  template_lang text,
  wa_message_id text,
  sent_at       timestamptz,
  replied_at    timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists wa_revival_contact_idx
  on public.wa_revival (contact_id, created_at desc);
create index if not exists wa_revival_picked_idx
  on public.wa_revival (picked_for);
create index if not exists wa_revival_open_idx
  on public.wa_revival (status) where status in ('queued', 'sent');

drop trigger if exists wa_revival_set_updated_at on public.wa_revival;
create trigger wa_revival_set_updated_at
  before update on public.wa_revival
  for each row execute function public.set_updated_at();

-- ---- Config (all on the singleton row; disabled until enabled) --
alter table public.wa_agent_config
  add column if not exists revival_enabled boolean not null default false;
alter table public.wa_agent_config
  add column if not exists revival_daily_cap int not null default 3;
alter table public.wa_agent_config
  add column if not exists revival_template_name text;
alter table public.wa_agent_config
  add column if not exists revival_template_lang text not null default 'en';
alter table public.wa_agent_config
  add column if not exists revival_template_params text[] not null default '{}';
alter table public.wa_agent_config
  add column if not exists revival_min_age_days int not null default 30;

-- ---- RLS + realtime (single-workspace: any authenticated) ----
do $$
declare t text;
begin
  foreach t in array array['wa_revival'] loop
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
