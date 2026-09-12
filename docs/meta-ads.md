# Meta Ads (0132)

`/ads` puts what the Meta ads **cost** next to what they **produced** in the
CRM: impressions → taps → WhatsApp conversations (Meta's numbers) → ad
contacts → qualified → calls booked (the CRM's numbers, computed live).

It is admin-only (Insights → Ads). Nothing on the page talks to Meta.

---

## Why it is built this way

There is **no Meta token in this app**, on purpose (the owner's choice, Sept
2026). The CRM's WhatsApp system-user token has no `ads_read`, and adding an
ads token would mean a stored secret, a cron and a Netlify function, all to
refresh numbers the owner reads a few times during a flight.

Instead **Claude syncs on demand**. In a Claude Code session with the Meta Ads
connector, the owner says "sync my ads". Claude reads the campaign from Meta,
writes a JSON file in the contract below, and runs one narrow local script,
`scripts/ads-sync.mjs`. The script validates the file and upserts it with the
service role. The CRM half of the funnel is never synced: the page reads
`wa_contacts`, `wa_messages` and `leads` on every load, so a call booked a
minute ago is already counted.

| Piece | Where |
| --- | --- |
| Tables | `supabase/migrations/0132_meta_ads.sql`: `meta_ad_entities`, `meta_ad_insights`, `meta_ad_syncs`, plus `wa_contacts.ad_*`; `0133_meta_ad_syncs_synced_at.sql`: `meta_ad_syncs.synced_at` |
| Sync script | `scripts/ads-sync.mjs` (I/O) + `scripts/ads-sync-core.mjs` (pure, tested) |
| Attribution | `src/lib/meta-ads/attribution-core.ts` |
| Health rules | `src/lib/meta-ads/health-core.ts` |
| Totals, windows, Colombo days | `src/lib/meta-ads/report-core.ts` |
| Page loader | `src/lib/meta-ads/queries.ts` |
| Page | `src/app/(app)/ads/` |
| Referral capture | `src/app/api/whatsapp/webhook/route.ts` (`stampAdFirstTouch`) |

Access: the three tables are **admin-read** under RLS and have **no write
policy** for `authenticated`. Only the service role (the script) writes.

The attribution **inputs** are not admin-only, though. `wa_contacts.ad_*`
and `wa_messages.meta.referral` sit under 0048's open member read/update
policies, like `call_booked_at` and `lead_id`. So a signed-in member could
move an ad's credit or its booked count. That affects the integrity of the
CRM half of the numbers, not anyone's privileges. Tightening it belongs to a
`wa_contacts` access pass that covers the booking columns too.

---

## Attribution: which ad brought a contact

A WhatsApp contact is credited to one of the selected campaign's ads by the
first rule that applies:

1. **Referral.** A Click-to-WhatsApp tap makes Meta attach a `referral` to the
   first message after the tap (`source_id` = the ad id). The webhook stores it
   on that message (`wa_messages.meta.referral`), every time. It also stamps it
   once on the contact (`wa_contacts.ad_source_id`, `ad_ctwa_clid`,
   `ad_referral`, `ad_entered_at`), guarded by `ad_source_id IS NULL`. That
   stamp is first-touch **for life**, so the page does not trust it first.
   For the selected campaign it looks, in order, for:
   - a message **inside the campaign's window** whose referral names one of
     its ads. That ad gets the credit, dated by that message. This is how a
     returning contact is credited, even when their stored first touch is an
     earlier campaign's ad.
   - the first in-window message's ad referral naming **any other** ad. The
     contact is then not credited to this campaign at all, and the prefill is
     not consulted.
   - the stored first touch, but only when it landed inside this campaign's
     window.
2. **Prefill.** Otherwise, if the contact's **first inbound message**, once
   normalised, equals an ad's prefill or starts with it (ending on a word
   boundary), that ad gets the credit. Normalising means lower-casing,
   straightening curly quotes, collapsing whitespace, and trimming punctuation
   and emoji at the ends. So the person may keep typing after the prefill.
   Prefills shorter than 12 characters are ignored. When one prefill is a
   prefix of another, the longer wins.
3. **Time window.** Either way, the contact counts only if it entered between
   the campaign's start and its end **plus 7 days**. "Entered" is
   `ad_entered_at` when set, else `created_at`. The 7d/30d page windows narrow
   this further.

What attribution does **not** use: `wa_contacts.campaign_id`. That column
means "whichever `wa_campaigns` row was active when they first wrote", which
is timing, not evidence. The Sept 2026 "Smart Websites — Established
Companies" row is the **same row id** the August "Smart Systems" ad used, so
it mixes both campaigns and every organic chat in between.

Until 0132 is applied, `/ads` shows the setup screen, and the contact
columns do not exist. The webhook logs
`[whatsapp] ad first-touch stamp skipped (is 0132 applied?)` and carries on.
Messages that arrive in that time still keep their referral on
`wa_messages.meta.referral`, but their contacts never get `ad_source_id`. Once
0132 is applied, the page credits those contacts from the message's referral,
then from the prefill.

**CRM outcomes**, per attributed contact:

- **replied**: sent a second inbound message, so they engaged with the agent
  rather than only tapping.
- **named lead**: `lead_id` is set.
- **qualified**: booked, or their lead's `score` is `hot`.
- **booked**: `call_booked_at` is set and is not older than their entry. That
  column stores the agreed slot, so an old slot from before a returning
  contact's ad tap does not count.

---

## Health rules

Rules are evaluated on every page load and ordered **act → watch → good**.
Thresholds are named constants in `health-core.ts`. Money is in the account
currency (LKR).

| Level | Code | Fires when |
| --- | --- | --- |
| act | `never_synced` | no `meta_ad_syncs` row for the account |
| watch / act | `sync_stale` | last sync's numbers were read from Meta > 24h / > 48h ago (not once the flight has ended and a later read captured the final numbers) |
| act | `delivery_blocked` | effective status `DISAPPROVED` or `WITH_ISSUES` |
| watch | `in_review` | effective status `PENDING_REVIEW` or `IN_PROCESS` |
| act | `no_delivery` | live, zero impressions, in a sync taken ≥ 6h after the start |
| watch | `ended` / `ending_soon` | past the end / live and ending within 24h |
| watch | `underspend` | live ≥ 1 day and spend < 50% of `daily_budget × days` |
| watch | `low_ctr` | link CTR < 0.8% after ≥ 1,000 impressions |
| watch | `high_frequency` | impressions ÷ summed daily reach > 3 |
| act | `spend_no_conversations` | spend ≥ 1,500 with zero conversations |
| good / watch / act | `cost_per_conversation` | ≥ 3 conversations and cost ≤ 900 / > 900 / > 1,500 |
| good | `booked` | ≥ 1 call booked (states the cost per booked call) |
| act | `no_bookings` | ≥ 5 ad contacts and none booked |
| watch | `attribution_gap` | Meta conversations and CRM ad contacts differ by > 50% of the larger, once either is ≥ 5 |

Delivery rules judge the numbers **as of the last sync**, not as of now.
"Last sync" everywhere on the page means the sync row's `synced_at`, which is
when its numbers were read from Meta, not when the row was written.

The flight (start, end) and the daily budget come from the campaign row. When
it has none, they come from its ad sets: the earliest start, the latest end
(or none, if any ad set is open-ended), and the summed daily budgets.

Reading the totals: the campaign total is summed per day from the campaign
row when Meta returned one, else the ad set rows, else the ad rows. Summing
every level at once would count each rupee two or three times. Reach is daily
reach summed, which over-counts repeat viewers, so frequency shown is a
floor.

---

## Payload contract v1

`scripts/ads-sync-core.mjs` enforces this. It rejects unknown keys at
**every** level, strings where numbers belong, ids that are not digit strings,
negative numbers, fractional counts, impossible dates, timestamps without an
offset, insight rows outside `window`, duplicates, and more than 500 entities
or 2,000 insight rows. Every error names its path. A file that fails
validation writes nothing.

```jsonc
{
  "version": 1,
  "ad_account_id": "1148854332990641",        // digits; "act_" prefix is stripped
  "currency": "LKR",                           // the ad account's ISO code
  "synced_at": "2026-09-13T21:00:00+05:30",    // when you read Meta; offset required
  "window": { "start": "2026-09-12", "end": "2026-09-13" },  // ad-account days, inclusive
  "entities": [
    { "level": "campaign", "id": "120244355299530395",
      "name": "ARC | Smart Websites | CTWA | WP Decision-Makers | Sep 2026",
      "status": "ACTIVE", "effective_status": "ACTIVE", "objective": "OUTCOME_ENGAGEMENT",
      "daily_budget": 2500,                    // MAJOR units (not Meta's 250000)
      "start_time": "2026-09-12T19:10:00+0530", "end_time": "2026-09-15T23:59:00+0530" },
    { "level": "adset", "id": "120244355301620395", "name": "…",
      "campaign_id": "120244355299530395",     // required for adset and ad
      "optimization_goal": "CONVERSATIONS", "targeting": { "age_min": 30 } },
    { "level": "ad", "id": "120244355303630395", "name": "Ad A — Companies with 20+ staff",
      "campaign_id": "120244355299530395", "adset_id": "120244355301620395",
      "creative": { "headline": "…", "body": "…", "description": "…",
                    "prefill": "Hi Arc, I'd like to book a call about a Smart Website for our company.",
                    "image_hash": "0cd54b3466e1cb4a1fe757fe67b4c6c9", "cta": "WHATSAPP_MESSAGE" } }
  ],
  "insights": [
    { "level": "campaign", "id": "120244355299530395", "date": "2026-09-13",
      "spend": 2500, "impressions": 5201, "reach": 3802, "clicks": 97, "link_clicks": 53,
      "conversations": 5, "frequency": 1.37, "cpm": 480.68, "ctr": 1.86 },
    { "level": "ad", "id": "120244355303630395", "date": "2026-09-13", "spend": 1402.77,
      "impressions": 2890, "link_clicks": 31, "conversations": 3 }
      // campaign_id / adset_id may be omitted when the entity is in this payload
  ],
  "notes": {                                   // optional: your read, shown on the page
    "summary": "Plain-English read of the numbers.",
    "health": "watch",                         // good | watch | act
    "recommendations": ["Short, concrete next steps (max 12)."]
  }
}
```

A full, valid example is `scripts/fixtures/ads-sync-sample.json`. It is
**sample data** with the live ids. Dry-run it as much as you like. A real run
is refused, both for any file under `scripts/fixtures/` and for any payload
whose `notes.summary` starts with `SAMPLE DATA`.

Semantics worth knowing:

- **`synced_at`** is when you read Meta, and it is stored on the sync row.
  The script refuses a payload read **before** the newest numbers already
  stored for the account, because upserts would roll them back. It also
  refuses a `synced_at` more than 10 minutes in the future, which would block
  every real sync after it. To redo a sync, read Meta again. Re-running the
  **same** payload is allowed, and is how a failed write is finished.
- **Entities:** a key you omit is left untouched in the database; an explicit
  `null` clears it. `creative` is stored as one object, so **always send the
  whole creative, prefill included**. A creative without `prefill` erases the
  stored prefill, and the ad can then only be credited by referral.
- **Insights:** one row per `(level, id, date)`. A re-sync of a day
  **replaces** that day: missing counts become 0, missing ratios null.
  Re-syncing overlapping days is always safe; nothing is double-counted.
- An optional `raw` object (≤ 20k characters of JSON) is accepted on entities
  and insight rows, for keeping Meta's untouched response.

---

## The Claude sync procedure

For a future Claude Code session asked to "sync my ads". Only **read** from
Meta: no create or update tool is needed, and none should be called.

1. **Account.** `ads_get_ad_accounts` → confirm `1148854332990641` is
   `is_queryable` (currency LKR, timezone Asia/Colombo). Every Meta Ads call
   takes the same `client_conversation_id` (20 random alphanumerics, reused
   for the whole conversation).
2. **Field names.** Call `ads_get_field_context` once for the fields below
   and use the **canonical** names it returns. For example, `spend` resolves
   to `amount_spent`; link clicks and messaging conversations have their own
   canonical names. Do not guess them.
3. **Entities.** `ads_get_ad_entities` with `ad_account_id`, and
   `level: "campaign"`, then `"adset"`, then `"ad"` (use `object_ids` for the
   known ids, or filter by campaign). Request `id, name, status,
   effective_status, objective, daily_budget, lifetime_budget, start_time,
   end_time`. Ad sets also need `optimization_goal, targeting, campaign_id`;
   ads need `campaign_id, adset_id` and their creative id. A campaign's end
   is Meta's **`stop_time`**: send it as `end_time`, since only ad sets have
   an `end_time` of their own. Without campaign budget optimisation, the
   budget and the dates live on the **ad set**. Send them on the ad set
   entity, and the page falls back to it.
4. **Creative.** `ads_get_creatives` with `creative_ids` and `fields: ["title",
   "body", "image_hash", "call_to_action_type"]`. Map `title` → `headline`
   and `call_to_action_type` → `cta`. The **prefill** (the ad's
   `page_welcome_message`) is not a creative field that tool returns. Take it
   from the table below, or copy it from the previous payload. Never send a
   creative without it (see the semantics above).
5. **Daily insights.** `ads_get_ad_entities` at `level: "campaign"` and again
   at `level: "ad"`, with
   `time_range: "{\"since\":\"<start>\",\"until\":\"<end>\"}"` (a JSON
   **string**) and `time_increment: "1"` (a **string**). Request amount
   spent, impressions, reach, clicks, link clicks, results / messaging
   conversations started, frequency, CPM and CTR. Follow
   `pagination.next_cursor` until it is absent, resending every other
   parameter unchanged. The window is the flight: the campaign's start day to
   today, in Colombo days. Always re-pull at least the last three days, since
   Meta revises recent numbers.
6. **Convert.** Meta returns display strings. `"LKR1,234.56"` → `1234.56`
   (strip the currency and thousands separators). `"1,234"` → `1234`.
   `"1.86%"` → `1.86`. `"—"` or empty → omit the field (0 for `spend`).
   Budgets must be **major units**: if a budget arrives as `250000` (minor
   units), divide by 100 to get `2500`. Convert `start_time`/`end_time` as
   given (`+0530` offsets are fine). Ids stay **strings**; a number loses
   precision past 2^53.
7. **Write** the payload to your scratchpad, not the repo, e.g.
   `<scratchpad>/ads-sync-<date>.json`. Add `notes`: a short plain-English
   read, a `health` of good/watch/act, and concrete recommendations. Judge on
   **calls booked**, not cost per conversation.
8. **Dry run:** `node scripts/ads-sync.mjs <file> --dry-run`. Fix every error
   it lists. Check the printed campaign spend and conversations against what
   Meta returned. A line "a real run would be REFUSED" is an error too: fix
   it before writing. The script takes exactly one file and only `--dry-run` /
   `--help`. Anything else, such as `-dry-run`, `—dry-run` or a bare
   `dry-run`, stops it with exit 2 instead of writing.
9. **Write:** `node scripts/ads-sync.mjs <file>`. It exits non-zero on any
   failure. It says so if 0132 is not applied, if the file is the sample, or
   if the payload was read before what is already stored. The sync row is
   written last, so a failed run leaves "last synced" unchanged.
10. **Read the page** (`/ads`), or summarise for the owner: the health list,
    cost per booked call, and the Conversations tab for who wrote in.

The owner must allow the script once in Claude Code, by adding the permission
rule `Bash(node scripts/ads-sync.mjs:*)` to the project's
`.claude/settings.local.json` `permissions.allow` (via `/permissions` or the
settings file). Claude should not add it itself.

### Live prefills (Sept 2026 Smart Websites campaign)

| Ad | Id | Prefill |
| --- | --- | --- |
| A | `120244355303630395` | Hi Arc, I'd like to book a call about a Smart Website for our company. |
| B | `120244355304550395` | Hi Arc, our company is missing enquiries. Can we book a call about a Smart Website? |

Campaign `120244355299530395`, ad set `120244355301620395`, account
`1148854332990641`; flight 2026-09-12 19:10 → 2026-09-15 23:59 (+05:30),
Rs 2,500/day.
