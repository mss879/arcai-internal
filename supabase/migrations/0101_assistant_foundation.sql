-- ============================================================
-- 0101_assistant_foundation.sql
--
-- ARCUS FOUNDATION — server-side memory for the in-app copilot.
--
-- Until now Arc Studio's conversations lived only in each
-- browser's localStorage: close the laptop, lose the thread.
-- This migration gives the assistant a real spine:
--
--   • ASSISTANT_THREADS / ASSISTANT_MESSAGES — every
--     conversation, synced across devices. The browser keeps
--     its localStorage copy as a cache and offline fallback;
--     the server copy is authoritative. Ids are TEXT because
--     the client already mints stable ids ("thread-…", "m-…")
--     and keeping them makes the merge a lossless union.
--     deleted_at is a tombstone: a thread deleted on one device
--     must not be resurrected by another device's stale cache.
--
--   • ASSISTANT_MEMORIES — what Arcus remembers about how the
--     user runs the business. Two sources with two rules:
--     'user' rows (the user said "remember…") are active at
--     once; 'mined' rows (extracted overnight from
--     conversations) sit at 'pending' until a human approves
--     them — the same approve-first gate the WhatsApp agent's
--     lessons use, and the reason a poisoned conversation
--     cannot write itself into the prompt.
--
--   • ASSISTANT_CONFIG — one row per member: persona, voice,
--     briefing window, quiet hours, nudge budget, plus the
--     claim stamps (CAS columns) the tick uses so once-a-day
--     work happens exactly once however many ticks race.
--
-- Everything is OWN-ROWS-ONLY under RLS: a transcript is
-- personal, unlike workspace data. The tick's service-role
-- client bypasses RLS by design (0032 precedent) for the
-- miner/briefing writers.
-- ============================================================

-- 1. Threads --------------------------------------------------
create table if not exists public.assistant_threads (
  id         text primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text not null default 'New chat',
  kind       text not null default 'chat'
             check (kind in ('chat', 'briefing', 'mission')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists assistant_threads_user_idx
  on public.assistant_threads (user_id, updated_at desc);

create table if not exists public.assistant_messages (
  id        text primary key,
  thread_id text not null references public.assistant_threads (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  role      text not null check (role in ('user', 'assistant')),
  content   text not null default '',
  -- Epoch milliseconds, exactly the client's AssistantMessage.at — the merge
  -- sorts on it, so it is stored verbatim rather than converted.
  at        bigint not null,
  -- {events, cards, artifacts, steps, error} — the message's UI payload,
  -- already sanitised client-side. Capped by the API, not the schema.
  payload   jsonb not null default '{}'::jsonb
);

create index if not exists assistant_messages_thread_idx
  on public.assistant_messages (thread_id, at);

-- 2. Memories -------------------------------------------------
create table if not exists public.assistant_memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('instruction', 'preference', 'fact')),
  content    text not null,
  source     text not null default 'user'   check (source in ('user', 'mined')),
  status     text not null default 'active'
             check (status in ('active', 'pending', 'rejected', 'archived')),
  -- Mined rows keep their provenance: {thread_id, quote} — the sentence that
  -- justified the memory, shown at approval time.
  evidence   jsonb not null default '{}'::jsonb,
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_memories_active_idx
  on public.assistant_memories (user_id, status, updated_at desc);

-- 3. Per-member config + CAS stamps ---------------------------
create table if not exists public.assistant_config (
  user_id          uuid primary key references public.profiles (id) on delete cascade,
  persona_name     text not null default 'Arcus',
  tone             text not null default 'warm and direct',
  verbosity        text not null default 'normal'
                   check (verbosity in ('brief', 'normal', 'detailed')),
  -- Free-text steering for the TTS voice (gpt-4o-mini-tts `instructions`).
  voice_style      text not null default '',
  hands_free       boolean not null default false,
  wake_word        boolean not null default false,
  timezone         text not null default 'Asia/Colombo',
  briefing_enabled boolean not null default true,
  briefing_time    text not null default '08:30',
  quiet_start      text not null default '21:30',
  quiet_end        text not null default '07:30',
  nudges_per_day   int  not null default 3,
  -- Claim stamps (processAgentDigest CAS pattern, wa-insights 0074):
  -- a conditional update on these is how exactly one tick wins a day.
  briefing_sent_for       date,
  briefing_job_id         text,
  briefing_job_started_at timestamptz,
  memories_mined_for      date,
  nudges_sent_on          date,
  nudge_count             int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. updated_at triggers (shared set_updated_at from 0001) ----
drop trigger if exists assistant_threads_set_updated_at on public.assistant_threads;
create trigger assistant_threads_set_updated_at
  before update on public.assistant_threads
  for each row execute function public.set_updated_at();

drop trigger if exists assistant_memories_set_updated_at on public.assistant_memories;
create trigger assistant_memories_set_updated_at
  before update on public.assistant_memories
  for each row execute function public.set_updated_at();

drop trigger if exists assistant_config_set_updated_at on public.assistant_config;
create trigger assistant_config_set_updated_at
  before update on public.assistant_config
  for each row execute function public.set_updated_at();

-- 5. RLS — own rows only --------------------------------------
alter table public.assistant_threads  enable row level security;
alter table public.assistant_messages enable row level security;
alter table public.assistant_memories enable row level security;
alter table public.assistant_config   enable row level security;

drop policy if exists "assistant_threads_own" on public.assistant_threads;
create policy "assistant_threads_own" on public.assistant_threads
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "assistant_messages_own" on public.assistant_messages;
create policy "assistant_messages_own" on public.assistant_messages
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "assistant_memories_own" on public.assistant_memories;
create policy "assistant_memories_own" on public.assistant_memories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "assistant_config_own" on public.assistant_config;
create policy "assistant_config_own" on public.assistant_config
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 6. Realtime (0021 guard pattern) ----------------------------
-- A briefing inserted by the tick, or a conversation continued on the phone,
-- must appear in an open Studio without a reload.
do $$
declare
  t text;
begin
  foreach t in array array['assistant_threads'] loop
    begin
      execute format(
        'alter publication supabase_realtime add table public.%I', t
      );
    exception
      when duplicate_object then null; -- already published
      when others then null;           -- e.g. publication is FOR ALL TABLES
    end;
  end loop;
end $$;
