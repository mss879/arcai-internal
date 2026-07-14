-- ============================================================
-- 0054_wa_promises.sql
-- WhatsApp sales machine — Promise Tracking:
--
--   The agent captures the prospect's own commitments mid-chat
--   ("call me Monday", "salary comes on the 25th", "let me ask
--   my partner") via a new `schedule_promise` tool and follows
--   up at EXACTLY that moment, instead of the generic 48/72/120h
--   quiet-chat cadence. `cancel_promise` retires one that
--   resolved in-chat or changed.
--
--   wa_promises : one row per commitment — what they said, when
--                 to act on it, and how it ended. Survives inbound
--                 replies (unlike the cadence, which any reply
--                 clears); a pending promise suppresses the
--                 generic cadence so the contact is never
--                 double-nudged.
-- ============================================================

-- ---- Promises --------------------------------------------------
create table if not exists public.wa_promises (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references public.wa_contacts (id) on delete cascade,
  -- What they committed to, in the agent's words ("said to call back Monday after lunch").
  summary      text not null,
  -- Their verbatim line that triggered it (audit + prompt context).
  source_quote text,
  -- When to follow up (UTC — resolved server-side from the workspace timezone).
  due_at       timestamptz not null,
  status       text not null default 'pending'
               check (status in ('pending', 'sent', 'cancelled')),
  -- How it ended: 'done', 'no_longer_relevant', a skip reason, or the send outcome.
  result       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists wa_promises_due_idx
  on public.wa_promises (due_at) where status = 'pending';
create index if not exists wa_promises_contact_idx
  on public.wa_promises (contact_id, created_at desc);

drop trigger if exists wa_promises_set_updated_at on public.wa_promises;
create trigger wa_promises_set_updated_at
  before update on public.wa_promises
  for each row execute function public.set_updated_at();

-- ---- Ensure the new agent tools are allowed on existing installs
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{schedule_promise}'
  where not ('schedule_promise' = any(allowed_tools));
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{cancel_promise}'
  where not ('cancel_promise' = any(allowed_tools));

-- ---- RLS + realtime (single-workspace: any authenticated) ----
do $$
declare t text;
begin
  foreach t in array array['wa_promises'] loop
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
