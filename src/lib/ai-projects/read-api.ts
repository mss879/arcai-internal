import "server-only";

import { NextResponse } from "next/server";

import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

import { PROJECT_WITH_CLIENT, type AiProjectWithClient } from "./projects";
import { hashKey } from "./signature";

/**
 * The gate on the read API (0127) — how a client's own site reads its leads
 * back out of the CRM.
 *
 * This is the half of the link that runs the other way. The client's Next.js
 * server holds a bearer key in its environment and renders its own dashboard
 * from these routes, so the leads live on their site, in their branding,
 * behind their own login — and never on a CRM page nobody signs into.
 *
 * Two deliberate properties:
 *
 *   • **No CORS, no OPTIONS handler.** This key is for a server. A browser
 *     cannot use it even if it ends up in a page's source, because we never
 *     answer the preflight. That is the security model, not an omission.
 *   • **An allow-list on the way out.** Cost, tokens, prompts, models,
 *     billing and the origin list are the agency's business and never
 *     appear in a response, whatever the query says.
 */

export type ReadGate =
  | { ok: true; project: AiProjectWithClient; db: ReturnType<typeof createAdminClient> }
  | { ok: false; response: NextResponse };

function deny(status: number, error: string): NextResponse {
  // Cache-Control matters: an intermediary caching a 200 of someone's leads
  // would be a data leak with a very long tail.
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function gateRead(request: Request): Promise<ReadGate> {
  const header = request.headers.get("authorization") ?? "";
  const key = header.replace(/^Bearer\s+/i, "").trim();
  if (!key || !key.startsWith("arck_")) {
    return { ok: false, response: deny(401, "Send your ARC read key as: Authorization: Bearer arck_…") };
  }

  const db = createAdminClient();
  const limit = await enforceRateLimit(db, `ai-read:${key.slice(0, 24)}`, { limit: 120, windowSec: 60 });
  if (!limit.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Too many requests." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter), "Cache-Control": "no-store" } },
      ),
    };
  }

  const { data } = await db
    .from("ai_projects")
    .select(PROJECT_WITH_CLIENT)
    .eq("read_key_hash", hashKey(key))
    .maybeSingle();
  const project = (data as unknown as AiProjectWithClient | null) ?? null;
  if (!project || project.status === "archived") {
    // A wrong key costs the caller their allowance: twenty misses in five
    // minutes and that address is turned away regardless of what it sends.
    // Guessing a 24-byte key was never going to work, but a bounded door is
    // better than an unbounded one.
    const guessing = await enforceRateLimit(db, `ai-read-bad:${clientIp(request.headers)}`, {
      limit: 20,
      windowSec: 300,
    });
    if (!guessing.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Too many failed attempts." },
          { status: 429, headers: { "Retry-After": String(guessing.retryAfter), "Cache-Control": "no-store" } },
        ),
      };
    }
    // Otherwise the same answer as an archived project: a caller learns
    // nothing about which projects exist.
    return { ok: false, response: deny(401, "That key is not valid.") };
  }
  return { ok: true, project, db };
}

/** Every response from these routes. Never cached, never shared. */
export function readJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** A bounded, sane `?limit=`. */
export function readLimit(url: URL, fallback = 50, max = 200): number {
  const raw = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(raw)));
}

/** An ISO instant from `?since=`, or null. */
export function readSince(url: URL): string | null {
  const raw = url.searchParams.get("since");
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The lead shape the client's site sees. An allow-list, on purpose. */
export function serialiseLead(row: {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  interest: string | null;
  page_url: string | null;
  status: string;
  conversation_id: string | null;
  created_at: string;
}) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    interest: row.interest,
    page_url: row.page_url,
    status: row.status,
    conversation_id: row.conversation_id,
    captured_at: row.created_at,
  };
}

/** The conversation shape. No cost, no tokens — those are the agency's. */
export function serialiseConversation(row: {
  id: string;
  started_at: string;
  last_message_at: string;
  user_messages: number;
  message_count: number;
  page_url: string | null;
  page_title: string | null;
  country: string | null;
  lead_id: string | null;
  handoff_requested_at: string | null;
  handoff_summary: string | null;
}) {
  return {
    id: row.id,
    started_at: row.started_at,
    last_message_at: row.last_message_at,
    messages: row.message_count,
    visitor_messages: row.user_messages,
    page_url: row.page_url,
    page_title: row.page_title,
    country: row.country,
    lead_id: row.lead_id,
    asked_for_a_person: Boolean(row.handoff_requested_at),
    summary: row.handoff_summary,
  };
}
