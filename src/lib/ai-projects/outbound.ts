import "server-only";

import { lookup } from "node:dns/promises";

import { classifyFailure, isBlockedAddress, parseClientUrl } from "./outbound-core";

/**
 * The one way this codebase calls a client's server (0127).
 *
 * Everything about it is defensive, because the address is typed by a person
 * and the request is made by the agency's own server from inside its own
 * network:
 *
 *   • https only (localhost over http in development, so a client site can
 *     be wired up locally);
 *   • the host is RESOLVED first and every address it answers with is
 *     checked — a name is not a promise, and an attacker owns their DNS;
 *   • redirects are never followed, because following one walks straight
 *     around the check above;
 *   • the body is read through a byte counter and abandoned past the cap, so
 *     a client endpoint answering with a 40 MB page is their problem, not
 *     ours;
 *   • it never throws. Every failure is a result the caller can put on a
 *     screen.
 *
 * Known and accepted: DNS rebinding between the lookup and the connection is
 * not closed — Node's fetch gives no way to pin the resolved address. The
 * URLs here are admin-entered rather than visitor-entered, so the exposure is
 * an admin attacking their own server.
 */

export const DEFAULT_MAX_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 8_000;

export type OutboundResult = {
  ok: boolean;
  /** HTTP status, or 0 when the call never got that far. */
  status: number;
  body: string;
  /** Null on success; a sentence an admin can act on otherwise. */
  error: string | null;
  ms: number;
};

/** Development only, and only for localhost. */
function allowLocal(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Resolve the host and refuse if ANY address it answers with is private. */
async function hostIsSafe(host: string, literal: string | null): Promise<string | null> {
  if (literal) return isBlockedAddress(literal) ? "That address points inside a private network." : null;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (e) {
    return classifyFailure(e);
  }
  if (!addresses.length) return "That domain could not be found.";
  // One bad answer condemns the name: a host that resolves to both a public
  // and a private address is exactly how this check gets walked around.
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    return "That domain resolves to a private address.";
  }
  return null;
}

export async function callClientEndpoint(opts: {
  url: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<OutboundResult> {
  const started = Date.now();
  const fail = (error: string, status = 0): OutboundResult => ({
    ok: false,
    status,
    body: "",
    error,
    ms: Date.now() - started,
  });

  const checked = parseClientUrl(opts.url, { allowLocal: allowLocal() });
  if (!checked.ok) return fail(checked.error);

  if (!allowLocal() || !["localhost", "127.0.0.1"].includes(checked.host)) {
    const unsafe = await hostIsSafe(checked.host, checked.literalAddress);
    if (unsafe) return fail(unsafe);
  }

  const timeoutMs = Math.max(1_000, Math.min(20_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let res: Response;
  try {
    res = await fetch(checked.url, {
      method: opts.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "ARC-AI/1.0 (+https://www.arcai.agency)",
        ...(opts.headers ?? {}),
      },
      ...(opts.body !== undefined && opts.method !== "GET" ? { body: opts.body } : {}),
      // Never followed: a 302 to 169.254.169.254 would undo every check above.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return fail(classifyFailure(e));
  }

  if (res.status >= 300 && res.status < 400) {
    return fail(
      `The client's server redirected the request (HTTP ${res.status}). Point the setting at the final address.`,
      res.status,
    );
  }

  let body = "";
  try {
    body = await readCapped(res, maxBytes);
  } catch (e) {
    return fail(classifyFailure(e), res.status);
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body,
      error: `The client's server answered HTTP ${res.status}.`,
      ms: Date.now() - started,
    };
  }
  return { ok: true, status: res.status, body, error: null, ms: Date.now() - started };
}

/** Read a response, stopping at the cap rather than buffering whatever comes. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > maxBytes) {
      out += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (seen - maxBytes))), { stream: false });
      await reader.cancel().catch(() => {});
      return `${out}\n[truncated at ${maxBytes} bytes]`;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Parse a client endpoint's JSON answer without trusting it to be JSON. */
export function readJsonBody(body: string): Record<string, unknown> | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
