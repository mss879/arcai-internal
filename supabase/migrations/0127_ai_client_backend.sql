-- ============================================================
-- 0127_ai_client_backend.sql
--
-- THE CLIENT BACKEND LINK: leads, tools and a dashboard on the client's
-- own site.
--
-- 0126 gave every client a hosted agent, but everything it produced landed
-- here — leads in the agency's CRM, transcripts on a page the client has no
-- login for. The person who actually wants the lead never sees it. And the
-- agent could only talk: it could not check whether Thursday at three is
-- free, look up an order, or put a booking into the client's system.
--
-- Both gaps have one cause: the CRM had no way to reach the client's own
-- backend. Since the agency builds these websites in Next.js, the client's
-- site IS that backend. So the link is deliberately narrow:
--
--   ONE origin per project, ONE shared secret, signed traffic both ways.
--
--   CRM → client   a captured lead, POSTed and signed (ai_deliveries)
--   CRM → client   the agent asking or acting, mid-conversation (ai_tools)
--   client → CRM   their own dashboard reading leads back (read_key_enc)
--
-- A client whose CRM lives somewhere else is served by their own endpoint
-- forwarding to it. That keeps one integration surface, and the agency
-- already controls the site doing the forwarding.
--
-- Additive. Idempotent. Every new column on ai_projects is nullable or
-- defaulted, so every existing project keeps working untouched.
-- ============================================================

-- 1. The connection, on the project ------------------------------------------

alter table public.ai_projects
  -- The https origin of the client's site. Tool paths and the lead webhook
  -- both hang off this, which is what makes one secret enough.
  add column if not exists backend_base_url       text,
  -- AES-256-GCM via encryptToken (src/lib/social/crypto.ts, SOCIAL_TOKEN_KEY).
  -- Signs everything we send them and verifies everything they send back.
  add column if not exists backend_secret_enc     text,
  -- The bearer key the client's SERVER uses to read leads back. Encrypted
  -- rather than hashed on purpose: the agency has to be able to reveal it
  -- again when pasting it into the client's .env.
  add column if not exists read_key_enc           text,
  -- sha256 of the same key. The ciphertext above uses a random IV, so it
  -- cannot be looked up; this is what a bearer token is matched against.
  add column if not exists read_key_hash          text,
  add column if not exists lead_delivery_enabled  boolean not null default false,
  add column if not exists lead_webhook_path      text not null default '/api/arc/lead',
  -- The result of the last "Send test", so a broken connection is visible
  -- on the tab instead of only in a log.
  add column if not exists backend_verified_at    timestamptz,
  add column if not exists backend_last_error     text,

  -- ---- Writing leads straight into the client's own Supabase -------------
  -- Some clients have a Supabase project and no endpoint to POST to. For
  -- those, a lead is inserted directly through PostgREST.
  --
  -- The key held here is the ANON key, and the client's database carries one
  -- row-level-security policy allowing an insert into the leads table and
  -- nothing else. That is the whole point: a key that can only ever add a
  -- lead is nearly harmless if it leaks, where a service-role key would be
  -- full admin on everything that client owns. A service key is deliberately
  -- NOT supported here.
  add column if not exists supabase_url            text,
  add column if not exists supabase_anon_key_enc   text,
  add column if not exists supabase_leads_table    text not null default 'leads',
  -- Their column names for our fields: {"name":"full_name","email":"email"}.
  -- A field mapped to "" or missing is simply not sent.
  add column if not exists supabase_field_map      jsonb not null default '{}',
  add column if not exists supabase_delivery_enabled boolean not null default false,
  add column if not exists supabase_verified_at    timestamptz,
  add column if not exists supabase_last_error     text,

  -- ---- The calendar the agent checks before offering a time --------------
  -- none     — the agent offers the booking link and captures the lead
  -- endpoint — the client's own site answers; their server talks to whatever
  --            calendar they actually use (Google, Outlook, their own table)
  -- cal_com  — the CRM talks to Cal.com directly with an API key
  add column if not exists calendar_provider       text not null default 'none'
                           check (calendar_provider in ('none', 'endpoint', 'cal_com')),
  add column if not exists calendar_api_key_enc    text,
  add column if not exists calendar_event_type_id  text,
  add column if not exists calendar_timezone       text not null default 'Asia/Colombo',
  -- Where the client's own site answers, when the provider is `endpoint`.
  add column if not exists calendar_availability_path text not null default '/api/arc/calendar/availability',
  add column if not exists calendar_book_path      text not null default '/api/arc/calendar/book',
  -- Overridable so a Cal.com API change can be corrected without a deploy.
  add column if not exists calendar_api_base       text,
  add column if not exists calendar_verified_at    timestamptz,
  add column if not exists calendar_last_error     text;

create unique index if not exists ai_projects_read_key_idx
  on public.ai_projects (read_key_hash) where read_key_hash is not null;

comment on column public.ai_projects.backend_base_url is
  'https origin of the client''s own site. Tool paths and lead_webhook_path are resolved against it; every outbound call is SSRF-guarded (src/lib/ai-projects/outbound.ts).';
comment on column public.ai_projects.supabase_anon_key_enc is
  'The client''s Supabase ANON key, encrypted. Least privilege on purpose: their database carries one RLS policy allowing an insert into the leads table, so this key can do nothing else. A service-role key is never stored.';

comment on column public.ai_projects.read_key_enc is
  'Bearer key for GET /api/ai/v1/* — the client''s server only. Those routes send no CORS headers, so a browser can never use this key even if it leaks into a page.';

-- 2. The safe list: what the agent may do ------------------------------------

