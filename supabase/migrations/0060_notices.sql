-- ============================================================
-- 0060_notices.sql
-- Persisted client notices. Mirrors invoices (0019): every notice
-- the generator downloads is saved here so it shows up under the
-- "Past notices" tab. Shared across the workspace.
--
-- A notice is the prose sibling of an invoice — same letterhead and
-- sign-off, but the middle is a written message instead of line items.
-- ============================================================

create table if not exists public.notices (
  id            uuid primary key default gen_random_uuid(),
  notice_number text not null,
  notice_date   date not null,
  to_name       text not null default '',
  to_details    text not null default '',
  -- The bold line above the greeting, e.g. "SCHEDULED MAINTENANCE".
  subject       text not null default '',
  -- The message itself. Paragraphs separated by blank lines. Excludes the
  -- "Dear Client," greeting — the template always prints that.
  body          text not null default '',
  -- What the user actually dictated/typed before the AI polished it. Kept so
  -- a past notice can be re-drafted from the original intent.
  source_input  text not null default '',
  -- Who the notice was emailed to, and when. Both optional; the send flow
  -- stamps them best-effort after a successful send (mirrors invoices, 0020).
  recipient_email text,
  sent_at         timestamptz,
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now()
);

create index if not exists notices_created_at_idx on public.notices (created_at desc);

alter table public.notices enable row level security;

create policy "notices: read all"
  on public.notices for select to authenticated using (true);

create policy "notices: write all"
  on public.notices for insert to authenticated with check (true);

create policy "notices: update all"
  on public.notices for update to authenticated using (true) with check (true);

create policy "notices: delete all"
  on public.notices for delete to authenticated using (true);

-- Live updates for the "Past notices" tab (optional). Ignored if the
-- realtime publication is FOR ALL TABLES or already includes this table.
do $$
begin
  alter publication supabase_realtime add table public.notices;
exception
  when others then null;
end $$;
