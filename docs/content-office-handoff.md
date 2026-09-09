# Content Office — handoff

**Read this first, then `AGENTS.md` and `docs/content-office.md`.**
Built and **SHIPPED 2026-09-09** on `arc_ai_crm_system` — `93aaa8e..25bb334`
on `mss879/arcai-internal` main, verified in a clean worktree before the push
(tsc, 423 tests, lint baseline, build). Migration 0130 is applied; **0131 (two
seed rows) still needs running.** Paste this into a new chat, or say: *"Read
`docs/content-office-handoff.md` — help me run the walkthrough and push."*

## 1. Where things stand

All build steps below are done. The gate passed on the final tree:

```bash
find .next/types -name "* [0-9].ts" -delete && npx tsc --noEmit && npx vitest run \
  && node scripts/lint-baseline.mjs && npm run build
```

461 tests across 38 files (5 new files: `responses-core`, `office-core`,
`roster`, `office-sim`, `office-layout`; `reasoning-core` extended). Lint
baseline unchanged.

### ⚠️ Before ANY push

1. ~~Apply `supabase/migrations/0130_content_office.sql`~~ — done 2026-09-09;
   `node scripts/schema-audit.mjs` reported 171 tables and every column from
   130 migrations live. **Apply `0131_office_generalists.sql` too** (two seed
   rows in `office_agents`; the agents work without it, admins just would not
   see their rows under Agents until the first edit).
2. Confirm the key can see the Director's model:
   `curl -s https://api.openai.com/v1/models/gpt-6-astra -H "Authorization: Bearer $OPENAI_API_KEY"`.
   A 404 is fine — the chain falls back to `gpt-5.6-sol` and says so on the
   task — but you should know which one is answering.
3. Optional env (all have defaults): see the `Content Office (0130)` block in
   `.env.example`. `SUPABASE_SERVICE_ROLE_KEY` must be set (it already is for
   every other privileged route).
4. Stage explicit paths — the tree still carries the unpushed hand-tracking
   feature under `src/components/assistant/interactivity/`. Never `git add -A`.

## 2. Build steps

| # | Step | Files | Status |
| --- | --- | --- | --- |
| 1 | Schema | `supabase/migrations/0130_content_office.sql`, `src/lib/database.types.ts`, `src/lib/types.ts`, `src/lib/ai-projects/usage.ts` | done |
| 2 | Responses API client | `src/lib/ai/responses.ts`, `responses-core.ts` (+test), `reasoning-core.ts` (+test; regex widened, `responsesEffortFor`), `ai-projects/chat-core.ts` (regex) | done |
| 3 | Runtime | `src/lib/agents/{roster,office-core,prompts,tool-names,tools,events,manager,runtime,schedules,tick,snapshot,office-types}.ts` (+tests) | done |
| 4 | Wiring | tick pass `contentOffice` in `src/app/api/automation/tick/route.ts`; approvals kind `content_mission` (`src/lib/approvals.ts`, approvals view); `assertCapability("marketing")` on every export of `content/actions.ts` | done |
| 5 | Actions | `src/app/(app)/content/office-actions.ts` | done |
| 6 | UI | `src/app/(app)/content/office/*` (layout + test, sim + test, robot, player, floor, proximity card, details modal, live hook, dock, drawer, feed, spend, timers, agents, brand, view), `content-view.tsx`, `page.tsx`, `loading.tsx`, `src/hooks/use-element-width.ts`, `globals.css` robot keyframes, nav + app-map labels | done |
| 6e | View-only for members (0132) | `assertDirector()` gates every write action in `office-actions.ts`; `driveOffice` returns a delta without stepping for members; the dock, decision block, retry, timers and "Give a task" are hidden. No migration. | done |
| 6d | Strong role briefs + realism pass | `src/lib/agents/prompts.ts` rewritten (house rules, instruction priority, autonomy, truth, slop blocklist, verification, stop condition; per-role method and quality bar); floor realism (shadows, lamp pools, windows, framed glass, lit screens, rugs, richer robots) with memoised furniture | done |
| 6c | Generalists (0131) | `supabase/migrations/0131_office_generalists.sql` (seed rows only), roster `ops_a`/`ops_b` on `gpt-5.6-sol`, tools `fetch_website` / `lookup_client` / `prepare_message` in `src/lib/agents/tools.ts`, `report` deliverable in `office-core.ts`, a Generalists' studio on the floor (world widened to 32×20), stats row + full-width floor + floating room signs + flip-aware proximity card | done |
| 6b | Walkable, rotatable floor | second pass on the owner's feedback: one 26×20 world with corridors, doors and a reception gate; four view rotations; a keyboard/pad-driven visitor; proximity cards with a Details button; bubble de-overlap; floor decals | done |
| 7 | Docs / env | `docs/content-office.md`, this file, `docs/ops.md`, `.env.example`, `vitest.config.mts` | done |

