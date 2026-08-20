-- ============================================================
-- 0082_presence_pings.sql
-- 1) login_sessions joins the realtime publication so the Team
--    page's "online now" dots refresh live off the activity
--    heartbeat (last_active_at updates).
-- 2) Realtime Authorization for the ephemeral admin↔member
--    pop-up messages ("pings"). Pings are Supabase BROADCAST
--    messages on private channels — they are never written to
--    any table, which is the point: pop up, reply, gone.
--    Rules: a member may join/send only their OWN ping channel
--    (ping:<their uuid>, i.e. receive pings + send replies);
--    admins may join/send on any ping channel.
-- ============================================================

do $$
begin
  alter publication supabase_realtime add table public.login_sessions;
exception when others then null;
end $$;

do $$
begin
  if to_regclass('realtime.messages') is null then
    return; -- very old realtime stack: pings simply stay off
  end if;

  drop policy if exists "pings: receive" on realtime.messages;
  create policy "pings: receive" on realtime.messages
    for select to authenticated
    using (
      extension = 'broadcast'
      and realtime.topic() like 'ping:%'
      and (
        realtime.topic() = 'ping:' || (select auth.uid())::text
        or public.is_admin((select auth.uid()))
      )
    );

  drop policy if exists "pings: send" on realtime.messages;
  create policy "pings: send" on realtime.messages
    for insert to authenticated
    with check (
      extension = 'broadcast'
      and realtime.topic() like 'ping:%'
      and (
        realtime.topic() = 'ping:' || (select auth.uid())::text
        or public.is_admin((select auth.uid()))
      )
    );
end $$;
