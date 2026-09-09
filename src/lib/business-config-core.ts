/**
 * Who this deployment is, as data rather than as literals in fifty files.
 *
 * The CRM was written for one company, so the company is spelled out
 * wherever it is needed: 50 `Asia/Colombo` literals, 186 LKR/"Rs." sites,
 * 39 mentions of a Sri Lankan agency in prompts, and three separate company
 * constants (PROPOSAL_COMPANY, INVOICE_COMPANY, AGREEMENT_COMPANY). That was
 * the right call for one deployment and is the wrong one for two.
 *
 * This module is the reader half, and only the reader half. The defaults
 * below are EXACTLY what the code already does, so adopting it changes no
 * behaviour — it just gives new code somewhere to ask instead of somewhere
 * new to hardcode. The sweep that replaces the existing literals is a
 * separate job, deliberately left until a second deployment makes the right
 * shape obvious; doing it speculatively means guessing which of the 186
 * currency sites are "this company's money" and which are "this record's
 * currency", and those are different questions.
 *
 * Pure and dependency-free so it can be unit-tested and imported from
 * anywhere. The database read lives in `business-config.ts`.
 */

export type BusinessIdentity = {
  /** The registered entity name — what a signed document must say. */
  name: string;
  /** A trading name, for prose. Falls back to `name`. */
  tradingName: string;
  registrationNumber: string;
  incorporatedIn: string;
  email: string;
  website: string;
  phones: string;
  /** General correspondence address, most specific line first. */
  addressLines: string[];
  /** The registered office, and only that — what an agreement prints. */
  registeredOfficeLines: string[];
};

export type BusinessLocale = {
  /** IANA zone. Every "today" and every quiet-hours window resolves here. */
  timezone: string;
  /** ISO 4217. The default for new money records. */
  currency: string;
  /** What the UI prints before an amount. */
  currencySymbol: string;
  /** BCP 47, for date and number formatting. */
  locale: string;
};

export type BusinessVoice = {
  /**
   * How the assistant describes the business to a stranger. Interpolated
   * into system prompts that currently say "ARC AI, a Sri Lankan digital
   * agency" in 39 places.
   */
  descriptor: string;
  /** Outside these hours automated contact waits. 24-hour clock, local. */
  quietStartHour: number;
  quietEndHour: number;
};

export type BusinessConfig = {
  identity: BusinessIdentity;
  locale: BusinessLocale;
  voice: BusinessVoice;
};

/**
 * Today's behaviour, written down.
 *
 * Every value here is copied from the constant that currently owns it, so
 * `businessConfig()` and the existing literals agree until the sweep runs:
 *   identity.name / email / website / phones  — src/lib/invoice.ts:10
 *   identity.registeredOfficeLines            — src/lib/agreement-templates.ts:29
 *   identity.registrationNumber               — the public Terms, §2
 *   locale.timezone                           — the 50 Asia/Colombo literals
 */
export const DEFAULT_BUSINESS_CONFIG: BusinessConfig = {
  identity: {
    name: "ARC AI (PVT) LTD",
    tradingName: "ARC AI",
    registrationNumber: "PV00352581",
    incorporatedIn: "Sri Lanka",
    email: "support@arcai.agency",
    website: "www.arcai.agency",
    phones: "+94771852522, +447466368427",
    addressLines: ["No 8, Milagiriya AV, Colombo 4, Sri Lanka", "Birmingham, UK"],
    registeredOfficeLines: ["91 Daisy Villa Avenue, Colombo 4, Sri Lanka"],
  },
  locale: {
    timezone: "Asia/Colombo",
    currency: "LKR",
    currencySymbol: "Rs.",
    locale: "en-LK",
  },
  voice: {
    descriptor: "a Sri Lankan digital agency",
    quietStartHour: 21,
    quietEndHour: 8,
  },
};

/** A string worth taking from stored settings: present and not blank. */
function usableString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** A string list worth taking: non-empty, and every entry a usable string. */
function usableLines(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(usableString);
}

function usableHour(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23;
}

/**
 * Overlay stored settings on the defaults.
 *
 * Deliberately forgiving in one direction only: a missing, blank or
 * wrong-typed value falls back to the default rather than blanking the
 * field. A half-filled settings form must not erase the company name off
 * every invoice — the failure mode of a config layer is that it makes the
 * product WORSE than the literals it replaced, and this is where that is
 * prevented.
 */
export function mergeBusinessConfig(
  stored: unknown,
  defaults: BusinessConfig = DEFAULT_BUSINESS_CONFIG,
): BusinessConfig {
  const s = (stored ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const id = s.identity ?? {};
  const lo = s.locale ?? {};
  const vo = s.voice ?? {};

  return {
    identity: {
      name: usableString(id.name) ? id.name.trim() : defaults.identity.name,
      tradingName: usableString(id.tradingName)
        ? id.tradingName.trim()
        : usableString(id.name)
          ? id.name.trim()
          : defaults.identity.tradingName,
      registrationNumber: usableString(id.registrationNumber)
        ? id.registrationNumber.trim()
        : defaults.identity.registrationNumber,
      incorporatedIn: usableString(id.incorporatedIn)
        ? id.incorporatedIn.trim()
        : defaults.identity.incorporatedIn,
      email: usableString(id.email) ? id.email.trim() : defaults.identity.email,
      website: usableString(id.website)
        ? id.website.trim()
        : defaults.identity.website,
      phones: usableString(id.phones)
        ? id.phones.trim()
        : defaults.identity.phones,
      addressLines: usableLines(id.addressLines)
        ? id.addressLines.map((l) => l.trim())
        : defaults.identity.addressLines,
      // An agreement prints the registered office. If only a general address
      // is configured, that is a better answer than another company's.
      registeredOfficeLines: usableLines(id.registeredOfficeLines)
        ? id.registeredOfficeLines.map((l) => l.trim())
        : usableLines(id.addressLines)
          ? id.addressLines.map((l) => l.trim())
          : defaults.identity.registeredOfficeLines,
    },
    locale: {
      timezone: usableString(lo.timezone)
        ? lo.timezone.trim()
        : defaults.locale.timezone,
      currency: usableString(lo.currency)
        ? lo.currency.trim().toUpperCase()
        : defaults.locale.currency,
      currencySymbol: usableString(lo.currencySymbol)
        ? lo.currencySymbol.trim()
        : defaults.locale.currencySymbol,
      locale: usableString(lo.locale) ? lo.locale.trim() : defaults.locale.locale,
    },
    voice: {
      descriptor: usableString(vo.descriptor)
        ? vo.descriptor.trim()
        : defaults.voice.descriptor,
      quietStartHour: usableHour(vo.quietStartHour)
        ? vo.quietStartHour
        : defaults.voice.quietStartHour,
      quietEndHour: usableHour(vo.quietEndHour)
        ? vo.quietEndHour
        : defaults.voice.quietEndHour,
    },
  };
}