create table if not exists public.ai_tools (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.ai_projects (id) on delete cascade,

  -- What the model calls. snake_case, unique within the project.
  name          text not null,
  -- What the VISITOR sees in the typing indicator ("Checking availability…").
  label         text not null default '',
  -- What the MODEL reads. The single most important field here: it is the
  -- whole of the model's understanding of when to reach for this tool.
  description   text not null,

  -- read  — answers a question from live data, changes nothing.
  -- write — creates or changes something, so the prompt makes the agent
  --         confirm with the visitor first and the call is capped per
  --         conversation.
  kind          text not null default 'read' check (kind in ('read', 'write')),

  method        text not null default 'POST' check (method in ('GET', 'POST')),
  -- Resolved against backend_base_url. Always starts with "/".
  path          text not null,

  -- The admin-defined field list, compiled to JSON Schema by
  -- compileToolSchema (tool-core.ts). Shape:
  --   [{ name, type: 'string'|'number'|'boolean', description,
  --      required: bool, options?: string[] }]
  parameters    jsonb not null default '[]',

  timeout_ms    integer not null default 8000
                check (timeout_ms between 1000 and 12000),
  enabled       boolean not null default true,

  -- Rolling health, written by the tool runner so a failing client endpoint
  -- shows as a number rather than something to find in a transcript.
  calls_30d     integer not null default 0,
  failures_30d  integer not null default 0,
  last_called_at timestamptz,
  last_error    text,

  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists ai_tools_name_idx on public.ai_tools (project_id, name);
create index if not exists ai_tools_project_idx on public.ai_tools (project_id) where enabled;

drop trigger if exists ai_tools_set_updated_at on public.ai_tools;
create trigger ai_tools_set_updated_at
  before update on public.ai_tools
  for each row execute function public.set_updated_at();

-- 3. Every invocation, logged ------------------------------------------------
-- Its own table rather than only ai_messages.meta: when a client's booking
-- endpoint starts failing, the agency needs to see it as a count and a
-- latency, not by reading conversations.

create table if not exists public.ai_tool_calls (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.ai_projects (id) on delete cascade,
  conversation_id   uuid references public.ai_conversations (id) on delete set null,
  tool_id           uuid references public.ai_tools (id) on delete set null,
  -- Kept even when the tool row is later deleted.
  tool_name         text not null,
  arguments         jsonb not null default '{}',
  ok                boolean not null default false,
  -- HTTP status, or null when the call never got that far (blocked, timeout).
  status            integer,
  latency_ms        integer,
  error             text,
  -- First 500 chars of what came back, for debugging without storing a page.
  response_excerpt  text,
  created_at        timestamptz not null default now()
);

create index if not exists ai_tool_calls_project_idx
  on public.ai_tool_calls (project_id, created_at desc);
create index if not exists ai_tool_calls_tool_idx
  on public.ai_tool_calls (tool_id, created_at desc);
create index if not exists ai_tool_calls_conversation_idx
  on public.ai_tool_calls (conversation_id);

-- 4. The lead push queue -----------------------------------------------------
-- A lead is delivered once, in the same request that captured it, and any
-- failure falls to the aiDeliver tick pass with backoff. The client's
-- server being down must never break a conversation.

create table if not exists public.ai_deliveries (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.ai_projects (id) on delete cascade,
  lead_id          uuid references public.ai_leads (id) on delete cascade,
  conversation_id  uuid references public.ai_conversations (id) on delete set null,
  kind             text not null default 'lead' check (kind in ('lead', 'handoff')),
  -- One row per destination: a client can have both, and a webhook that is
  -- working must not wait on a Supabase that is not.
  destination      text not null default 'webhook'
                   check (destination in ('webhook', 'supabase')),
  status           text not null default 'pending'
                   check (status in ('pending', 'sent', 'failed')),
  attempts         integer not null default 0,
  -- Backoff: 1m → 5m → 30m → 2h → 6h, then failed and shown on the Leads tab.
  next_attempt_at  timestamptz not null default now(),
  last_status      integer,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists ai_deliveries_due_idx
  on public.ai_deliveries (next_attempt_at) where status = 'pending';
create index if not exists ai_deliveries_project_idx
  on public.ai_deliveries (project_id, created_at desc);
create index if not exists ai_deliveries_lead_idx on public.ai_deliveries (lead_id);

drop trigger if exists ai_deliveries_set_updated_at on public.ai_deliveries;
create trigger ai_deliveries_set_updated_at
  before update on public.ai_deliveries
  for each row execute function public.set_updated_at();

-- 5. RLS ("RLS-lite", the same loop as 0105 and 0126) ------------------------

do $$
declare t text;
begin
  foreach t in array array['ai_tools', 'ai_tool_calls', 'ai_deliveries'] loop
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
  end loop;
end $$;

-- 6. Realtime, only where a screen watches -----------------------------------
-- Deliveries so the Backend tab's queue moves without a refresh. Tool calls
-- are deliberately left out: a busy agent would stream a row per turn into
-- every open browser.

do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.ai_deliveries';
  exception when others then null; end;
end $$;

-- 7. Audit trail for what PEOPLE change --------------------------------------
-- Same reasoning as 0126 §14: 0081 attaches this trigger from a fixed list it
-- never revisits, so a new table gets it only if its own migration does.
-- ai_tools is edited by hand; tool calls and deliveries are machine-written.

do $$
begin
  if to_regproc('public.log_member_change') is null then return; end if;
  drop trigger if exists member_changes_audit on public.ai_tools;
  create trigger member_changes_audit
    after insert or update or delete on public.ai_tools
    for each row execute function public.log_member_change();
end $$;
