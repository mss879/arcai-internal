-- ============================================================
-- 0126_ai_projects.sql
--
-- AI PROJECTS: a hosted, multi-tenant website chat agent, run from the CRM.
--
-- The agency's own website chat lives in the website repo and hands out
-- nothing; a client who wants the same agent on THEIR site would have to be
-- given the code — the prompt, the retrieval layer, the tools. This module
-- keeps all of that here. A client site gets one <script> snippet; the
-- widget it loads is served by the CRM and talks to /api/ai/*.
--
-- What lives here:
--   ai_model_prices   an editable, effective-dated catalog of what each
--                     OpenAI model costs (USD per 1M tokens). Every usage
--                     row snapshots the prices it was costed with, so a
--                     price edit never rewrites history.
--   ai_projects       one per client business: agent config, branding,
--                     limits, crawl schedule, billing terms, the public key.
--   ai_kb_sources     the knowledge base — pasted text, uploaded files,
--                     single pages, crawled pages — with the extracted text
--                     and a content hash so a re-crawl only re-embeds what
--                     changed.
--   ai_kb_chunks      pgvector embeddings of the sources, per project.
--   ai_crawl_jobs     one row per Firecrawl run; the row is the lease.
--   ai_conversations  one per visitor session; ai_messages the transcript.
--   ai_usage_events   THE LEDGER: one row per model call, never lost —
--                     tokens, the unit prices used, the cost in USD.
--   ai_project_daily / ai_model_daily  recomputed-per-day rollups.
--   ai_leads          what the agent captured for the client.
--   ai_invoices       the monthly bill: one link row per project + period,
--                     with the rate snapshot; the invoice itself is a normal
--                     `invoices` row so PDF, statement, portal and payments
--                     all work unchanged.
--
-- RLS is "RLS-lite" like every table since 0105: authenticated members read
-- and write, the public routes and the tick write with the service role.
-- Additive only. Idempotent. Requires the `vector` extension, which Supabase
-- lets a migration enable itself.
-- ============================================================

create extension if not exists vector;

-- 1. The price catalog -------------------------------------------------------

create table if not exists public.ai_model_prices (
  id                  uuid primary key default gen_random_uuid(),
  model               text not null,
  kind                text not null default 'chat'
                      check (kind in ('chat', 'embedding')),
  label               text,
  -- USD per 1,000,000 tokens. Embeddings use input_per_m only.
  input_per_m         numeric(12,6) not null default 0,
  cached_input_per_m  numeric(12,6) not null default 0,
  output_per_m        numeric(12,6) not null default 0,
  effective_from      date not null default current_date,
  effective_to        date,
  -- Selectable on the Agent tab. A retired model keeps its rows so old
  -- usage still prices; it just cannot be picked for new projects.
  is_active           boolean not null default true,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (model, effective_from)
);

create index if not exists ai_model_prices_model_idx
  on public.ai_model_prices (model, effective_from desc);

-- Official OpenAI list prices, read on 2026-09-07 from
-- developers.openai.com/api/docs/pricing. Base rows start on 2026-01-01 so
-- any usage this year resolves; gpt-5.6-sol carries its promotional price
-- through 21 Nov 2026 and its list price from the 22nd.
insert into public.ai_model_prices
  (model, kind, label, input_per_m, cached_input_per_m, output_per_m, effective_from, effective_to, note)
values
  ('gpt-5.6-sol',   'chat', 'GPT-5.6 Sol',   4.00, 0.40,  20.00, '2026-01-01', '2026-11-21', 'Promotional price through 21 Nov 2026'),
  ('gpt-5.6-sol',   'chat', 'GPT-5.6 Sol',   5.00, 0.50,  30.00, '2026-11-22', null,         'List price'),
  ('gpt-5.6-terra', 'chat', 'GPT-5.6 Terra', 2.00, 0.20,  12.00, '2026-01-01', null, null),
  ('gpt-5.6-luna',  'chat', 'GPT-5.6 Luna',  0.20, 0.02,   1.20, '2026-01-01', null, null),
  ('gpt-5.5',       'chat', 'GPT-5.5',       5.00, 0.50,  30.00, '2026-01-01', null, null),
  ('gpt-5.4',       'chat', 'GPT-5.4',       2.50, 0.25,  15.00, '2026-01-01', null, null),
  ('gpt-5.4-mini',  'chat', 'GPT-5.4 mini',  0.75, 0.075,  4.50, '2026-01-01', null, null),
  ('gpt-5.4-nano',  'chat', 'GPT-5.4 nano',  0.20, 0.02,   1.25, '2026-01-01', null, null),
  ('gpt-5',         'chat', 'GPT-5',         1.25, 0.125, 10.00, '2026-01-01', null, null),
  ('gpt-5-mini',    'chat', 'GPT-5 mini',    0.25, 0.025,  2.00, '2026-01-01', null, null),
  ('gpt-5-nano',    'chat', 'GPT-5 nano',    0.05, 0.005,  0.40, '2026-01-01', null, null),
  ('gpt-4.1',       'chat', 'GPT-4.1',       2.00, 0.50,   8.00, '2026-01-01', null, null),
  ('gpt-4.1-mini',  'chat', 'GPT-4.1 mini',  0.40, 0.10,   1.60, '2026-01-01', null, null),
  ('gpt-4.1-nano',  'chat', 'GPT-4.1 nano',  0.10, 0.025,  0.40, '2026-01-01', null, null),
  ('gpt-4o',        'chat', 'GPT-4o',        2.50, 1.25,  10.00, '2026-01-01', null, null),
  ('gpt-4o-mini',   'chat', 'GPT-4o mini',   0.15, 0.075,  0.60, '2026-01-01', null, null),
  ('text-embedding-3-small', 'embedding', 'Embedding 3 small', 0.02, 0, 0, '2026-01-01', null, null),
  ('text-embedding-3-large', 'embedding', 'Embedding 3 large', 0.13, 0, 0, '2026-01-01', null, null)
on conflict (model, effective_from) do nothing;

-- 2. Projects ----------------------------------------------------------------

create table if not exists public.ai_projects (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  client_id             uuid references public.clients (id) on delete set null,
  website_url           text,
  -- draft: being set up, served only in the CRM preview. active: live.
  -- paused: the widget hides itself. archived: gone from lists, kept for
  -- the ledger (usage rows reference the project with `restrict`).
  status                text not null default 'draft'
                        check (status in ('draft', 'active', 'paused', 'archived')),
  -- What the snippet carries. Identifies the project; the origin list is
  -- the gate. Rotating it means the client updates their snippet.
  public_key            text not null unique,
  allowed_origins       text[] not null default '{}'::text[],

  -- ---- The agent ----
  agent_name            text not null default 'Assistant',
  system_prompt         text not null default '',
  model                 text not null default 'gpt-5.6-luna',
  temperature           numeric(3,2) not null default 0.4,
  reasoning_effort      text not null default 'low'
                        check (reasoning_effort in ('minimal', 'low', 'medium', 'high', 'xhigh')),
  welcome_message       text,
  suggested_questions   text[] not null default '{}'::text[],
  avatar_url            text,
  primary_color         text not null default '#f97316',
  user_bubble_color     text,
  agent_bubble_color    text,
  widget_position       text not null default 'right'
                        check (widget_position in ('left', 'right')),
  show_branding         boolean not null default true,
  booking_url           text,
  -- Where captured leads and hand-off transcripts are emailed.
  notification_email    text,
  lead_capture_enabled  boolean not null default true,
  booking_enabled       boolean not null default false,
  handoff_enabled       boolean not null default true,

  -- ---- Limits ----
  -- Per visitor session, per minute.
  rate_limit_per_minute integer not null default 10,
  -- Per project, per Colombo day: the cost circuit breaker. A forged
  -- Origin cannot spend more than this many replies' worth.
  daily_message_cap     integer not null default 2000,

  -- ---- Website crawl ----
  crawl_interval_days   integer check (crawl_interval_days in (7, 14)),
  crawl_limit           integer not null default 150,
  next_crawl_at         timestamptz,
  last_crawl_at         timestamptz,

  -- ---- Billing ----
  billing_enabled       boolean not null default true,
  billing_currency      text not null default 'USD'
                        check (billing_currency in ('USD', 'LKR')),
  monthly_fee           numeric(12,2) not null default 0,
  -- Multiplier on the exact provider cost. 1.0 = pass-through.
  usage_markup          numeric(6,3) not null default 1.0,
  monthly_minimum       numeric(12,2) not null default 0,
  -- Only read for LKR projects; snapshotted onto every invoice.
  fx_lkr_per_usd        numeric(12,4),
  invoice_mode          text not null default 'draft'
                        check (invoice_mode in ('draft', 'auto_send')),
  billing_from          date not null default current_date,

  created_by            uuid references public.profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists ai_projects_client_idx on public.ai_projects (client_id);
create index if not exists ai_projects_status_idx on public.ai_projects (status);

drop trigger if exists ai_projects_set_updated_at on public.ai_projects;
create trigger ai_projects_set_updated_at
  before update on public.ai_projects
  for each row execute function public.set_updated_at();

-- 3. Crawl jobs (before sources, which reference them) ----------------------

create table if not exists public.ai_crawl_jobs (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.ai_projects (id) on delete cascade,
  status            text not null default 'queued'
                    check (status in ('queued', 'starting', 'crawling', 'ingesting',
                                      'finalising', 'completed', 'failed', 'cancelled')),
  triggered_by      text not null default 'manual'
                    check (triggered_by in ('schedule', 'manual')),
  firecrawl_id      text,
  -- Firecrawl's pagination cursor: the full `next` URL of the last page read.
  next_url          text,
  total             integer,
  completed         integer,
  pages_seen        integer not null default 0,
  pages_changed     integer not null default 0,
  pages_unchanged   integer not null default 0,
  pages_stale       integer not null default 0,
  chunks_written    integer not null default 0,
  embedding_tokens  integer not null default 0,
  steps             integer not null default 0,
  -- Bumped before every step, reset after; three in a row means the platform
  -- keeps killing the step and the phase is abandoned (see job-core).
  killed            integer not null default 0,
  -- The lease: compare-and-set on `version`, held until `lease_until`.
  version           integer not null default 0,
  lease_until       timestamptz,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  error             text,
  errors            jsonb not null default '[]',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists ai_crawl_jobs_project_idx
  on public.ai_crawl_jobs (project_id, created_at desc);
create index if not exists ai_crawl_jobs_active_idx
  on public.ai_crawl_jobs (project_id)
  where status in ('queued', 'starting', 'crawling', 'ingesting', 'finalising');

drop trigger if exists ai_crawl_jobs_set_updated_at on public.ai_crawl_jobs;
create trigger ai_crawl_jobs_set_updated_at
  before update on public.ai_crawl_jobs
  for each row execute function public.set_updated_at();

-- 4. Knowledge base ----------------------------------------------------------

create table if not exists public.ai_kb_sources (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.ai_projects (id) on delete cascade,
  source_kind       text not null
                    check (source_kind in ('text', 'file', 'url', 'crawl')),
  title             text not null,
  url               text,
  -- Object path in the private `ai-knowledge` bucket, for files.
  file_path         text,
  mime              text,
  size_bytes        integer,
  -- The extracted text. Kept so a source can be re-chunked without
  -- re-downloading or re-scraping it.
  content           text,
  -- sha256 of the whitespace-normalised text. A re-crawl that finds the
  -- same hash touches `last_seen_at` and nothing else — no embedding spend.
  content_hash      text,
  status            text not null default 'pending'
                    check (status in ('pending', 'processing', 'ready', 'failed', 'stale')),
  attempts          integer not null default 0,
  error             text,
  chunk_count       integer not null default 0,
  embedding_tokens  integer not null default 0,
  crawl_job_id      uuid references public.ai_crawl_jobs (id) on delete set null,
  last_seen_at      timestamptz,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One row per page per project: a re-crawl upserts by URL.
create unique index if not exists ai_kb_sources_url_idx
  on public.ai_kb_sources (project_id, url) where url is not null;
create index if not exists ai_kb_sources_status_idx
  on public.ai_kb_sources (project_id, status);
create index if not exists ai_kb_sources_pending_idx
  on public.ai_kb_sources (created_at) where status = 'pending';

drop trigger if exists ai_kb_sources_set_updated_at on public.ai_kb_sources;
create trigger ai_kb_sources_set_updated_at
  before update on public.ai_kb_sources
  for each row execute function public.set_updated_at();

create table if not exists public.ai_kb_chunks (
  id              uuid primary key default gen_random_uuid(),
  -- Denormalised from the source so the match RPC filters without a join.
  project_id      uuid not null references public.ai_projects (id) on delete cascade,
  source_id       uuid not null references public.ai_kb_sources (id) on delete cascade,
  position        integer not null default 0,
  content         text not null,
  token_estimate  integer not null default 0,
  -- text-embedding-3-small: 1536 dimensions.
  embedding       vector(1536) not null,
  created_at      timestamptz not null default now()
);

create index if not exists ai_kb_chunks_embedding_idx
  on public.ai_kb_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
create index if not exists ai_kb_chunks_project_idx on public.ai_kb_chunks (project_id);
create index if not exists ai_kb_chunks_source_idx on public.ai_kb_chunks (source_id);

-- Retrieval: the nearest ready chunks of ONE project. The website's
-- match_knowledge_chunks had no tenant filter; this one is the same shape
-- with the filter it lacked.
create or replace function public.match_ai_chunks(
  p_project_id    uuid,
  query_embedding vector(1536),
  match_threshold float default 0.25,
  match_count     int default 8
)
returns table (
  id         uuid,
  source_id  uuid,
  title      text,
  url        text,
  content    text,
  similarity float
)
language sql stable
set search_path = public
as $$
  select
    c.id,
    c.source_id,
    s.title,
    s.url,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.ai_kb_chunks c
  join public.ai_kb_sources s on s.id = c.source_id
  where c.project_id = p_project_id
    and s.status = 'ready'
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- 5. Conversations -----------------------------------------------------------

create table if not exists public.ai_conversations (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.ai_projects (id) on delete cascade,
  -- Minted by the widget, kept in the visitor's localStorage.
  session_key           text not null,
  visitor_id            text,
  started_at            timestamptz not null default now(),
  last_message_at       timestamptz not null default now(),
  message_count         integer not null default 0,
  user_messages         integer not null default 0,
  assistant_messages    integer not null default 0,
  page_url              text,
  page_title            text,
  referrer              text,
  user_agent            text,
  ip_hash               text,
  country               text,
  -- FK added below, once ai_leads exists.
  lead_id               uuid,
  handoff_requested_at  timestamptz,
  handoff_summary       text,
  handoff_notified_at   timestamptz,
  booking_offered_at    timestamptz,
  total_cost_usd        numeric(12,6) not null default 0,
  total_tokens          integer not null default 0,
  -- Preview traffic from the CRM's own Deploy tab.
  is_preview            boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists ai_conversations_session_idx
  on public.ai_conversations (project_id, session_key);
create index if not exists ai_conversations_recent_idx
  on public.ai_conversations (project_id, last_message_at desc);

drop trigger if exists ai_conversations_set_updated_at on public.ai_conversations;
create trigger ai_conversations_set_updated_at
  before update on public.ai_conversations
  for each row execute function public.set_updated_at();

create table if not exists public.ai_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.ai_conversations (id) on delete cascade,
  project_id       uuid not null references public.ai_projects (id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'tool')),
  content          text not null default '',
  tool_name        text,
  meta             jsonb not null default '{}',
  created_at       timestamptz not null default now()
);

create index if not exists ai_messages_conversation_idx
  on public.ai_messages (conversation_id, created_at);
-- The daily cap counts a project's user messages since midnight.
create index if not exists ai_messages_project_idx
  on public.ai_messages (project_id, created_at);

-- 6. The usage ledger --------------------------------------------------------

create table if not exists public.ai_usage_events (
  id                   uuid primary key default gen_random_uuid(),
  -- restrict: a project with usage is archived, never deleted.
  project_id           uuid not null references public.ai_projects (id) on delete restrict,
  conversation_id      uuid references public.ai_conversations (id) on delete set null,
  message_id           uuid references public.ai_messages (id) on delete set null,
  kind                 text not null check (kind in ('chat', 'embedding', 'vision')),
  purpose              text not null
                       check (purpose in ('reply', 'retrieval', 'ingest', 'describe')),
  model                text not null,
  -- prompt_tokens as the API reports it — it INCLUDES cached_input_tokens.
  input_tokens         integer not null default 0,
  cached_input_tokens  integer not null default 0,
  output_tokens        integer not null default 0,
  -- The unit prices this row was costed with (USD per 1M).
  input_price_per_m    numeric(12,6),
  cached_price_per_m   numeric(12,6),
  output_price_per_m   numeric(12,6),
  price_row_id         uuid references public.ai_model_prices (id) on delete set null,
  cost_usd             numeric(12,6) not null default 0,
  -- false for the CRM's own preview traffic: shown, never billed.
  billable             boolean not null default true,
  -- partial: the call was cut off before the API reported usage, so the
  -- tokens are an estimate (chars / 4) rather than a count.
  status               text not null default 'complete'
                       check (status in ('complete', 'partial')),
  -- Asia/Colombo calendar day and month, so the daily rollup and the monthly
  -- bill are plain equality filters.
  day                  date not null,
  period               date not null,
  latency_ms           integer,
  error                text,
  created_at           timestamptz not null default now()
);

create index if not exists ai_usage_events_period_idx
  on public.ai_usage_events (project_id, period);
create index if not exists ai_usage_events_day_idx
  on public.ai_usage_events (project_id, day);
create index if not exists ai_usage_events_conversation_idx
  on public.ai_usage_events (conversation_id);

-- 7. Rollups -----------------------------------------------------------------

create table if not exists public.ai_project_daily (
  project_id           uuid not null references public.ai_projects (id) on delete cascade,
  day                  date not null,
  conversations        integer not null default 0,
  user_messages        integer not null default 0,
  assistant_messages   integer not null default 0,
  chat_calls           integer not null default 0,
  embedding_calls      integer not null default 0,
  input_tokens         bigint not null default 0,
  cached_input_tokens  bigint not null default 0,
  output_tokens        bigint not null default 0,
  embedding_tokens     bigint not null default 0,
  cost_usd             numeric(14,6) not null default 0,
  leads                integer not null default 0,
  handoffs             integer not null default 0,
  computed_at          timestamptz not null default now(),
  primary key (project_id, day)
);

create table if not exists public.ai_model_daily (
  project_id           uuid not null references public.ai_projects (id) on delete cascade,
  day                  date not null,
  model                text not null,
  calls                integer not null default 0,
  input_tokens         bigint not null default 0,
  cached_input_tokens  bigint not null default 0,
  output_tokens        bigint not null default 0,
  cost_usd             numeric(14,6) not null default 0,
  computed_at          timestamptz not null default now(),
  primary key (project_id, day, model)
);

-- 8. Leads -------------------------------------------------------------------

create table if not exists public.ai_leads (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.ai_projects (id) on delete cascade,
  conversation_id  uuid references public.ai_conversations (id) on delete set null,
  name             text,
  email            text,
  phone            text,
  company          text,
  -- What they wanted, in the model's words.
  interest         text,
  page_url         text,
  status           text not null default 'new'
                   check (status in ('new', 'contacted', 'archived')),
  notified_at      timestamptz,
  notify_error     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One lead per conversation: a second capture_lead call updates it.
create unique index if not exists ai_leads_conversation_idx
  on public.ai_leads (conversation_id) where conversation_id is not null;
create index if not exists ai_leads_project_idx
  on public.ai_leads (project_id, created_at desc);

drop trigger if exists ai_leads_set_updated_at on public.ai_leads;
create trigger ai_leads_set_updated_at
  before update on public.ai_leads
  for each row execute function public.set_updated_at();

do $$
begin
  alter table public.ai_conversations
    add constraint ai_conversations_lead_id_fkey
    foreign key (lead_id) references public.ai_leads (id) on delete set null;
exception when duplicate_object then null;
end $$;

-- 9. The monthly bill --------------------------------------------------------

create table if not exists public.ai_invoices (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.ai_projects (id) on delete restrict,
  invoice_id       uuid references public.invoices (id) on delete set null,
  -- The first day of the billed month (Asia/Colombo).
  period           date not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'created', 'skipped_zero', 'failed')),
  attempts         integer not null default 0,
  error            text,
  -- The snapshot: what the month cost, and the terms it was billed on.
  usage_cost_usd   numeric(12,6) not null default 0,
  markup           numeric(6,3),
  fee              numeric(12,2),
  minimum          numeric(12,2),
  currency         text,
  fx_lkr_per_usd   numeric(12,4),
  total            numeric(12,2),
  tokens           jsonb not null default '{}',
  model_breakdown  jsonb not null default '[]',
  mode             text,
  emailed          boolean not null default false,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- The idempotency key: one bill per project per month.
  unique (project_id, period)
);

drop trigger if exists ai_invoices_set_updated_at on public.ai_invoices;
create trigger ai_invoices_set_updated_at
  before update on public.ai_invoices
  for each row execute function public.set_updated_at();

-- 10. The daily rollup, as one recompute -----------------------------------
-- Delete-and-reinsert both rows for one project-day, from the ledger and the
-- transcripts. Race-free by construction: two callers produce the same
-- rows. Called after every chat turn and by the aiRollup tick pass.

create or replace function public.ai_usage_rollup_day(p_project_id uuid, p_day date)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_start timestamptz := (p_day::timestamp at time zone 'Asia/Colombo');
  v_end   timestamptz := ((p_day + 1)::timestamp at time zone 'Asia/Colombo');
begin
  delete from public.ai_project_daily where project_id = p_project_id and day = p_day;
  insert into public.ai_project_daily (
    project_id, day, conversations, user_messages, assistant_messages,
    chat_calls, embedding_calls, input_tokens, cached_input_tokens, output_tokens,
    embedding_tokens, cost_usd, leads, handoffs, computed_at
  )
  select
    p_project_id,
    p_day,
    (select count(*) from public.ai_conversations c
      where c.project_id = p_project_id and not c.is_preview
        and c.started_at >= v_start and c.started_at < v_end),
    (select count(*) from public.ai_messages m
      join public.ai_conversations c on c.id = m.conversation_id
      where m.project_id = p_project_id and not c.is_preview and m.role = 'user'
        and m.created_at >= v_start and m.created_at < v_end),
    (select count(*) from public.ai_messages m
      join public.ai_conversations c on c.id = m.conversation_id
      where m.project_id = p_project_id and not c.is_preview and m.role = 'assistant'
        and m.created_at >= v_start and m.created_at < v_end),
    coalesce(sum(case when u.kind = 'chat' then 1 else 0 end), 0),
    coalesce(sum(case when u.kind = 'embedding' then 1 else 0 end), 0),
    coalesce(sum(case when u.kind <> 'embedding' then u.input_tokens else 0 end), 0),
    coalesce(sum(u.cached_input_tokens), 0),
    coalesce(sum(u.output_tokens), 0),
    coalesce(sum(case when u.kind = 'embedding' then u.input_tokens else 0 end), 0),
    coalesce(sum(u.cost_usd), 0),
    (select count(*) from public.ai_leads l
      where l.project_id = p_project_id
        and l.created_at >= v_start and l.created_at < v_end),
    (select count(*) from public.ai_conversations c
      where c.project_id = p_project_id
        and c.handoff_requested_at >= v_start and c.handoff_requested_at < v_end),
    now()
  from public.ai_usage_events u
  where u.project_id = p_project_id and u.day = p_day and u.billable;

  delete from public.ai_model_daily where project_id = p_project_id and day = p_day;
  insert into public.ai_model_daily (
    project_id, day, model, calls, input_tokens, cached_input_tokens, output_tokens, cost_usd, computed_at
  )
  select
    p_project_id, p_day, u.model, count(*),
    coalesce(sum(u.input_tokens), 0),
    coalesce(sum(u.cached_input_tokens), 0),
    coalesce(sum(u.output_tokens), 0),
    coalesce(sum(u.cost_usd), 0),
    now()
  from public.ai_usage_events u
  where u.project_id = p_project_id and u.day = p_day and u.billable
  group by u.model;
end $$;

-- 11. Storage ----------------------------------------------------------------
-- Private: a client's uploaded documents are theirs. Signed URLs only; the
-- server actions upload through the service-role client.

insert into storage.buckets (id, name, public)
values ('ai-knowledge', 'ai-knowledge', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage: auth read ai-knowledge'
  ) then
    create policy "storage: auth read ai-knowledge"
      on storage.objects for select to authenticated
      using (bucket_id = 'ai-knowledge');
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage: auth insert ai-knowledge'
  ) then
    create policy "storage: auth insert ai-knowledge"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'ai-knowledge');
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage: auth delete ai-knowledge'
  ) then
    create policy "storage: auth delete ai-knowledge"
      on storage.objects for delete to authenticated
      using (bucket_id = 'ai-knowledge');
  end if;
end $$;

-- 12. RLS ("RLS-lite", same loop as 0105) ------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'ai_model_prices', 'ai_projects', 'ai_crawl_jobs', 'ai_kb_sources',
    'ai_kb_chunks', 'ai_conversations', 'ai_messages', 'ai_usage_events',
    'ai_project_daily', 'ai_model_daily', 'ai_leads', 'ai_invoices'
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
  end loop;
end $$;

-- 13. Realtime, only where a screen watches a job -----------------------------

do $$
declare t text;
begin
  foreach t in array array['ai_crawl_jobs', 'ai_kb_sources', 'ai_conversations', 'ai_leads'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then null; end;
  end loop;
end $$;

-- 14. Audit trail for what PEOPLE change ------------------------------------
-- 0081 attaches `member_changes_audit` to a fixed list and never revisits it,
-- so a new table gets the trigger only if its own migration attaches it. The
-- machine-written tables (chunks, messages, usage, rollups) are left out on
-- purpose: nobody edits them, and logging every chat turn would drown the
-- Team page's activity feed.

do $$
declare t text;
begin
  if to_regproc('public.log_member_change') is null then return; end if;
  foreach t in array array['ai_projects', 'ai_model_prices', 'ai_kb_sources', 'ai_leads', 'ai_invoices'] loop
    execute format('drop trigger if exists member_changes_audit on public.%I', t);
    execute format(
      'create trigger member_changes_audit after insert or update or delete on public.%I for each row execute function public.log_member_change()',
      t
    );
  end loop;
end $$;
