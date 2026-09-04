-- ============================================================
-- 0116_public_rate_limits.sql
-- ============================================================
-- Rate limiting for the endpoints anyone on the internet can reach.
--
-- The CRM's public surface — the lead form, inbound webhooks, the open API,
-- the visitor tracker, the invoice PDF, the client portal's actions, the
-- quote page — has never been rate limited. A script can submit ten thousand
-- leads, enumerate share tokens, or bill us for ten thousand PDF renders on
-- a serverless plan that charges by the invocation.
--
-- In-process counting is not enough here: every serverless instance keeps its
-- own Map, so N instances mean N times the allowance, and a cold start resets
-- it. This table is the shared counter; src/lib/rate-limit.ts still keeps an
-- in-memory Map in front of it so the common case costs no round-trip.
--
-- Rows are disposable. Nothing reads history — a sweep on write keeps the
-- table small without a cron.
--
-- Apply BEFORE pushing the code that calls rate_limit_check().
-- ============================================================

create table if not exists public.rate_limit_hits (
  -- '<bucket>:<subject>', e.g. 'lead-form:203.0.113.7'. Hashed IPs are fine
  -- and preferred; this table never needs to identify anybody.
  key        text not null,
  at         timestamptz not null default now()
);

create index if not exists rate_limit_hits_key_at_idx
  on public.rate_limit_hits (key, at desc);

comment on table public.rate_limit_hits is
  'Disposable counters for public endpoint rate limiting. Swept on write; nothing reads history.';

/**
 * Count recent hits for a key, record this one, and say whether it is allowed.
 *
 * security definer because the callers are unauthenticated public routes
 * holding the anon key — they must be able to count without being able to
 * read the table. search_path is pinned for the same reason.
 *
 * Returns true when the request is WITHIN the limit (and it has been
 * recorded), false when it should be refused.
 */
create or replace function public.rate_limit_check(
  p_key text,
  p_limit int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_since timestamptz := now() - make_interval(secs => greatest(1, p_window_seconds));
  v_count int;
begin
  select count(*) into v_count
  from public.rate_limit_hits
  where key = p_key and at >= v_since;

  if v_count >= greatest(1, p_limit) then
    return false;
  end if;

  insert into public.rate_limit_hits (key) values (p_key);

  -- Opportunistic sweep, cheap and bounded: roughly one caller in fifty pays
  -- for it, and only for keys older than a day. No cron, no growth.
  if random() < 0.02 then
    delete from public.rate_limit_hits where at < now() - interval '1 day';
  end if;

  return true;
end;
$$;

comment on function public.rate_limit_check(text, int, int) is
  'True when the caller is within the limit (and the hit is recorded). Called by enforceRateLimit() in src/lib/rate-limit.ts.';

-- The public routes run as anon; the team's server code runs as authenticated.
grant execute on function public.rate_limit_check(text, int, int)
  to anon, authenticated, service_role;

-- RLS on, and NO policy: the function is security definer, so nothing needs
-- direct access to the rows. A public route holding the anon key can count
-- without being able to read what anyone else has been doing.
alter table public.rate_limit_hits enable row level security;
