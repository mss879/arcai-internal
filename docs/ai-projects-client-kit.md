# The client backend link — the contract

Everything that crosses between the ARC CRM and a client's own website
(migration **0127**). Hand this to whoever maintains the client's site.

The whole link is deliberately narrow: **one origin, one shared secret, signed
traffic in both directions.**

```
CRM  ──signed POST──►  the client's site      a captured lead
CRM  ──signed POST──►  the client's site      the agent asking or acting
CRM  ◄──Bearer key──   the client's server    their own dashboard reading back
```

---

## 1. The signature

Every request the CRM sends carries three headers:

```
X-Arc-Timestamp: 1757251200
X-Arc-Signature: v1=<hex hmac-sha256("<timestamp>.<raw body>", ARC_AI_SECRET)>
X-Arc-Project:   pk_…
```

Rules that matter:

- **Verify before you parse.** Sign the raw body text, exactly as it arrived.
  Signing what your JSON parser produced means the check has quietly stopped
  covering the bytes that were actually sent.
- The timestamp is *inside* the signed string, so it cannot be moved without
  breaking the signature.
- Reject anything more than **five minutes** out of step, in either direction.
  That is what stops a captured request being replayed tomorrow.
- Compare with a constant-time comparison, not `===`.

`lib/arc.ts` in the kit does all of this in about forty lines. Use it rather
than writing your own.

A write also carries:

```
X-Arc-Idempotency-Key: <32 hex chars>
```

The same request retried carries the same key. **Store it and refuse a
repeat**, or a retry becomes a second booking.

---

## 2. A captured lead

`POST` to your lead endpoint (default `/api/arc/lead`).

```jsonc
{
  "event": "lead.captured",        // or "handoff.requested"
  "project": "pk_…",
  "delivery_id": "…",              // also the idempotency key
  "lead_id": "…",
  "conversation_id": "…",
  "lead": {
    "name": "Nimal Perera",
    "email": "nimal@example.com",
    "phone": "077 123 4567",
    "company": null,
    "interest": "Wants a quote for a kitchen refit",
    "page_url": "https://client.com/kitchens",
    "status": "new",
    "captured_at": "2026-09-07T09:14:02.113Z"
  },
  "conversation": { "started_at": "…", "messages": 6, "page_url": "…", "page_title": "…", "summary": null },
  "sent_at": "2026-09-07T09:14:03.001Z"
}
```

- A connection test arrives with `"test": true` and no lead. Answer it and do
  nothing else.
- **Answer 2xx or it will be retried** — five times over about nine hours,
  then given up on and shown as failed in the CRM. That retry window is
  deliberate: it covers a redeploy, a restart, and a server that is down
  overnight.

---

## 3. Tools — the agent asking, or acting

`POST` to `/api/arc/tools/[tool]`.

```jsonc
{
  "tool": "check_availability",
  "arguments": { "date": "2026-09-10" },   // exactly the fields defined in the CRM
  "conversation_id": "…",
  "project": "pk_…",
  "preview": false,
  "sent_at": "…"
}
```

Answer with one of:

```jsonc
{ "ok": true, "result": { "free": true, "times": ["09:00", "14:30"] } }
{ "ok": true, "message": "Booked for Thursday at 3pm." }
{ "ok": false, "error": "Fully booked that day." }
```

Three things to hold on to:

1. **A visitor is waiting.** The CRM gives up after the tool's timeout
   (8 seconds by default, 12 at most) and the agent apologises instead of
   answering. Be quick or be asynchronous.
2. **Whatever you return may be read aloud to a stranger.** Never put internal
   ids, unpublished prices, or another customer's details in a result.
3. **Arguments are checked before they reach you** — types coerced, unknown
   keys dropped, required fields enforced — but they still originate from a
   language model talking to a member of the public. Validate again, and
   re-check anything that matters before you write it.

### The calendar pair

When a project's calendar provider is **the client's own endpoint**, two tools
are supplied automatically:

| Tool | Arguments | Answer with |
| --- | --- | --- |
| `check_availability` | `date` (YYYY-MM-DD) | `{ ok, result: { date, free, times: ["09:00", …], timezone } }` |
| `book_appointment` | `date`, `time` (HH:MM), `name`, `email`, `notes?` | `{ ok, result: { booked: true, … }, message }` |

`book_appointment` is a **write**: it carries an idempotency key, the agent
must confirm with the visitor before calling it, and it is capped at three
calls per conversation. Re-check the slot is still free before you write it —
two visitors can agree to the same time thirty seconds apart.

This is also the right home for a Google or Outlook refresh token: on the
business's own server, under their control. The CRM never sees the calendar,
only the free times you return.

---

## 4. Reading leads back — their own dashboard

The client's **server** holds a read key and renders its own page.

```
Authorization: Bearer arck_…
```

| Route | Returns |
| --- | --- |
| `GET /api/ai/v1/leads?since=&status=&limit=` | Their leads, newest first |
| `GET /api/ai/v1/conversations?since=&limit=` | Conversation summaries |
| `GET /api/ai/v1/conversations/:id` | One transcript |
| `GET /api/ai/v1/summary?days=30` | Counts for a dashboard header |
| `PATCH /api/ai/v1/leads/:id` | `{ "status": "contacted" }` — the one write |

**These routes send no CORS headers and answer no preflight.** That is on
purpose: the key is for a server, and a browser therefore cannot use it even
if it ends up in a page's source. Never expose it as `NEXT_PUBLIC_`.

Cost, tokens, prompts, models and billing never appear in a response.

---

## 5. Writing into a Supabase instead

A client with a Supabase project and no endpoint can have leads inserted
directly into their own table.

The CRM stores their **anon key** and nothing else, and their database carries
exactly one policy:

```sql
alter table public.leads enable row level security;

drop policy if exists "arc assistant can add leads" on public.leads;
create policy "arc assistant can add leads"
  on public.leads for insert to anon
  with check (true);
```

That is the whole of what the stored key can do. It cannot read their
customers, cannot delete, and cannot touch another table.

**A service-role key is refused by the CRM**, and the form checks the JWT's
role claim to make sure one is not pasted in by mistake. A service key is full
admin on everything that client owns, and nothing here needs that.

---

## 6. What the CRM will not do

Worth stating plainly, because the client will ask:

- It never follows a redirect from your server. Point the setting at the final
  address.
- It never connects to a private or loopback address, and refuses a domain
  that resolves to one. Every URL is checked before anything is sent.
- It reads at most 64 KB of your response.
- It only ever calls the paths configured in the CRM. There is no general
  "call this URL" ability.
