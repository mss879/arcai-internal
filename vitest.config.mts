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
    ],
  },
});
