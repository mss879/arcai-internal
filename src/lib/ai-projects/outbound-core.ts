/**
 * The rules for reaching a client's backend (0127) — pure, so they can be
 * pinned by tests.
 *
 * Every outbound call this module governs goes to a URL a person typed into
 * the CRM. That makes it server-side request forgery surface: a typed (or
 * pasted, or mistaken) URL pointing at `127.0.0.1`, at `10.0.0.5`, or at
 * `169.254.169.254` would have the agency's own server fetch its own
 * network — including the cloud metadata endpoint, which hands out
 * credentials to anyone who asks from inside.
 *
 * So the rule is a deny-list of address ranges rather than a hostname
 * check: a hostname can resolve anywhere, and an attacker controls their own
 * DNS. `outbound.ts` resolves the host first and applies `isBlockedAddress`
 * to EVERY address that comes back.
 */

/** What a URL must satisfy before we will call it. */
export type UrlCheck =
  | { ok: true; url: URL; host: string; literalAddress: string | null }
  | { ok: false; error: string };

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Dotted-quad → its four octets, or null when it is not one. Strict: a
 * leading zero is rejected rather than guessed at, because `0177.0.0.1` is
 * loopback to some resolvers and nonsense to others. */
export function parseIpv4(value: string): number[] | null {
  const m = value.match(IPV4_RE);
  if (!m) return null;
  const parts: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const raw = m[i]!;
    if (raw.length > 1 && raw.startsWith("0")) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    parts.push(n);
  }
  return parts;
}

/** Is this dotted-quad somewhere we must never send a request? */
function ipv4Blocked(parts: number[]): boolean {
  const [a = 0, b = 0] = parts;
  if (a === 0) return true;                          // 0.0.0.0/8 "this network"
  if (a === 10) return true;                         // private
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 168) return true;           // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                         // multicast, reserved, broadcast
  return false;
}

/** Expand an IPv6 literal to its eight groups, or null. */
export function parseIpv6(value: string): number[] | null {
  let s = value.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":")) return null;
  // An IPv4-mapped tail (::ffff:1.2.3.4) becomes two more groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  const v4 = parseIpv4(tail);
  if (v4) {
    s = `${s.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : null;
  if (!head || (halves.length === 2 && !rest)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - (rest?.length ?? 0);
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...(rest ?? [])];
}

function ipv6Blocked(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  const allZeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::  and ::1
  if (allZeroHead && g5 === 0) return true;
  // ::ffff:a.b.c.d — an IPv4 address wearing a hat. Judge it as IPv4.
  if (allZeroHead && g5 === 0xffff) {
    const [, , , , , , g6 = 0, g7 = 0] = groups;
    return ipv4Blocked([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Is this resolved address one we refuse to talk to?
 *
 * `outbound.ts` calls this for every address a hostname resolves to, so a
 * name that answers with one public and one private address is refused
 * outright rather than raced.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return ipv4Blocked(v4);
  const v6 = parseIpv6(address);
  if (v6) return ipv6Blocked(v6);
  // Unparseable is not trusted.
  return true;
}

/** True when the host is written as a literal address rather than a name. */
export function addressLiteral(host: string): string | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (parseIpv4(bare)) return bare;
  if (parseIpv6(bare)) return bare;
  return null;
}

/**
 * Validate a URL before anything resolves or connects.
 *
 * `allowLocal` is the development escape hatch: the agency runs a client's
 * site on `localhost:3000` while wiring it up, and refusing that would make
 * the feature impossible to build against. It is never true in production.
 */
export function parseClientUrl(
  input: string,
  opts: { allowLocal?: boolean } = {},
): UrlCheck {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "Enter the address of the client's site." };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "That is not a valid web address." };
  }

  const local =
    opts.allowLocal === true &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");

  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return { ok: false, error: "The address must start with https:// — a signed lead may not travel in the clear." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Remove the username and password from the address." };
  }
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, error: "That address has no host." };
  if (local) return { ok: true, url, host, literalAddress: null };

  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    return { ok: false, error: "That address points inside a private network." };
  }
  const literal = addressLiteral(host);
  if (literal) {
    if (isBlockedAddress(literal)) {
      return { ok: false, error: "That address points inside a private network." };
    }
    return { ok: true, url, host, literalAddress: literal };
  }
  // A name with no dot is a machine on the local network, not a website.
  if (!host.includes(".")) {
    return { ok: false, error: "Use the site's full domain, e.g. https://www.example.com." };
  }
  return { ok: true, url, host, literalAddress: null };
}

/** Join a validated origin with a tool or webhook path. */
export function joinPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const tail = path.startsWith("/") ? path : `/${path}`;
  return `${base}${tail}`;
}

/** A path the agency types for a tool or the lead webhook. */
export function checkPath(path: string): { ok: true; path: string } | { ok: false; error: string } {
  const p = (path ?? "").trim();
  if (!p) return { ok: false, error: "Enter the path this calls, e.g. /api/arc/tools/check-availability." };
  if (!p.startsWith("/")) return { ok: false, error: "The path must start with a slash." };
  if (p.includes("..")) return { ok: false, error: "The path may not contain '..'." };
  if (/\s/.test(p)) return { ok: false, error: "The path may not contain spaces." };
  if (p.length > 300) return { ok: false, error: "That path is too long." };
  return { ok: true, path: p };
}

/** Turn a thrown fetch error into something an admin can act on. */
export function classifyFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || /timed?\s*out|aborted/i.test(message)) {
    return "The client's server did not answer in time.";
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) return "That domain could not be found.";
  if (/ECONNREFUSED/i.test(message)) return "The client's server refused the connection.";
  if (/ECONNRESET|socket hang up/i.test(message)) return "The client's server closed the connection.";
  if (/certificate|SSL|TLS|self.signed/i.test(message)) return "The client's HTTPS certificate could not be verified.";
  return message.slice(0, 200) || "The call failed.";
}
