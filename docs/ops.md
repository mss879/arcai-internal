# Operations

How the CRM is run: what protects the data, what backs it up, and what to
do when something is wrong. Written for whoever is on call, not for the
person who built it.

## Permissions — "RLS-lite"

The database's row-level security is deliberately permissive: every table
that members can see is `USING (true)` for an authenticated user, with a
handful of admin-only tables (`social_accounts`, `app_settings`) and tables
with no policies at all that only `security definer` functions touch
(`document_counters`, `rate_limit_hits`).

**The app enforces; the database records.** Two layers decide what a
person can do:

1. **Role** — `profiles.role` is `admin` or `member`. Admin-only pages
   call `requireAdmin()`; admin-only nav items carry `adminOnly`.
2. **Capabilities** (0121, T5.2) — `profiles.capabilities` names the areas
   a member may work in: `finance`, `delivery`, `sales`, `marketing`. An
   admin has all four by role. Members are ticked on the Team page; the
   backfill gave every existing member all four, so nothing changed the day
   it landed.

Capabilities are applied in two stages, switched on `/settings`:

| `app_settings.capabilities_enforced` | Sidebar | Pages | Money actions |
| --- | --- | --- | --- |
| `{"enabled": false}` (default) | hidden without the tick | open | open |
| `{"enabled": true}` | hidden without the tick | `requireCapability()` → `/dashboard` | `recordPayment()` refuses a member without `finance` |

Where the rule lives:

- `src/lib/capabilities.ts` — `hasCapability()`, pure, read by the sidebar.
- `src/lib/capabilities-server.ts` — the switch, `actorHasCapability()` for
  code that carries an `actorId` (the payment choke point), and
  `capabilityAudienceIds()` for the finance notifications.
- `src/lib/auth.ts` — `requireCapability()` for pages, `assertCapability()`
  for server actions.

Why not real RLS: every screen in the CRM joins across a dozen tables and
is read by both roles; policies per capability would have to be written on
every one of those tables and kept in step with the app's own idea of an
"area". The app already knows the area — the nav is grouped by it — so the
app enforces it, once, and the database stays simple enough to reason about.
The cost is honest: a member with a direct database credential is bounded by
their role, not by their capabilities. Nobody but the service role has one.

## Health and errors

- **`GET /api/health`** (public, machine-only, rate-limited by IP) is the
  uptime check: the database answers, the automation tick has run in the
  last 16 minutes (it runs every 5), the WhatsApp tick in the last 6 (every
  minute, only checked when WhatsApp is configured), which integrations have
  keys (booleans only), and how many faults are open. `200` healthy, `503`
  degraded — the body names the failing check. Point the monitor at it.
- **Errors** are one row per distinct fault in `error_events` (0121),
  counted rather than repeated: `captureError()` in `src/lib/errors.ts` is
  called from the three tick routes and by the page error boundaries through
  `POST /api/errors`. An admin is notified the first time a fingerprint is
  seen and at most every six hours while it recurs; the Errors panel on
  `/settings` lists and resolves them (a resolved fault reopens itself if it
  comes back). With `SENTRY_DSN` set, each capture is also posted to Sentry
  as a raw envelope — Sentry is a mirror, never the record.
