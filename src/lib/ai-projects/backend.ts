import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { decryptToken, encryptToken, isSocialCryptoConfigured } from "@/lib/social/crypto";
import type { AiProject } from "@/lib/types";

import { joinPath } from "./outbound-core";
import { callClientEndpoint, readJsonBody, type OutboundResult } from "./outbound";
import { signedHeaders } from "./signature";

type DB = SupabaseClient<Database>;

/**
 * The client's backend, as this codebase sees it (0127).
 *
 * One origin and one secret per project. Every signed call — a captured
 * lead, a tool the agent reaches for, the connection test — goes through
 * `postToBackend`, so the signing, the guard and the failure vocabulary are
 * decided in exactly one place.
 */

export type BackendLink = {
  baseUrl: string;
  secret: string;
  projectKey: string;
};

/** Is this project wired to a client backend we can actually call? */
export function backendLinkFor(project: AiProject): BackendLink | null {
  const baseUrl = project.backend_base_url?.trim();
  if (!baseUrl) return null;
  const secret = decryptToken(project.backend_secret_enc);
  if (!secret) return null;
  return { baseUrl, secret, projectKey: project.public_key };
}

/** Why a project cannot call its backend, in words for the Backend tab. */
export function backendReadiness(project: AiProject): { ready: boolean; reason: string | null } {
  if (!isSocialCryptoConfigured()) {
    return { ready: false, reason: "SOCIAL_TOKEN_KEY is not set on the server, so a secret cannot be stored." };
  }
  if (!project.backend_base_url?.trim()) return { ready: false, reason: "No backend address set." };
  if (!project.backend_secret_enc) return { ready: false, reason: "No shared secret — generate one." };
  if (!decryptToken(project.backend_secret_enc)) {
    return { ready: false, reason: "The stored secret cannot be read — SOCIAL_TOKEN_KEY may have changed. Rotate it." };
  }
  return { ready: true, reason: null };
}

export type BackendCall = OutboundResult & {
  /** The client's JSON answer, when they sent one. */
  json: Record<string, unknown> | null;
  url: string;
};

/**
 * One signed request to the client's backend.
 *
 * The body is serialised once and both signed and sent, so the bytes on the
 * wire are exactly the bytes the signature covers.
 */
export async function postToBackend(
  link: BackendLink,
  path: string,
  payload: unknown,
  opts: { method?: "GET" | "POST"; timeoutMs?: number; idempotencyKey?: string } = {},
): Promise<BackendCall> {
  const url = joinPath(link.baseUrl, path);
  const body = opts.method === "GET" ? "" : JSON.stringify(payload ?? {});
  const res = await callClientEndpoint({
    url,
    method: opts.method ?? "POST",
    body,
    timeoutMs: opts.timeoutMs,
    headers: {
      ...signedHeaders(link.secret, body, link.projectKey),
      ...(opts.idempotencyKey ? { "x-arc-idempotency-key": opts.idempotencyKey } : {}),
    },
  });
  return { ...res, json: readJsonBody(res.body), url };
}

/**
 * The "Send test" on the Backend tab: a signed ping to the lead webhook with
 * `test: true`, so the client's endpoint can recognise and ignore it. The
 * outcome is stamped on the project so a broken link is visible without
 * anyone reading a log.
 */
export async function testBackendLink(
  db: DB,
  project: AiProject,
): Promise<{ ok: boolean; detail: string; call: BackendCall | null }> {
  const readiness = backendReadiness(project);
  if (!readiness.ready) return { ok: false, detail: readiness.reason ?? "Not configured.", call: null };
  const link = backendLinkFor(project)!;

  const call = await postToBackend(link, project.lead_webhook_path, {
    event: "connection.test",
    test: true,
    project: project.public_key,
    sent_at: new Date().toISOString(),
  });

  const detail = call.ok
    ? `The client's server answered HTTP ${call.status} in ${call.ms} ms.`
    : (call.error ?? "The call failed.");
  await db
    .from("ai_projects")
    .update({
      backend_verified_at: call.ok ? new Date().toISOString() : null,
      backend_last_error: call.ok ? null : detail.slice(0, 500),
    })
    .eq("id", project.id);
  return { ok: call.ok, detail, call };
}

/** Store a new shared secret. Returns the plaintext once, to be shown and pasted. */
export function encryptSecret(secret: string): string {
  return encryptToken(secret);
}

/** Reveal a stored secret for the admin who has to paste it into a .env. */
export function revealSecret(stored: string | null): string | null {
  return decryptToken(stored);
}
