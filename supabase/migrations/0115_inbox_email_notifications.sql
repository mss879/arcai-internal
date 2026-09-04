-- ============================================================
-- 0115_inbox_email_notifications.sql
-- ============================================================
-- Track 1 of the next wave: one inbox.
--
-- Today a client's words are split across /whatsapp, the /sms history and
-- each project's Client tab, and email leaves no trace at all — six senders
-- in src/lib/email.ts write to Resend and nothing else. Nobody owns a
-- conversation, so a hand-off wakes the whole team.
--
-- This migration adds:
--   1. email_messages     every email the CRM sends, shaped so an inbound one
--                         can land in the same table later.
--   2. email_templates    saved subject/body for the compose box.
--   3. conversation_meta  who owns a thread, its tags, notes and snooze —
--                         for all four channels, so ownership never becomes
--                         columns on wa_contacts.
--   4. notification_prefs per-user channels, quiet hours, muted threads.
--   5. notifications.type gains 'inbox' and 'approval'.
--   6. wa_agent_config.handoff_user_id — who the WhatsApp agent hands to.
--   7. meetings.invite_sent_at / sequence — for .ics invites.
--   8. assistant_approvals.kind widened for this wave's new cards.
--
-- Additive and idempotent throughout; nothing is backfilled or deleted.
-- Apply BEFORE pushing the code that reads these columns.
-- ============================================================

-- 1. The email log ---------------------------------------------------

