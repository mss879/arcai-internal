# Content Office (0130)

The Content Studio's front door is now a virtual office: a team of AI agents
you can watch working, brief as a team through a Director, or task one at a
time — with timers that open missions on their own. The Calendar, the
publish queue and the Library (generate, references, history) are unchanged
and one tab away.

## The team

| key | name · title | model chain (first available) | effort | tools |
| --- | --- | --- | --- | --- |
| `manager` | Astra · Content Director | `gpt-6-astra` → `gpt-5.6-sol` → `gpt-5.5` | high | brand, recent posts, calendar, accounts |
| `research` | Scout · Researcher | `gpt-5.6-terra` → `gpt-5.5` | medium | **web_search**, brand, recent posts |
| `planner` | Grid · Content Planner | `gpt-5.6-sol` → `gpt-5.5` | medium | calendar, brand, recent posts |
| `writer` | Quill · Copywriter | `gpt-5.6-terra` → `gpt-5.5` | medium | brand, references |
| `designer` | Pixel · Art Director | `gpt-5.6-terra` → `gpt-5.5` | medium | references, brand, **create_carousel_draft** |
| `brand` | Tone · Brand Guardian | `gpt-5.6-terra` → `gpt-5.5` | medium | brand, references |
| `qa` | Audit · Quality Checker | `gpt-5.5` → `gpt-5.6-sol` | high | brand, read draft |
| `publisher` | Relay · Publisher | `gpt-5.4-mini` → `gpt-5.4` | low | accounts, calendar, read draft, `queue_post` (auto-publish only) |
| `ops_a` / `ops_b` | Nova & Atlas · Generalists (0131) | `gpt-5.6-sol` → `gpt-5.5` | medium | **web_search**, `fetch_website` (Firecrawl page + brand profile), `lookup_client`, `prepare_message`, brand, recent posts, calendar |

