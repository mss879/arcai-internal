import "server-only";

/**
 * Best-effort domain intelligence for the CRM website audit:
 *   - registration date + age  (RDAP — the modern, free, keyless successor to
 *     WHOIS; https://rdap.org bootstraps to the right registry)
 *   - registrar
 *   - HTTPS + a hosting/tech hint from the live response headers
 *
 * Never throws — returns null (or partial fields) so a registry that doesn't
 * speak RDAP (some ccTLDs, incl. parts of .lk) simply yields less, not an error.
 */

export type DomainInfo = {
  domain: string;
  /** ISO date (YYYY-MM-DD) the domain was registered, or "". */
  registered: string;
  /** Whole years since registration, or 0 if unknown. */
  ageYears: number;
  registrar: string;
  /** A short hosting/stack hint from Server / X-Powered-By, or "". */
  hosting: string;
  /** Whether the site serves over HTTPS. */
  ssl: boolean;
};

const RDAP_TIMEOUT_MS = 8000;
const HEAD_TIMEOUT_MS = 8000;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function yearsSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  const years = (Date.now() - then) / (365.25 * 24 * 3600 * 1000);
  return years > 0 ? Math.floor(years) : 0;
}

/** Pull the registrar's display name out of an RDAP `entities` block. */
function registrarFrom(json: Record<string, unknown>): string {
  const entities = Array.isArray(json.entities)
    ? (json.entities as Record<string, unknown>[])
    : [];
  for (const e of entities) {
    const roles = Array.isArray(e.roles) ? (e.roles as unknown[]) : [];
    if (!roles.includes("registrar")) continue;
    // vcardArray = ["vcard", [ ["version",...], ["fn", {}, "text", "Name"], ... ]]
    const vcard = Array.isArray(e.vcardArray) ? e.vcardArray[1] : null;
    if (Array.isArray(vcard)) {
      for (const field of vcard as unknown[]) {
        if (
          Array.isArray(field) &&
          field[0] === "fn" &&
          typeof field[3] === "string"
        ) {
          return field[3].trim();
        }
      }
    }
  }
  return "";
}

/** A friendly hosting label from response headers (Server / X-Powered-By). */
function hostingHint(server: string | null, poweredBy: string | null): string {
  const parts = [server, poweredBy]
    .map((s) => (s ? s.trim() : ""))
    .filter(Boolean);
  if (!parts.length) return "";
  // Keep it short — the first token of Server is usually the platform.
  return parts.join(" · ").slice(0, 60);
}

export async function lookupDomainInfo(url: string): Promise<DomainInfo | null> {
  const domain = hostOf(url);
  if (!domain) return null;

  let registered = "";
  let ageYears = 0;
  let registrar = "";
  let ssl = false;
  let hosting = "";

  // RDAP registration data + the live HEAD probe run in parallel.
  const [rdap, head] = await Promise.allSettled([
    fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json" },
      redirect: "follow",
      signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
    }),
    fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    }),
  ]);

  if (rdap.status === "fulfilled" && rdap.value.ok) {
    try {
      const json = (await rdap.value.json()) as Record<string, unknown>;
      const events = Array.isArray(json.events)
        ? (json.events as Record<string, unknown>[])
        : [];
      const reg = events.find((e) => e.eventAction === "registration");
      const when = typeof reg?.eventDate === "string" ? reg.eventDate : "";
      if (when) {
        registered = when.slice(0, 10);
        ageYears = yearsSince(when);
      }
      registrar = registrarFrom(json);
    } catch {
      // malformed RDAP — leave the fields empty
    }
  }

  if (head.status === "fulfilled") {
    const r = head.value;
    ssl = r.url.startsWith("https://") || url.startsWith("https://");
    hosting = hostingHint(r.headers.get("server"), r.headers.get("x-powered-by"));
  } else {
    // HEAD failed but the URL we were given may still be https.
    ssl = url.startsWith("https://");
  }

  if (!registered && !hosting && !ssl && !registrar) return null;
  return { domain, registered, ageYears, registrar, hosting, ssl };
}