create table if not exists public.email_messages (
  id           uuid primary key default gen_random_uuid(),
  -- 'inbound' is unused today. The column exists so that adding a mailbox
  -- later is a reader, not a migration of everything already logged.
  direction    text not null default 'outbound'
               check (direction in ('outbound', 'inbound')),
  status       text not null default 'queued'
               check (status in ('queued', 'sent', 'failed',
                                 'delivered', 'bounced', 'complained')),
  -- Resend's message id. The only join key a webhook event can arrive with.
  provider_id  text,

  from_email   text not null,
  -- One row per send CALL: a notice emailed to three people is one row with
  -- three addresses, because that is one message and they can all see each
  -- other. Cold outreach deliberately sends one call per address.
  to_emails    text[] not null default '{}',
  cc_emails    text[] not null default '{}',
  reply_to     text,

  subject      text not null default '',
  body_text    text,
  body_html    text,
  -- Metadata only — filename, size, what it was. Never the bytes.
  attachments  jsonb not null default '[]'::jsonb,

  kind         text not null default 'compose'
               check (kind in ('compose', 'invoice', 'quote', 'proposal',
                               'statement', 'meeting_invite', 'digest',
                               'automation', 'outreach', 'notice', 'pricing',
                               'system', 'invite')),

  -- Whatever the sending call site had in scope. All optional: a pricing
  -- email knows nothing, a quote share knows four.
  client_id    uuid references public.clients (id)  on delete set null,
  lead_id      uuid references public.leads (id)    on delete set null,
  project_id   uuid references public.projects (id) on delete set null,
  invoice_id   uuid references public.invoices (id) on delete set null,
  quote_id     uuid references public.quotes (id)   on delete set null,
  proposal_id  uuid references public.proposals (id) on delete set null,
  meeting_id   uuid references public.meetings (id) on delete set null,

  -- Groups a back-and-forth in the inbox. Stable per entity, e.g.
  -- 'client:<uuid>' — not Resend's id, which changes per message.
  thread_key   text,
  in_reply_to  text,

  template_id  uuid,
  sent_by      uuid references public.profiles (id) on delete set null,
  -- Who decided to send: a person, Arcus, an automation, or a scheduled job.
  actor        text not null default 'team'
               check (actor in ('team', 'assistant', 'automation', 'system')),

  opened_at    timestamptz,
  open_count   int not null default 0,
  clicked_at   timestamptz,
  click_count  int not null default 0,
  delivered_at timestamptz,
  bounced_at   timestamptz,
  error        text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

-- Partial + unique: a queued row has no provider id yet, and two failures
-- must not collide on NULL.
create unique index if not exists email_messages_provider_key
  on public.email_messages (provider_id)
  where provider_id is not null;

create index if not exists email_messages_created_idx
  on public.email_messages (created_at desc);
create index if not exists email_messages_client_idx
  on public.email_messages (client_id, created_at desc)
  where client_id is not null;
create index if not exists email_messages_lead_idx
  on public.email_messages (lead_id, created_at desc)
  where lead_id is not null;
create index if not exists email_messages_project_idx
  on public.email_messages (project_id, created_at desc)
  where project_id is not null;
create index if not exists email_messages_thread_idx
  on public.email_messages (thread_key, created_at desc)
  where thread_key is not null;

comment on table public.email_messages is
  'Every email the CRM sends, written by sendAndLogEmail() in src/lib/email-outbox.ts. src/lib/email.ts is transport only.';
comment on column public.email_messages.provider_id is
  'Resend message id. The Resend webhook joins delivery/bounce/open events back to the send through this.';

-- 2. Saved templates -------------------------------------------------

create table if not exists public.email_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  kind       text not null default 'compose',
  subject    text not null default '',
  body       text not null default '',
  -- An optional call-to-action button. cta_kind names what to link to
  -- (portal | quote | invoice | proposal | custom); the URL is resolved at
  -- send time from the record the email is about.
  cta_label  text,
  cta_kind   text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_templates_name_idx
  on public.email_templates (name);

drop trigger if exists email_templates_set_updated_at on public.email_templates;
create trigger email_templates_set_updated_at
  before update on public.email_templates
  for each row execute function public.set_updated_at();

-- 3. Conversation ownership ------------------------------------------

create table if not exists public.conversation_meta (
  id            uuid primary key default gen_random_uuid(),
  channel       text not null
                check (channel in ('whatsapp', 'sms', 'portal', 'email')),
  -- Deliberately text, not uuid: a WhatsApp thread keys on wa_contacts.id, an
  -- SMS thread on the phone number, a portal thread on the project id and an
  -- email thread on email_messages.thread_key. One table, four key shapes.
  ref_id        text not null,
  assigned_to   uuid references public.profiles (id) on delete set null,
  assigned_at   timestamptz,
  tags          text[] not null default '{}',
  notes         text,
  snoozed_until timestamptz,
  last_read_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists conversation_meta_thread_key
  on public.conversation_meta (channel, ref_id);
create index if not exists conversation_meta_assigned_idx
  on public.conversation_meta (assigned_to)
  where assigned_to is not null;
create index if not exists conversation_meta_snoozed_idx
  on public.conversation_meta (snoozed_until)
  where snoozed_until is not null;

drop trigger if exists conversation_meta_set_updated_at on public.conversation_meta;
create trigger conversation_meta_set_updated_at
  before update on public.conversation_meta
  for each row execute function public.set_updated_at();

comment on table public.conversation_meta is
  'Thread ownership, tags, notes and snooze for every channel. Ownership lives ONLY here — never as columns on wa_contacts.';

-- 4. Notification preferences ----------------------------------------

create table if not exists public.notification_prefs (
  user_id            uuid primary key
                     references public.profiles (id) on delete cascade,
  -- { "<notification type>": { "inapp": true, "push": true, "email": false } }
  -- A type absent from the map takes the code's defaults, so an empty row
  -- behaves exactly like no row at all.
  channels           jsonb not null default '{}'::jsonb,
  -- Same shape as the WhatsApp agent's (0052): whole hours, start may be
  -- greater than end for a window that crosses midnight.
  quiet_hours_enabled boolean not null default false,
  quiet_hours_start  int not null default 21,
  quiet_hours_end    int not null default 8,
  timezone           text not null default 'Asia/Colombo',
  digest_daily       boolean not null default false,
  digest_weekly      boolean not null default false,
  -- Notification links the user never wants to hear about again, e.g.
  -- '/inbox?thread=whatsapp:<id>'. Matched by prefix.
  muted_links        text[] not null default '{}',
  updated_at         timestamptz not null default now()
);

drop trigger if exists notification_prefs_set_updated_at on public.notification_prefs;
create trigger notification_prefs_set_updated_at
  before update on public.notification_prefs
  for each row execute function public.set_updated_at();

-- 5. Two more kinds of notification -----------------------------------
-- Widening a CHECK is drop-then-add. (A do-$$/duplicate_object block would
-- swallow the failure and silently leave the old constraint in place.)
-- Old clients degrade safely: notifications-bell.tsx falls back to a generic
-- icon for a type it does not recognise.
alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'mention', 'assignment', 'commission', 'system',
    -- 0102
    'assistant',
    -- 0115
    'inbox', 'approval'
  ));

