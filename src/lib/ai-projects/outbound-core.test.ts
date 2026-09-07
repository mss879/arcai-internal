import { describe, expect, it } from "vitest";

import {
  checkPath,
  classifyFailure,
  isBlockedAddress,
  joinPath,
  parseClientUrl,
  parseIpv4,
  parseIpv6,
} from "./outbound-core";

describe("isBlockedAddress", () => {
  it("blocks every private and special IPv4 range", () => {
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254", // the cloud metadata endpoint
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1", // CGNAT
      "198.18.0.1", // benchmarking
      "224.0.0.1", // multicast
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.167.1.1", "100.63.255.255"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback, unique-local, link-local and multicast", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("sees through an IPv4-mapped IPv6 address", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("refuses anything it cannot parse", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("999.1.1.1")).toBe(true);
  });

  it("rejects octal-looking octets rather than guessing", () => {
    expect(parseIpv4("0177.0.0.1")).toBeNull();
    expect(isBlockedAddress("0177.0.0.1")).toBe(true);
  });
});

describe("parseIpv6", () => {
  it("expands shorthand and mapped forms", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("fe80::1")?.[0]).toBe(0xfe80);
    expect(parseIpv6("::ffff:1.2.3.4")?.slice(5)).toEqual([0xffff, 0x0102, 0x0304]);
    expect(parseIpv6("2001:db8::1")?.length).toBe(8);
    expect(parseIpv6("gggg::1")).toBeNull();
    expect(parseIpv6("1::2::3")).toBeNull();
  });
});

describe("parseClientUrl", () => {
  it("accepts an ordinary https site", () => {
    const res = parseClientUrl("https://www.example.com");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.host).toBe("www.example.com");
  });

  it("refuses http in production but allows localhost in development", () => {
    expect(parseClientUrl("http://www.example.com").ok).toBe(false);
    expect(parseClientUrl("http://localhost:3000").ok).toBe(false);
    expect(parseClientUrl("http://localhost:3000", { allowLocal: true }).ok).toBe(true);
    expect(parseClientUrl("http://127.0.0.1:3000", { allowLocal: true }).ok).toBe(true);
    // The escape hatch is localhost only — it is not a way in for anything else.
    expect(parseClientUrl("http://10.0.0.5", { allowLocal: true }).ok).toBe(false);
  });

  it("refuses literal private addresses and internal names", () => {
    for (const url of [
      "https://127.0.0.1",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/api",
      "https://[::1]/api",
      "https://printer.local",
      "https://api.internal",
      "https://intranet",
    ]) {
      expect(parseClientUrl(url).ok, url).toBe(false);
    }
  });

  it("refuses credentials in the URL and plain nonsense", () => {
    expect(parseClientUrl("https://user:pass@example.com").ok).toBe(false);
    expect(parseClientUrl("not a url").ok).toBe(false);
    expect(parseClientUrl("").ok).toBe(false);
    expect(parseClientUrl("ftp://example.com").ok).toBe(false);
  });

  it("allows a public literal address", () => {
    const res = parseClientUrl("https://8.8.8.8");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.literalAddress).toBe("8.8.8.8");
  });
});

describe("paths", () => {
  it("joins without doubling or dropping a slash", () => {
    expect(joinPath("https://a.com", "/api/x")).toBe("https://a.com/api/x");
    expect(joinPath("https://a.com/", "api/x")).toBe("https://a.com/api/x");
  });

  it("validates what the agency types", () => {
    expect(checkPath("/api/arc/lead").ok).toBe(true);
    expect(checkPath("api/arc/lead").ok).toBe(false);
    expect(checkPath("/api/../../etc").ok).toBe(false);
    expect(checkPath("/api/ arc").ok).toBe(false);
    expect(checkPath("").ok).toBe(false);
  });
});

describe("classifyFailure", () => {
  it("turns a thrown error into something an admin can act on", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(classifyFailure(timeout)).toContain("did not answer in time");
    expect(classifyFailure(new Error("getaddrinfo ENOTFOUND nope.example"))).toContain("could not be found");
    expect(classifyFailure(new Error("connect ECONNREFUSED 1.2.3.4:443"))).toContain("refused");
    expect(classifyFailure(new Error("boom"))).toBe("boom");
  });
});
