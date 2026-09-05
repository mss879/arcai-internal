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
