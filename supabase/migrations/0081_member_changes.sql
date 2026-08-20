-- ============================================================
-- 0081_member_changes.sql
-- Change tracking for the admin Activity view: one row for every
-- create / update / delete a signed-in user performs on a business
-- table, captured by a generic AFTER trigger. Writes made with the
-- service role (the WhatsApp agent, crons, webhooks, device/session
-- bookkeeping) have no auth.uid() and are deliberately NOT logged —
-- the log answers "what did this person do", not "what did the
-- system do". Updates that only touch noise columns (unread flags,
-- bumped timestamps) are skipped so opening a chat isn't "work".
-- ============================================================

create table if not exists public.member_changes (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  table_name     text not null,
  op             text not null check (op in ('created', 'updated', 'deleted')),
  row_id         text,
  -- Best-effort human label of the touched row (lead title, invoice no, …).
  label          text,
  changed_fields text[],
  created_at     timestamptz not null default now()
);

create index if not exists member_changes_user_time_idx
  on public.member_changes (user_id, created_at desc);

alter table public.member_changes enable row level security;

-- Read: your own trail, or everyone's for admins (Activity modal).
create policy "member_changes: select own or admin" on public.member_changes
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

-- No insert/update/delete policies: rows come only from the trigger below
-- (security definer), so users can't forge or scrub their own trail.

create or replace function public.log_member_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  rec       jsonb;
  old_rec   jsonb;
  fields    text[];
  row_label text;
begin
  -- Service-role / system writes carry no user — not a member action.
  if uid is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'UPDATE' then
    rec := to_jsonb(new);
    old_rec := to_jsonb(old);
    select coalesce(array_agg(t.k), '{}') into fields
    from jsonb_object_keys(rec) as t(k)
    where rec -> t.k is distinct from old_rec -> t.k
      and t.k not in (
        'updated_at', 'created_at', 'unread', 'needs_attention',
        'last_message_at', 'last_used_at', 'last_active_at', 'last_seen_at'
      );
    if coalesce(array_length(fields, 1), 0) = 0 then
      return new; -- only noise columns moved (e.g. marking a chat read)
    end if;
  elsif tg_op = 'INSERT' then
    rec := to_jsonb(new);
  else
    rec := to_jsonb(old);
  end if;

  row_label := coalesce(
    rec ->> 'title', rec ->> 'name', rec ->> 'full_name', rec ->> 'company',
    rec ->> 'subject', rec ->> 'invoice_number', rec ->> 'number', rec ->> 'body'
  );

  insert into public.member_changes (user_id, table_name, op, row_id, label, changed_fields)
  values (
    uid,
    tg_table_name,
    case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    rec ->> 'id',
    left(row_label, 80),
    case when tg_op = 'UPDATE' then fields else null end
  );

  return coalesce(new, old);
exception when others then
  -- Auditing must never break the write it observes.
  return coalesce(new, old);
end $$;

-- Attach to every table where member work happens. Skips tables that don't
-- exist in this database yet, and is safe to re-run.
do $$
declare
  t text;
begin
  foreach t in array array[
    'leads', 'lead_activities', 'lead_outreach', 'clients', 'companies',
    'todos', 'todo_subtasks', 'crm_tasks', 'projects',
    'meetings', 'meeting_attendees',
    'invoices', 'quotes', 'notices', 'proposals',
    'payments', 'payment_plans', 'payment_installments', 'expenses',
    'cheques', 'company_payments',
    'pipelines', 'pipeline_stages',
    'wa_messages', 'wa_contacts', 'sms_messages',
    'resources', 'carousel_posts', 'content_generations'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists member_changes_audit on public.%I', t);
      execute format(
        'create trigger member_changes_audit
           after insert or update or delete on public.%I
           for each row execute function public.log_member_change()',
        t
      );
    end if;
  end loop;
end $$;
