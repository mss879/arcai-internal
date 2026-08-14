-- ============================================================
-- 0074_wa_analytics.sql
-- WhatsApp sales machine — Analytics tab aggregates.
--
--   Three read-only SQL functions so the Analytics tab asks the
--   database for ANSWERS instead of pulling thousands of rows
--   into the app (buildCampaignStats used to fetch up to 5,000
--   contacts per render for one campaign's funnel):
--
--   wa_funnel_stats          : the funnel + agent-win headline.
--                              The agent's WIN is a BOOKED CALL
--                              (its whole job: give the info, set
--                              up the call) — deal outcomes after
--                              that are the team's half.
--   wa_daily_message_counts  : in/out volume per local day.
--   wa_tool_stats            : tool usage + success rates.
--
--   All `security invoker`: RLS applies exactly as it does to
--   the app's own queries (single-workspace, authenticated).
-- ============================================================

create or replace function public.wa_funnel_stats(
  p_since timestamptz,
  p_campaign uuid default null
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with c as (
    select id, lead_id, call_booked_at, first_reply_seconds, last_inbound_at
    from wa_contacts
    where created_at >= p_since
      and (p_campaign is null or campaign_id = p_campaign)
  ),
  l as (
    select id, status, value
    from leads
    where id in (select lead_id from c where lead_id is not null)
  ),
  q as (
    select lead_id,
           bool_or(viewed_at is not null)   as viewed,
           bool_or(status = 'accepted')     as signed,
           bool_or(status = 'declined')     as declined
    from quotes
    where lead_id in (select lead_id from c where lead_id is not null)
    group by lead_id
  )
  select jsonb_build_object(
    'contacts',     (select count(*) from c),
    'replied',      (select count(*) from c where last_inbound_at is not null),
    'in_crm',       (select count(*) from c where lead_id is not null),
    'agent_wins',   (select count(*) from c where call_booked_at is not null),
    'agent_win_rate', case when (select count(*) from c) > 0
                      then round(100.0 * (select count(*) from c where call_booked_at is not null)
                                 / (select count(*) from c), 1)
                      else 0 end,
    'quoted',       (select count(*) from q),
    'quote_viewed', (select count(*) from q where viewed),
    'signed',       (select count(*) from q where signed),
    'declined',     (select count(*) from q where declined),
    'won',          (select count(*) from l where status = 'won'),
    'revenue',      coalesce((select sum(value) from l where status = 'won'), 0),
    'median_first_reply', (select percentile_cont(0.5) within group (order by first_reply_seconds)
                           from c where first_reply_seconds is not null),
    'p90_first_reply',    (select percentile_cont(0.9) within group (order by first_reply_seconds)
                           from c where first_reply_seconds is not null)
  );
$$;

create or replace function public.wa_daily_message_counts(
  p_since timestamptz,
  p_timezone text default 'Asia/Colombo'
) returns table (day date, inbound bigint, outbound bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select (created_at at time zone p_timezone)::date as day,
         count(*) filter (where direction = 'in')  as inbound,
         count(*) filter (where direction = 'out') as outbound
  from wa_messages
  where created_at >= p_since
  group by 1
  order by 1;
$$;

create or replace function public.wa_tool_stats(
  p_since timestamptz
) returns table (tool text, total bigint, ok_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select tool,
         count(*)                    as total,
         count(*) filter (where ok)  as ok_count
  from wa_agent_logs
  where created_at >= p_since
  group by tool
  order by count(*) desc;
$$;