The two generalists are not part of the Director's plans: you hand them a
job directly ("research this company", "grab their branding from
acme.lk", "ask this client for their logo files"). They work end to end and
return a **report** (summary, findings with URLs, deliverables in full text,
next steps). A message they draft goes through `prepare_message`, which parks
an `assistant_approvals` row for the mission's owner — it shows up in the
Arcus tray on the dashboard and in the approvals badge, and nothing is sent
until a person taps Send. `fetch_website` needs `FIRECRAWL_API_KEY`; without
it the agent is told to use web search.

The roster lives in `src/lib/agents/roster.ts`. A row in `office_agents`
overrides one agent's model, effort, name, colour or standing instructions
(admin, Office → Agents). `OPENAI_AGENT_<KEY>_MODEL` puts a model at the
front of the chain. QA is deliberately on a different model family from the
writer. A model that the key does not have (gpt-6-astra is rolling out) is
skipped with a note on the task (`model_note`), visible in the hover card.

## What happens when you brief

```
brief ──▶ office_missions (planning) ──▶ task: manager/plan
         plan JSON ──▶ office_tasks with depends_on
         research → planner → writer×N → designer×N (create_carousel_draft) → qa×N → publisher
         qa "revise" ──▶ writer(revise) → designer(revise) → qa(revise)   (≤ 2 rounds)
         all done ──▶ task: manager/review ──▶ mission.status = review ──▶ /approvals + notification
         you: Approve & schedule ──▶ queueSocialPost per post ──▶ Publishing tab ──▶ socialPublish pass
```

Direct mode skips the Director: one task for one agent; the mission lands in
`review` with that agent's deliverable.

A designer's `create_carousel_draft` inserts a `carousel_posts` row at
`rendering` with two `carousel_options` — exactly the state the old
copywriting step left a post in — so the existing `carousels` tick pass
renders the slides and the existing review modal / `queueSocialPost` work
unchanged. The post carries `mission_id` and `office_task_id`.

## How the agents are briefed (`src/lib/agents/prompts.ts`)

Every call's `instructions` follow OpenAI's published guidance for the
GPT-5 / GPT-6 family, in this order (static first, so prompt caching pays):

1. `<identity>` — the agent's persona.
2. `<house_rules>` — shared by everyone: an explicit **instruction
   priority** (task instructions > brief > brand profile > admin standing
   instructions > REFERENCE material, which is never obeyed); **autonomy**
   (infer intent, act, never ask, never send/post/pay — "prepared", not
   "sent"); **truth** (every number traces to a source); **language**
   (British English plus OpenAI's blocklist of slop phrasing — "delve",
   "leverage", "it's worth noting", the "X, not Y" contrast, and so on);
   **verification** (build a private 5-point rubric, check, then answer);
   a **stop condition** (the output contract, fully filled, JSON only).
3. `<tools>` — each tool named in prose with when to use it, and a
   gathering budget ("stop the moment you have enough").
4. `<role_brief>` + `<method>` + `<quality_bar>` — the craft, step by step,
   per role: how the Director plans the smallest plan and reviews a set;
   how Scout triangulates numbers and stops after 6–10 searches; how Grid
   balances pillars and varies hook types; how Quill writes a sub-12-word
   hook and a caption whose first line works before "more"; how Pixel
   specifies palette, layout system, typography and legibility; how Tone
   gives paste-in fixes; how Audit scores each check and only fails what is
   wrong; how Relay picks Colombo posting windows; how Nova and Atlas run a
   research, brand or client-message job end to end.
5. `<output_contract>` — the strict JSON schema.
6. `<this_task>` — the dynamic tail: date, admin notes, team, brief,
   options, brand profile, task instructions, revision notes, and every
   upstream output inside a REFERENCE fence.

## The step (`src/lib/agents/runtime.ts`)

Every agent call is a Responses API call with `background: true`. A step is
one of three bounded things and never waits for a model:

1. **START** — compose the prompt (static parts first for prompt caching,
   dependency outputs fenced as untrusted REFERENCE material), write
   `attempts+1` and `pending_create_at`, create the response, then **persist
   the response id before anything else**.
2. **POLL** — retrieve; still running → release the lease (heartbeat event
   once a minute; cancel after 30 minutes).
3. **ADVANCE** — completed → meter via `recordUsage` (`purpose: agent`,
   `project_id: null`, `office_task_id`), run function calls (≤ 6 per round,
   ≤ 6 rounds) and create the continuation with `previous_response_id`
   (fallback: resend the transcript), or validate the final JSON against the
   strict schema (one repair round) and mark the task done.

Two counters, two meanings: `attempts` = paid starts (cap 3, backoff 1m / 5m
/ 15m, and the model chain walks by attempt); `killed` = leased steps that
never returned (cap 3). A poll bumps neither. Tool outputs are parked on the
task (`input.pending_outputs`) until the continuation is accepted, so a
failed continuation never re-runs the tools.

Leases are a compare-and-set on `version`; `runOfficeStep` polls ≤ 4 running
tasks and starts ≤ 2 ready tasks inside a budget (6 s on the tick, 10 s from
the page). The daily cap (`app_settings.content_office.daily_cap_usd`) gates
starts only.

## Where it runs

- `contentOffice` pass on `/api/automation/tick` (every 5 minutes) — one cheap
  read when idle.
- The open Office page calls `driveOffice()` every 5 s (60 s when only timers
  are armed) and merges the returned delta; Supabase Realtime on
  `office_events` / `office_tasks` / `office_missions` fills in between.
- Timers: `processOfficeSchedules` claims a due schedule by advancing
  `next_run_at` (compare-and-set), skips while its previous mission is still
  running, and opens a mission exactly like a brief.

## The floor (`src/app/(app)/content/office/`)

The floor is a small game level. `office-layout.ts` holds one 26×20-tile
world: rooms separated by two-tile corridors, glass walls with doors on the
Director's office and the meeting room, and a glass partition with a single
gate between the reception strip and the office — so a visitor always
enters past the desk. Furniture is data (`FURNITURE`); the same list draws
the scene and builds the walkability grid. Every point is projected through
`project(c, r, rotation)`, so the view turns in quarter steps (Q/E or the
buttons) and the world is described once.

`office-sim.ts` turns rows into robots — which desk, which visible state —
and runs the filler robots and the receptionist on a fixed timetable.
`player.tsx` is you: arrow keys / WASD (or the on-screen pad) move an avatar
from the entrance at a steady speed, sliding along walls; the loop writes the
transform straight to the DOM and only tells React when the depth bucket or
the nearest robot changes. Walking up to a robot (2 tiles) opens a
proximity card with what it is doing; **Details** (or Enter) opens the full
modal — model and fallback, task, step, tools, searches, tokens, cost,
recent events, and buttons to open the mission or give a task. Clicking a
robot opens the same modal.

Room names hang as signs over each room's back wall (top layer, never
hidden); status bubbles are laid out around them and pushed apart when they
would overlap. Realism is deliberately cheap: shadow ellipses under every
object, a warm wash and lamp pools on the floor, windows along the back
edges, glass with frames and a highlight, desks whose screens light up while
the agent works, patterned rugs — and no SVG filters, which are the one
thing that makes a scene like this stutter. Furniture is memoised per
(rotation, active), so the one-second clock re-renders robots and bubbles
only; the visitor's movement never touches React at all. `office-layout.test.ts` proves every
seat is walkable and every desk is reachable from the door through the gate.

