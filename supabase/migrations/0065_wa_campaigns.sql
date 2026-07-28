-- ============================================================
-- 0065_wa_campaigns.sql
-- Campaign mode for the WhatsApp agent.
--
-- Meta ads (Click-to-WhatsApp) now point straight at the agent's
-- number, so ad taps arrive as normal inbound chats. The agent
-- still had no idea WHAT was being advertised — it ran generic
-- discovery at someone who just tapped a specific offer.
--
-- A campaign is two things the team gives us: the ad image and
-- one box of service info. Both ride ON TOP of the agent's
-- existing knowledge base (like wa_agent_config.knowledge does),
-- never replacing it.
--
-- Campaigns accumulate as a library for reuse; exactly one may be
-- 'active' at a time (partial unique index below) so the prompt
-- is never ambiguous about which offer is live.
-- ============================================================

create table if not exists public.wa_campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  status        text not null default 'draft'
                check (status in ('draft', 'active', 'paused', 'ended')),
  -- The ad creative the customer just tapped.
  image_url     text,
  image_path    text,
  -- What the vision pass read off that image. The agent loop is
  -- text-only, so this is the only way it can "see" the creative.
  image_summary text,
  -- The one box: everything the agent should know about the offer.
  details       text not null default '',
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Only one campaign may be live at a time.
create unique index if not exists wa_campaigns_one_active
  on public.wa_campaigns (status)
  where status = 'active';

create index if not exists wa_campaigns_created_idx
  on public.wa_campaigns (created_at desc);

drop trigger if exists wa_campaigns_set_updated_at on public.wa_campaigns;
create trigger wa_campaigns_set_updated_at
  before update on public.wa_campaigns
  for each row execute function public.set_updated_at();

-- ---- Agent config: the master on/off switch -------------------
alter table public.wa_agent_config
  add column if not exists campaign_mode_enabled boolean not null default false;

-- ---- Which campaign was live when this contact first wrote ----
-- Stamped once, on contact creation. Powers "this campaign
-- brought N leads" without denormalising a counter.
alter table public.wa_contacts
  add column if not exists campaign_id uuid
    references public.wa_campaigns (id) on delete set null;

create index if not exists wa_contacts_campaign_idx
  on public.wa_contacts (campaign_id);

-- ---- Storage bucket: ad creatives -----------------------------
insert into storage.buckets (id, name, public)
values ('wa-campaigns', 'wa-campaigns', true)
on conflict (id) do nothing;

do $$ begin
  create policy "storage: public read wa-campaigns"
    on storage.objects for select
    using (bucket_id = 'wa-campaigns');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "storage: auth insert wa-campaigns"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'wa-campaigns');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "storage: auth update wa-campaigns"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'wa-campaigns')
    with check (bucket_id = 'wa-campaigns');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "storage: auth delete wa-campaigns"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'wa-campaigns');
exception when duplicate_object then null; end $$;

-- ---- RLS + realtime (single-workspace: any authenticated) ----
do $$
declare t text;
begin
  foreach t in array array['wa_campaigns'] loop
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