-- 6. Where WhatsApp hand-offs go --------------------------------------
-- NULL keeps today's behaviour: handoff_human alerts everyone.
alter table public.wa_agent_config
  add column if not exists handoff_user_id uuid
  references public.profiles (id) on delete set null;

comment on column public.wa_agent_config.handoff_user_id is
  'Who the agent hands a conversation to. NULL = everyone, which is what it did before 0115.';

-- 7. Calendar invites --------------------------------------------------
alter table public.meetings
  add column if not exists invite_sent_at timestamptz,
  -- iCalendar SEQUENCE: bumped on every reschedule so Google and Apple treat
  -- the new .ics as an update rather than a second meeting.
  add column if not exists sequence int not null default 0;

-- 8. The assistant's new cards ----------------------------------------
-- Widened once here for the whole wave, so Track 2 and Track 4 don't each
-- need a migration to add a card kind.
alter table public.assistant_approvals
  drop constraint if exists assistant_approvals_kind_check;
alter table public.assistant_approvals
  add constraint assistant_approvals_kind_check
  check (kind in (
    -- 0103
    'invoice_email', 'sms',
    -- 0115
    'email', 'whatsapp', 'portal_link', 'mark_paid', 'social_post', 'agreement'
  ));

-- 9. RLS ---------------------------------------------------------------
-- Workspace-shared, like every other operational table: the team is one
-- trusted group and every read is server-side. notification_prefs is the
-- exception — those are personal.

alter table public.email_messages    enable row level security;
alter table public.email_templates   enable row level security;
alter table public.conversation_meta enable row level security;
alter table public.notification_prefs enable row level security;

do $$
begin
  begin
    create policy "email_messages: read all" on public.email_messages
      for select to authenticated using (true);
  exception when duplicate_object then null; end;
  begin
    create policy "email_messages: insert all" on public.email_messages
      for insert to authenticated with check (true);
  exception when duplicate_object then null; end;
  begin
    create policy "email_messages: update all" on public.email_messages
      for update to authenticated using (true) with check (true);
  exception when duplicate_object then null; end;

  begin
    create policy "email_templates: read all" on public.email_templates
      for select to authenticated using (true);
  exception when duplicate_object then null; end;
  begin
    create policy "email_templates: write all" on public.email_templates
      for all to authenticated using (true) with check (true);
  exception when duplicate_object then null; end;

  begin
    create policy "conversation_meta: read all" on public.conversation_meta
      for select to authenticated using (true);
  exception when duplicate_object then null; end;
  begin
    create policy "conversation_meta: write all" on public.conversation_meta
      for all to authenticated using (true) with check (true);
  exception when duplicate_object then null; end;
end $$;

drop policy if exists "notification_prefs_own" on public.notification_prefs;
create policy "notification_prefs_own" on public.notification_prefs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 10. Realtime (0021 guard pattern) ------------------------------------
-- Only what a live screen watches: the inbox list and its ownership rail.
do $$
declare
  t text;
begin
  foreach t in array array['email_messages', 'conversation_meta'] loop
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
