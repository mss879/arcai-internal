import { describe, expect, it } from "vitest";

import {
  formatOriginRule,
  normaliseOrigin,
  originAllowed,
  parseOriginList,
  parseOriginRule,
  requestOrigin,
} from "./origin-core";

describe("normaliseOrigin", () => {
  it("keeps scheme and host, drops paths and default ports, lowercases", () => {
    expect(normaliseOrigin("HTTPS://Www.Example.com/path?x=1")).toBe("https://www.example.com");
    expect(normaliseOrigin("https://example.com:443")).toBe("https://example.com");
    expect(normaliseOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normaliseOrigin("example.com")).toBe("https://example.com");
  });

  it("rejects non-web schemes and junk", () => {
    expect(normaliseOrigin("ftp://example.com")).toBeNull();
    expect(normaliseOrigin("null")).toBe("https://null");
    expect(normaliseOrigin("")).toBeNull();
    expect(normaliseOrigin(undefined)).toBeNull();
  });
});

describe("parseOriginRule", () => {
  it("reads the four shapes and canonicalises them", () => {
    expect(formatOriginRule(parseOriginRule("Example.com")!)).toBe("example.com");
    expect(formatOriginRule(parseOriginRule("https://www.example.com/pricing")!)).toBe(
      "https://www.example.com",
    );
    expect(formatOriginRule(parseOriginRule("*.example.com")!)).toBe("*.example.com");
    expect(formatOriginRule(parseOriginRule("http://localhost:3000")!)).toBe("http://localhost:3000");
  });

  it("rejects what is not an origin", () => {
    expect(parseOriginRule("*")).toBeNull();
    expect(parseOriginRule("*.localhost")).toBeNull();
    expect(parseOriginRule("intranet")).toBeNull();
    expect(parseOriginRule("ftp://example.com")).toBeNull();
    expect(parseOriginRule("example.com:abc")).toBeNull();
    expect(parseOriginRule("-bad.example.com")).toBeNull();
  });
});

describe("originAllowed", () => {
  const allowed = ["example.com", "https://shop.example.org", "*.client.lk", "http://localhost:3000"];

  it("matches exact hosts on either scheme when no scheme was given", () => {
    expect(originAllowed("https://example.com", allowed, null)).toBe(true);
    expect(originAllowed("http://example.com", allowed, null)).toBe(true);
    expect(originAllowed("https://www.example.com", allowed, null)).toBe(false);
  });

  it("honours a scheme when one was given", () => {
    expect(originAllowed("https://shop.example.org", allowed, null)).toBe(true);
    expect(originAllowed("http://shop.example.org", allowed, null)).toBe(false);
  });

  it("matches the apex and any subdomain for a wildcard", () => {
    expect(originAllowed("https://client.lk", allowed, null)).toBe(true);
    expect(originAllowed("https://www.client.lk", allowed, null)).toBe(true);
    expect(originAllowed("https://a.b.client.lk", allowed, null)).toBe(true);
    expect(originAllowed("https://notclient.lk", allowed, null)).toBe(false);
    expect(originAllowed("https://client.lk.evil.com", allowed, null)).toBe(false);
  });

  it("requires the port to match", () => {
    expect(originAllowed("http://localhost:3000", allowed, null)).toBe(true);
    expect(originAllowed("http://localhost:3001", allowed, null)).toBe(false);
    expect(originAllowed("https://example.com:8443", allowed, null)).toBe(false);
  });

  it("always allows the CRM's own origin, and never a missing one", () => {
    expect(originAllowed("https://www.arcai.online", [], "https://www.arcai.online/")).toBe(true);
    expect(originAllowed(null, allowed, "https://www.arcai.online")).toBe(false);
    expect(originAllowed("https://evil.com", [], "https://www.arcai.online")).toBe(false);
  });
});

describe("requestOrigin", () => {
  it("prefers Origin and falls back to the Referer's origin", () => {
    expect(requestOrigin("https://a.com", "https://b.com/page")).toBe("https://a.com");
    expect(requestOrigin(null, "https://b.com/page?x")).toBe("https://b.com");
    expect(requestOrigin(null, null)).toBeNull();
  });
});

describe("parseOriginList", () => {
  it("splits on lines and commas, dedupes, and reports rejects", () => {
    const res = parseOriginList("example.com, https://Example.com/x\n*.client.lk\nbogus\nexample.com");
    expect(res.origins).toEqual(["example.com", "https://example.com", "*.client.lk"]);
    expect(res.invalid).toEqual(["bogus"]);
  });
});
