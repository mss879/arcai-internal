-- ============================================================
-- 0030_crm_core.sql
-- CRM core upgrade — the "bulletproof CRM" layer:
--
--   companies        : organizations contacts/leads group under (B2B)
--   crm_fields       : custom field definitions (per-industry data);
--                      values live on leads.custom (jsonb)
--   crm_segments     : saved smart filters ("FB leads, no reply in 7d")
--   lead_activities  : full timeline per lead — notes, calls, emails,
--                      stage changes, field changes (change history),
--                      automations, merges, restores
--   crm_tasks        : follow-ups with due dates / "my day" / overdue
--
-- leads gains: tags[], custom jsonb, source, company_id, deleted_at
-- (trash/restore) and last_activity_at (stale detection).
--
-- Change history is written by a DB trigger so every write path
-- (UI, AI assistant, API, automations) is captured.
-- ============================================================

-- ---- Companies ----------------------------------------------
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  website     text,
  email       text,
  phone       text,
  city        text,
  industry    text,
  notes       text,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists companies_name_idx on public.companies (name);

drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

-- ---- Custom field definitions -------------------------------
create table if not exists public.crm_fields (
  id          uuid primary key default gen_random_uuid(),
  -- Storage key inside leads.custom, e.g. "vehicle_number".
  key         text not null unique,
  label       text not null,
  kind        text not null default 'text'
              check (kind in ('text', 'number', 'date', 'select', 'checkbox', 'url', 'phone')),
  -- Options for kind = 'select'.
  options     text[] not null default '{}',
  required    boolean not null default false,
  position    integer not null default 0,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

-- ---- Saved smart segments -----------------------------------
create table if not exists public.crm_segments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- Filter definition, evaluated app-side. Shape:
  -- { pipeline_id?, stage_ids?, tags_any?, source?, assigned_to?,
  --   value_min?, value_max?, no_activity_days?, created_within_days?,
  --   status?, score? }
  filters     jsonb not null default '{}',
  position    integer not null default 0,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

-- ---- Lead columns -------------------------------------------
alter table public.leads add column if not exists tags text[] not null default '{}';
alter table public.leads add column if not exists custom jsonb not null default '{}';
alter table public.leads add column if not exists source text not null default 'manual';
alter table public.leads add column if not exists company_id uuid references public.companies (id) on delete set null;
alter table public.leads add column if not exists deleted_at timestamptz;
alter table public.leads add column if not exists last_activity_at timestamptz not null default now();

create index if not exists leads_tags_idx on public.leads using gin (tags);
create index if not exists leads_company_idx on public.leads (company_id);
create index if not exists leads_deleted_idx on public.leads (deleted_at);

-- ---- Activity timeline (also the change history) ------------
create table if not exists public.lead_activities (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads (id) on delete cascade,
  kind        text not null default 'note'
              check (kind in (
                'created', 'note', 'call', 'email', 'sms', 'meeting',
                'stage_changed', 'field_changed', 'status_changed',
                'task', 'quote', 'merged', 'restored', 'automation', 'score'
              )),
  title       text not null default '',
  body        text,
  -- Extra structured detail, e.g. { field, old, new } for field_changed.
  meta        jsonb not null default '{}',
  actor_id    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists lead_activities_lead_idx
  on public.lead_activities (lead_id, created_at desc);

-- Any activity bumps the lead's last_activity_at (drives staleness).
create or replace function public.touch_lead_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.leads set last_activity_at = now() where id = new.lead_id;
  return new;
end;
$$;

drop trigger if exists lead_activities_touch on public.lead_activities;
create trigger lead_activities_touch
  after insert on public.lead_activities
  for each row execute function public.touch_lead_activity();

-- Change history: log creation, stage moves and edits of tracked fields.
-- Uses to_jsonb so it stays valid as later migrations add columns.
create or replace function public.log_lead_changes()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  tracked text[] := array[
    'title', 'company', 'contact_name', 'contact_email', 'contact_phone',
    'value', 'currency', 'notes', 'assigned_to', 'client_id', 'company_id',
    'source', 'tags', 'custom', 'status', 'expected_close_date',
    'probability', 'score'
  ];
  o jsonb; n jsonb; f text;
begin
  if tg_op = 'INSERT' then
    insert into public.lead_activities (lead_id, kind, title, meta, actor_id)
    values (new.id, 'created', 'Lead created',
            jsonb_build_object('source', new.source), new.created_by);
    return new;
  end if;

  o := to_jsonb(old);
  n := to_jsonb(new);

  if new.stage_id is distinct from old.stage_id then
    insert into public.lead_activities (lead_id, kind, title, meta)
    values (new.id, 'stage_changed', 'Stage changed',
            jsonb_build_object('old', old.stage_id, 'new', new.stage_id));
  end if;

  -- Trash / restore.
  if (o ? 'deleted_at') and (n -> 'deleted_at') is distinct from (o -> 'deleted_at') then
    if n ->> 'deleted_at' is null then
      insert into public.lead_activities (lead_id, kind, title)
      values (new.id, 'restored', 'Restored from trash');
    end if;
  end if;

  foreach f in array tracked loop
    if (n ? f) and (n -> f) is distinct from (o -> f) then
      insert into public.lead_activities (lead_id, kind, title, meta)
      values (new.id, 'field_changed', 'Updated ' || replace(f, '_', ' '),
              jsonb_build_object('field', f, 'old', o -> f, 'new', n -> f));
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists leads_log_changes on public.leads;
create trigger leads_log_changes
  after insert or update on public.leads
  for each row execute function public.log_lead_changes();

-- ---- Follow-up tasks ----------------------------------------
create table if not exists public.crm_tasks (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid references public.leads (id) on delete cascade,
  company_id    uuid references public.companies (id) on delete cascade,
  title         text not null,
  notes         text,
  due_at        timestamptz,
  assigned_to   uuid references public.profiles (id) on delete set null,
  status        text not null default 'open' check (status in ('open', 'done')),
  completed_at  timestamptz,
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now()
);

create index if not exists crm_tasks_due_idx on public.crm_tasks (status, due_at);
create index if not exists crm_tasks_lead_idx on public.crm_tasks (lead_id);

-- ---- RLS + realtime (single-workspace: any authenticated) ---
do $$
declare t text;
begin
  foreach t in array array[
    'companies', 'crm_fields', 'crm_segments', 'lead_activities', 'crm_tasks'
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
