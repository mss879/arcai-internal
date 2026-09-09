import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUSINESS_CONFIG,
  mergeBusinessConfig,
} from "@/lib/business-config-core";

describe("mergeBusinessConfig", () => {
  it("returns the defaults for an unconfigured deployment", () => {
    expect(mergeBusinessConfig(null)).toEqual(DEFAULT_BUSINESS_CONFIG);
    expect(mergeBusinessConfig({})).toEqual(DEFAULT_BUSINESS_CONFIG);
    expect(mergeBusinessConfig(undefined)).toEqual(DEFAULT_BUSINESS_CONFIG);
  });

  it("overlays only what is set", () => {
    const c = mergeBusinessConfig({ locale: { timezone: "Asia/Dubai" } });
    expect(c.locale.timezone).toBe("Asia/Dubai");
    expect(c.locale.currency).toBe(DEFAULT_BUSINESS_CONFIG.locale.currency);
    expect(c.identity.name).toBe(DEFAULT_BUSINESS_CONFIG.identity.name);
  });

  // The failure mode that matters: a half-filled settings form must never
  // blank the company name off every invoice.
  it("ignores blank and wrong-typed values rather than erasing a field", () => {
    const c = mergeBusinessConfig({
      identity: { name: "   ", email: 42, addressLines: [] },
      locale: { timezone: "", currency: null },
      voice: { quietStartHour: 99, quietEndHour: "8" },
    });
    expect(c).toEqual(DEFAULT_BUSINESS_CONFIG);
  });

  it("normalises a currency code and trims strings", () => {
    const c = mergeBusinessConfig({
      identity: { name: "  Acme Ltd  " },
      locale: { currency: "aed" },
    });
    expect(c.identity.name).toBe("Acme Ltd");
    expect(c.locale.currency).toBe("AED");
  });

  it("falls back to the configured name for a trading name", () => {
    expect(
      mergeBusinessConfig({ identity: { name: "Acme Ltd" } }).identity.tradingName,
    ).toBe("Acme Ltd");
    expect(
      mergeBusinessConfig({
        identity: { name: "Acme Ltd", tradingName: "Acme" },
      }).identity.tradingName,
    ).toBe("Acme");
  });

  // An agreement prints the registered office. A deployment that configures
  // one address must not print the previous company's registered office.
  it("uses a configured address as the registered office when none is given", () => {
    const c = mergeBusinessConfig({
      identity: { addressLines: ["1 Nowhere St, Dubai"] },
    });
    expect(c.identity.registeredOfficeLines).toEqual(["1 Nowhere St, Dubai"]);
  });

  it("accepts 0 as a quiet hour", () => {
    const c = mergeBusinessConfig({ voice: { quietStartHour: 0, quietEndHour: 6 } });
    expect(c.voice.quietStartHour).toBe(0);
    expect(c.voice.quietEndHour).toBe(6);
  });
});