## 2b. Exactly what to stage

The tree also carries older uncommitted work (0129 access boundary,
business-config, schema-audit, the hand-tracking feature). This wave is only
these paths — stage them explicitly:

```bash
git add supabase/migrations/0130_content_office.sql \
  src/lib/ai/responses.ts src/lib/ai/responses-core.ts src/lib/ai/responses-core.test.ts \
  src/lib/ai/reasoning-core.ts src/lib/ai/reasoning-core.test.ts src/lib/ai-projects/chat-core.ts \
  src/lib/ai-projects/usage.ts src/lib/database.types.ts src/lib/types.ts src/lib/approvals.ts \
  src/lib/agents "src/app/(app)/content/office" "src/app/(app)/content/office-actions.ts" \
  "src/app/(app)/content/actions.ts" "src/app/(app)/content/content-view.tsx" \
  "src/app/(app)/content/page.tsx" "src/app/(app)/content/loading.tsx" \
  "src/app/(app)/approvals/approvals-view.tsx" src/app/api/automation/tick/route.ts \
  src/app/globals.css src/components/layout/nav.ts src/lib/ai/app-map.ts \
  src/components/ui/hover-card.tsx src/hooks/use-element-width.ts vitest.config.mts \
  .env.example docs/ops.md docs/content-office.md docs/content-office-handoff.md
```

## 3. Manual walkthrough (dry run)

1. `SOCIAL_DRY_RUN=1`. If no `social_accounts` row exists, insert a test one
   (`instagram`, `@test`, `external_id 'test'`, `active true`,
   `access_token_enc null`) — dry run returns before it reads the token.
2. Open `/content`. You stand on the door mat; Dot waits at reception; eight
   robots are at their desks and five visitors wander. Walk with the arrow
   keys through the gate; walk up to a robot for its card; press Enter or
   Details for the full modal. Q/E turn the view.
3. Brief: *"Plan 2 Instagram carousels for next week about AI automation for
   Sri Lankan SMEs."* Astra's visor goes amber; the hover card shows
   `gpt-6-astra` or the fallback note. The plan lands as tasks; the feed
   shows "Astra briefed Scout…"; both walk to the meeting room for a moment.
4. Scout searches (queries in the feed and hover card), Grid plans, Quill
   writes, Tone reviews, Pixel drafts (two posts appear in the Calendar at
   "Designing n/m slides" and keep rendering while the page is open), Audit
   checks (a `revise` sends Quill back once), Relay proposes times, Astra
   reviews → mission **Needs your approval**; the approvals badge ticks up.
5. Open the mission (rail or feed). Review designs → pick one per post →
   **Download** gives the slides and caption to post by hand → **Approve**
   closes the mission. With a connected account, **Approve & schedule** queues
   it instead and the `socialPublish` pass marks it Published (dry-run banner).
6. Direct mode: Assign to one agent → Scout → "Research three trending hooks
   for SME automation." One task, one brief, lands in review.
7. Timers: create a daily timer two minutes ahead; the next tick opens a
   mission unattended and `next_run_at` advances a day.
8. Kill test: stop the dev server mid-step; restart; the task resumes from
   its persisted response id; exactly one `ai_usage_events` row per response.
9. Cap: set the daily cap below today's spend (Office → spend meter pencil);
   new starts block, the mission pauses, the robot's visor goes red; raise
   the cap; Retry.

## 4. Known limitations

- Unattended runs are slow by design (one step per 5-minute tick, one slide
  per tick). Timers should fire hours ahead.
- Instagram/Facebook only; publishing is dry-run until `SOCIAL_TOKEN_KEY` is
  set and a Meta app review passes.
- `gpt-6-astra` availability depends on the key's rollout position.
