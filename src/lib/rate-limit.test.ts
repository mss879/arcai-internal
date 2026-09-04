import { describe, expect, it } from "vitest";

import { clientIp, enforceRateLimit } from "./rate-limit";

/** A Supabase stand-in: only `rpc` is ever called. */
function db(rpc: () => Promise<{ data: unknown; error: unknown }>) {
  return { rpc } as unknown as Parameters<typeof enforceRateLimit>[0];
}

const allows = db(async () => ({ data: true, error: null }));
const refuses = db(async () => ({ data: false, error: null }));
const broken = db(async () => ({ data: null, error: { message: "boom" } }));

// The in-process Map is module-global, so every test uses its own key.
let n = 0;
const key = () => `test:${n++}`;

describe("enforceRateLimit", () => {
  it("allows requests up to the limit and refuses the next", async () => {
    const k = key();
    for (let i = 0; i < 3; i++) {
      expect((await enforceRateLimit(allows, k, { limit: 3, windowSec: 60 })).ok).toBe(
        true,
      );
    }
    const blocked = await enforceRateLimit(allows, k, { limit: 3, windowSec: 60 });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("forgets the window once it has passed", async () => {
    const k = key();
    const t0 = 1_000_000;
    await enforceRateLimit(allows, k, { limit: 1, windowSec: 60 }, t0);
    expect(
      (await enforceRateLimit(allows, k, { limit: 1, windowSec: 60 }, t0 + 1_000)).ok,
    ).toBe(false);
    // A minute later the allowance is back.
    expect(
      (await enforceRateLimit(allows, k, { limit: 1, windowSec: 60 }, t0 + 61_000)).ok,
    ).toBe(true);
  });

  it("keeps buckets separate, so one endpoint can't exhaust another", async () => {
    const a = key();
    const b = key();
    await enforceRateLimit(allows, a, { limit: 1, windowSec: 60 });
    expect((await enforceRateLimit(allows, a, { limit: 1, windowSec: 60 })).ok).toBe(
      false,
    );
    expect((await enforceRateLimit(allows, b, { limit: 1, windowSec: 60 })).ok).toBe(
      true,
    );
  });

  it("refuses when the shared counter says the limit is spent", async () => {
    // Another serverless instance has already used the allowance, so the
    // in-process Map here is empty and only the RPC knows.
    const res = await enforceRateLimit(refuses, key(), { limit: 100, windowSec: 60 });
    expect(res.ok).toBe(false);
    expect(res.retryAfter).toBe(60);
  });

  it("fails OPEN when the counter is unreachable", async () => {
    // A limiter that takes the public surface down when the database has a
    // bad minute is a worse outage than the abuse it prevents.
    expect((await enforceRateLimit(broken, key(), { limit: 1, windowSec: 60 })).ok).toBe(
      true,
    );
  });
});

describe("clientIp", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("prefers the header the proxy sets, which a client cannot forge", () => {
    expect(
      clientIp(
        h({
          "x-nf-client-connection-ip": "203.0.113.7",
          "x-forwarded-for": "198.51.100.1",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("takes only the first entry of x-forwarded-for", () => {
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7, 198.51.100.1" }))).toBe(
      "203.0.113.7",
    );
  });

  it("buckets unidentifiable callers together rather than exempting them", () => {
    expect(clientIp(h({}))).toBe("unknown");
  });
});
