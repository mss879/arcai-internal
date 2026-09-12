import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Unit tests, for the parts of this app that are pure logic and expensive to
 * be wrong about. Not a general test harness: `include` is deliberately a
 * short list rather than a glob over the whole tree, so adding a test stays
 * a decision someone makes on purpose.
 *
 * Node environment on purpose — nothing under test touches the DOM. And an
 * `.mts` extension on purpose: this package is CommonJS, so a `.ts` config
 * gets loaded as CJS and Vite warns about the ESM syntax in it.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: [
      "src/components/assistant/interactivity/*.test.ts",
      // 0128 — does a heartbeat continue a session or start a new one. The
      // monitor was silently blind for weeks the last time this was wrong.
      "src/lib/activity-core.test.ts",
      // 0112 — the one number the client sees; cheap to test, costly to get wrong.
      "src/lib/project-progress.test.ts",
      // The money invariant: deposit_paid and the payment rows are the same
      // money. Four screens read this; adding them doubles every total.
      "src/lib/projects.test.ts",
      // The automation engine's pure decisions — does it fire, what does the
      // message say. Extracted from the server-only engine so they can run.
      "src/lib/automation-core.test.ts",
      // What the portal tells a client to send today. The figure is read
      // before they pay; asking for the wrong number is expensive.
      "src/lib/payment-terms.test.ts",
      // What the uploaded invoice and proposal SAY, read against the real
      // documents. A misread here fills the project value with the wrong number.
      "src/lib/document-brief.test.ts",
      // Which channel a client's tracking link goes out on.
      "src/lib/portal-send-core.test.ts",
      // Templates render the same on the server and in the compose preview.
      "src/lib/email-templates.test.ts",
      // Calendar invites — a malformed .ics is silently rejected by the
      // calendar, so the format is pinned rather than eyeballed.
      "src/lib/ics.test.ts",
      // 0116 — the gate in front of every public endpoint. Getting the
      // fail-open direction wrong takes the whole public surface down.
      "src/lib/rate-limit.test.ts",
      // 0117 — a document somebody signs must not be able to carry a
      // script, so escaping is pinned rather than assumed.
      "src/lib/markdown.test.ts",
      // 0119 — every recurring-task bug is a date bug, and they are all
      // invisible until the wrong week.
      "src/lib/todo-recurrence.test.ts",
      // 0119 — the one definition of "money in". Three screens read it, and
      // the moment two of them disagree the whole page is untrustworthy.
      "src/lib/finance-math.test.ts",
      // T4.6 — the client's statement. Its closing balance is a number on a
      // letterhead their accountant reconciles against; the ways it can be
      // wrong (money counted twice, money missed) are all silent.
      "src/lib/statement.test.ts",
      // The web-analytics job's state machine: which phase comes next, how a
      // cursor moves, when a killed step is given up on. Every bug here is a
      // sync that silently stops — or one that never stops.
      "src/lib/web-analytics/job-core.test.ts",
      // 0125 — the rules that decide which website conversions are leads and
      // which are the newsletter script. Every conversion figure rests on them.
      "src/lib/web-analytics/ledger-core.test.ts",
      // Which `reasoning_effort` each model will actually accept. The two
      // halves of the GPT-5 family want opposite values, and the wrong one
      // is a 400 on every turn — invisible until a visitor types something.
      "src/lib/ai/reasoning-core.test.ts",
      // 0126 — AI Projects. Tokens → dollars is the one conversion every
      // client invoice rests on; the promo/list price boundary is a date.
      "src/lib/ai-projects/pricing-core.test.ts",
      // 0126 — the monthly bill: fee, markup, minimum, FX and rounding.
      // Every way it can be wrong is a number a client pays.
      "src/lib/ai-projects/billing-core.test.ts",
      // 0126 — which website may use a project. Getting the wildcard or the
      // port wrong either locks a client out or lets the world in.
      "src/lib/ai-projects/origin-core.test.ts",
      // 0126 — the Colombo day and month every usage row and bill is filed
      // under; the failure mode is a late-evening chat on next month's bill.
      "src/lib/ai-projects/time-core.test.ts",
      // 0126 — chunk sizes, overlap and the hash that decides whether a
      // re-crawled page costs embedding tokens again.
      "src/lib/ai-projects/kb-core.test.ts",
      // 0126 — the crawl job's state machine; a bug here is a crawl that
      // never finishes or one that never stops.
      "src/lib/ai-projects/crawl-core.test.ts",
      // 0126 — the request caps, the history window and the SHAPE of the
      // system prompt (static before dynamic keeps prompt caching paying).
      "src/lib/ai-projects/chat-core.test.ts",
      // 0126 — the widget's wire format; the widget carries a hand-ported
      // copy of this parser, so the reference must be pinned.
      "src/lib/ai-projects/stream-core.test.ts",
      // 0127 — the SSRF guard in front of every call to a client's server.
      // Getting one range wrong points the agency's own server at its own
      // network, including the cloud metadata endpoint.
      "src/lib/ai-projects/outbound-core.test.ts",
      // 0127 — the signature on everything crossing to a client's backend.
      // The kit carries a copy of the verifier, so the scheme is pinned.
      "src/lib/ai-projects/signature.test.ts",
      // 0127 — the last gate before a model's arguments are POSTed to a
      // client's live system. A model's arguments are a suggestion.
      "src/lib/ai-projects/tool-core.test.ts",
      // 0127 — when a lead delivery is retried and when it gives up. A lead
      // is the most valuable thing this system produces; losing one is loud.
      "src/lib/ai-projects/delivery-core.test.ts",
      // 0129 — the defaults every unconfigured deployment falls back to.
      // A config layer's own failure mode is blanking a field it was meant
      // to supply; these pin that a half-filled form changes nothing.
      "src/lib/business-config-core.test.ts",
      // 0130 — the Responses API wire format. Text read from the wrong field
      // is null; usage read from the wrong field meters every agent at $0.
      "src/lib/ai/responses-core.test.ts",
      // 0130 — the Content Office's cost-safety rules: leases, the two
      // counters, plan validation, the renderer's copy shape, schedule times.
      "src/lib/agents/office-core.test.ts",
      // 0130 — the roster: a tool an agent is promised but does not have is a
      // robot that stands at its desk forever.
      "src/lib/agents/roster.test.ts",
      // 0130 — which desk a robot walks to for which state; filler bots are
      // deterministic so the floor never jumps on a re-render.
      "src/app/(app)/content/office/office-sim.test.ts",
      // 0130 — the floor is a level: every desk must be reachable from the
      // door through the gate, and rotation must keep the geometry honest.
      "src/app/(app)/content/office/office-layout.test.ts",
      // 0132 — which ad a WhatsApp chat is credited to. The prefill match is
      // the only evidence when Meta drops the referral; too loose and every
      // organic "Hi" becomes ad revenue, too strict and the ad looks dead.
      "src/lib/meta-ads/attribution-core.test.ts",
      // 0132 — the rules that tell the owner to act on a campaign. A wrong
      // threshold direction is a live ad left burning money, silently.
      "src/lib/meta-ads/health-core.test.ts",
      // 0132 — spend totals, windows and Colombo days on /ads. Summing the
      // campaign row AND its ads counts every rupee twice.
      "src/lib/meta-ads/report-core.test.ts",
      // 0132 — the payload contract the sync script enforces before it
      // writes production spend. A money string or a typo'd key must be an
      // error, never a silently wrong number.
      "scripts/ads-sync-core.test.mjs",
    ],
  },
});
