-- ============================================================
-- 0056_lead_outreach.sql
-- Automated lead outreach — Research → Audit → AI email → Approve → Send:
--
--   After Find Leads imports a lead, a background pipeline researches
--   the company + audits its website, then the AI writes a highly
--   customized cold email. It STOPS at 'ready' — nothing sends until
--   a human clicks Approve on the lead (draft-then-approve). On send
--   it emails every valid scraped address from support@arcai.agency,
--   tags the lead "Email Sent", and stores the exact copy.
--
--   lead_outreach        : one row per lead (unique) — the pipeline
--                          state machine + the immutable sent copy.
--   outreach_suppressions: opt-outs (unsubscribe) + hard bounces,
--                          never emailed again.
-- ============================================================

-- ---- Outreach pipeline + sent copy ----------------------------
create table if not exists public.lead_outreach (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null unique references public.leads (id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending','researching','drafting','ready',
                                  'sending','sent','failed','skipped','discarded')),
  -- Full scraped list captured at enqueue; the send target.
  recipients    text[] not null default '{}',
  -- The subset that actually passed validation + suppression and was sent.
  sent_to       text[] not null default '{}',
  -- Editable before approval; `body` is the EXACT text that goes out.
  subject       text not null default '',
  body          text not null default '',
  -- ResearchAudit snapshot (null when the lead has no website).
  audit         jsonb,
  audit_score   int,
  -- Homepage brand/summary facts used to personalize the email.
  company_facts jsonb,
  message_ids   text[] not null default '{}',
  from_email    text not null default 'support@arcai.agency',
  source        text not null default 'prospecting'  -- prospecting | manual
                check (source in ('prospecting','manual')),
  attempts      int not null default 0,
  error         text,
  locked_at     timestamptz,                          -- lease (CAS), see research.ts
  requested_by  uuid references public.profiles (id) on delete set null,
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  sent_at       timestamptz
);

-- Cheap claim index for the tick; unique(lead_id) is the dedupe backbone.
create index if not exists lead_outreach_claim_idx
  on public.lead_outreach (status, updated_at);

drop trigger if exists lead_outreach_set_updated_at on public.lead_outreach;
create trigger lead_outreach_set_updated_at
  before update on public.lead_outreach
  for each row execute function public.set_updated_at();

-- ---- Suppression list (opt-outs + bounces) --------------------
create table if not exists public.outreach_suppressions (
  email      text primary key,
  reason     text not null default 'unsubscribe'
             check (reason in ('unsubscribe','bounce','complaint','manual')),
  lead_id    uuid references public.leads (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---- RLS + realtime (single-workspace: any authenticated) ----
do $$
declare t text;
begin
  foreach t in array array['lead_outreach', 'outreach_suppressions'] loop
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
