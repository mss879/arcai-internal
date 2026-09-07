/**
 * The only origin decision (0126).
 *
 * A project's public key identifies it; the origin allow-list is the gate.
 * The widget runs on the client's site, so every request to /api/ai carries
 * the browser's `Origin` header (a preflight and a fetch alike), and this
 * module decides whether that origin may use the project. Never `*`: the
 * matching origin is echoed back, and a foreign one gets nothing.
 *
 * Entries the owner types are canonicalised by `parseOriginList` before they
 * are stored, so the stored form is always something `parseOriginRule` reads
 * back identically:
 *
 *   example.com                any scheme, that host, default port
 *   https://www.example.com    that scheme and host
 *   *.example.com              the apex and every subdomain
 *   http://localhost:3000      a dev server, port included
 */

export type OriginRule = {
  scheme: "http" | "https" | null;
  host: string;
  port: string | null;
  wildcard: boolean;
};

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Canonical `scheme://host[:port]` of an origin or URL, or null. */
export function normaliseOrigin(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return `${url.protocol}//${url.host.toLowerCase()}`;
}

/** One allow-list entry, read into a rule. Null when it is not an origin. */
export function parseOriginRule(entry: string): OriginRule | null {
  let s = entry.trim().toLowerCase();
  if (!s) return null;
  let scheme: OriginRule["scheme"] = null;
  const m = s.match(/^(https?):\/\//);
  if (m) {
    scheme = m[1] as "http" | "https";
    s = s.slice(m[0].length);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    return null;
  }
  // A pasted URL: keep the origin, drop the path/query/hash.
  s = s.replace(/[/?#].*$/, "");
  let wildcard = false;
  if (s.startsWith("*.")) {
    wildcard = true;
    s = s.slice(2);
  }
  const [host, port, ...rest] = s.split(":");
  if (rest.length || !host) return null;
  if (!HOST_RE.test(host)) return null;
  const isLocal = host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (!isLocal && !host.includes(".")) return null;
  if (wildcard && isLocal) return null;
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return null;
  return { scheme, host, port: port ?? null, wildcard };
}

/** The stored form of a rule — what `parseOriginList` writes. */
export function formatOriginRule(rule: OriginRule): string {
  return `${rule.scheme ? `${rule.scheme}://` : ""}${rule.wildcard ? "*." : ""}${rule.host}${rule.port ? `:${rule.port}` : ""}`;
}

/** Does a (canonical) origin satisfy one rule? */
export function ruleMatches(rule: OriginRule, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (rule.scheme && url.protocol !== `${rule.scheme}:`) return false;
  // `url.port` is "" for the scheme's default port, which is what a rule
  // without a port means.
  if ((rule.port ?? "") !== url.port) return false;
  const host = url.hostname.toLowerCase();
  if (rule.wildcard) return host === rule.host || host.endsWith(`.${rule.host}`);
  return host === rule.host;
}

/**
 * The decision. The CRM's own origin is always allowed — that is how the
 * Deploy tab's preview works — and everything else must match a rule.
 */
export function originAllowed(
  origin: string | null | undefined,
  allowed: readonly string[],
  crmOrigin: string | null | undefined,
): boolean {
  const o = normaliseOrigin(origin);
  if (!o) return false;
  const crm = normaliseOrigin(crmOrigin);
  if (crm && crm === o) return true;
  return allowed.some((entry) => {
    const rule = parseOriginRule(entry);
    return rule ? ruleMatches(rule, o) : false;
  });
}

/** True when the origin IS the CRM's own — preview traffic. */
export function isCrmOrigin(origin: string | null | undefined, crmOrigin: string | null | undefined): boolean {
  const o = normaliseOrigin(origin);
  const crm = normaliseOrigin(crmOrigin);
  return Boolean(o && crm && o === crm);
}

/** The requesting origin: the `Origin` header, else the `Referer`'s origin. */
export function requestOrigin(
  originHeader: string | null | undefined,
  refererHeader: string | null | undefined,
): string | null {
  const fromOrigin = normaliseOrigin(originHeader);
  if (fromOrigin) return fromOrigin;
  return normaliseOrigin(refererHeader);
}

/** Read a textarea of entries into canonical rules, reporting the rejects. */
export function parseOriginList(text: string): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\n,;\s]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const rule = parseOriginRule(entry);
    if (!rule) {
      invalid.push(entry);
      continue;
    }
    const canonical = formatOriginRule(rule);
    if (!origins.includes(canonical)) origins.push(canonical);
  }
  return { origins, invalid };
}