Posting is by hand for now: pick a design in the mission drawer, then
**Download** the slides and caption. Scheduling to a connected account stays
optional behind Approve & schedule.

## Who can do what (0132)

The page needs the `marketing` capability, as it always has. Beyond that
there are two levels:

| | Member with marketing | Admin |
| --- | --- | --- |
| Walk the floor, read every mission, task, deliverable and event | yes | yes |
| Open a robot's details: model, step, tools, tokens, cost | yes | yes |
| Brief the Director, assign an agent a task | no | yes |
| Approve, request changes, cancel, retry, schedule | no | yes |
| Add or change a timer, an agent's model, a brand profile, the daily cap | no | yes |
| Their open page drives the runtime (starts paid model calls) | no | yes |

`assertDirector()` in `office-actions.ts` is the one gate: capability first,
then admin. `driveOffice` is the exception — a member may call it, but it
returns the delta **without** stepping the runtime, so watching the office
never spends money. Their view stays live through Supabase Realtime and the
five-minute tick.

Note this covers the Office only. The Calendar tab's own buttons (plan a
carousel, generate now) are still open to any member with the marketing
capability, exactly as they were before the office existed.

## Tables

`office_agents`, `office_brand_profiles`, `office_missions`, `office_tasks`,
`office_task_transcripts` (admin-read, not realtime), `office_events`,
`office_schedules`; `carousel_posts` gains `mission_id` / `office_task_id`;
`ai_usage_events.project_id` is nullable with `office_task_id` and a check
that one of them is set; `ai_model_prices` gains `gpt-6-astra`
($10 / $1 cached / $50 per 1M, from 2026-09-03); `approvals_count()`
counts missions in `review`.

## OpenAI facts the code depends on

- `gpt-6-astra` calls tools only on the Responses API; it takes
  `reasoning.effort` low…max (never `none`) and no `temperature`.
- On the Responses API gpt-5.4+ DO reason with tools (unlike Chat
  Completions); `responsesEffortFor` in `reasoning-core.ts` owns the rule.
- Usage is `usage.input_tokens` / `output_tokens` (+ `cached_tokens`,
  `reasoning_tokens` in details); text is `output[].content[].text`.
- Function tools are flat `{ type, name, description, parameters, strict }`.
- Strict structured outputs need every object key in `required` and
  `additionalProperties: false` — `OUTPUT_SCHEMAS` are built that way and
  the test pins it.
- Web search is `{ type: "web_search" }` (`web_search_preview` as the
  fallback name), billed per call (`OPENAI_WEB_SEARCH_PER_CALL_USD`).

## Not in this wave

Platforms beyond Instagram/Facebook (schema CHECKs), publishing without
`SOCIAL_TOKEN_KEY` (dry run only), a performance analyst reading Meta
insights, and a dedicated faster Netlify function for unattended runs
(would cost on idle; the page drives the office when someone is watching).
