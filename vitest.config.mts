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
      // Which channel a client's tracking link goes out on.
      "src/lib/portal-send-core.test.ts",
      // Templates render the same on the server and in the compose preview.
      "src/lib/email-templates.test.ts",
    ],
  },
});
