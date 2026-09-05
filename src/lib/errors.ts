import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { ErrorSource } from "@/lib/database.types";
import { notifyUsers } from "@/lib/notify";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Error tracking (T5.5, 0121).
 *
 * Until now a failure in the tick went to console.error on a serverless
 * function nobody tails, and a failure in a page went to the user's screen
 * and nowhere else. captureError() gives every failure one place: a row per
 * distinct fault, counted up — the fingerprint is the source, the message
 * with ids and numbers stripped, and the first stack frame, so the same
 * bug seen a thousand times is one line with a count, not a thousand.
 *
 * An admin is told the first time a fingerprint is seen, and again no more
 * than every six hours while it keeps happening. When SENTRY_DSN is set the
 * event is also posted to Sentry as a raw envelope (no SDK: one fetch, no
 * bundle weight, nothing to configure past the DSN).
 *
 * Never throws and never awaits the network for long: an error in the error
 * tracker must not be the thing that takes the tick down.
 */

const RENOTIFY_AFTER_MS = 6 * 60 * 60 * 1000;

export type CaptureContext = {
  source: ErrorSource;
  /** The pass, route or page. */
  path?: string | null;
  meta?: Record<string, unknown>;
};

/** A message with the parts that vary stripped, so two runs of one bug match. */
function normalise(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b\d+(\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function firstFrame(stack: string | undefined): string {
  if (!stack) return "";
  const line = stack.split("\n").find((l) => /^\s*at\s/.test(l)) ?? "";
  return line.replace(/:\d+:\d+\)?$/, "").trim().slice(0, 200);
}

export function fingerprintOf(source: string, message: string, stack?: string): string {
  return createHash("sha1").update(`${source}|${normalise(message)}|${firstFrame(stack)}`).digest("hex");
}

function describe(err: unknown): { message: string; stack?: string; name: string } {
  if (err instanceof Error) return { message: err.message || err.name, stack: err.stack, name: err.name };
  if (typeof err === "string") return { message: err, name: "Error" };
  try {
    return { message: JSON.stringify(err).slice(0, 500), name: "Error" };
  } catch {
    return { message: String(err), name: "Error" };
  }
}

export async function captureError(err: unknown, ctx: CaptureContext): Promise<void> {
  const { message, stack, name } = describe(err);
  const fingerprint = fingerprintOf(ctx.source, message, stack);
  const now = new Date().toISOString();
  console.error(`[${ctx.source}${ctx.path ? `:${ctx.path}` : ""}] ${message}`);

  try {
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("error_events")
      .select("id, count, last_notified_at, resolved_at")
      .eq("fingerprint", fingerprint)
      .maybeSingle();

    let notify = false;
    if (existing) {
      const stale =
        !existing.last_notified_at || Date.now() - new Date(existing.last_notified_at).getTime() > RENOTIFY_AFTER_MS;
      // A resolved fault that comes back is news again.
      notify = stale || Boolean(existing.resolved_at);
      await admin
        .from("error_events")
        .update({
          count: existing.count + 1,
          last_seen_at: now,
          message: message.slice(0, 1000),
          stack: stack?.slice(0, 8000) ?? null,
          path: ctx.path ?? null,
          meta: ctx.meta ?? {},
          resolved_at: null,
          ...(notify ? { last_notified_at: now } : {}),
        })
        .eq("id", existing.id);
    } else {
      notify = true;
      await admin.from("error_events").insert({
        fingerprint,
        source: ctx.source,
        message: message.slice(0, 1000),
        stack: stack?.slice(0, 8000) ?? null,
        path: ctx.path ?? null,
        meta: ctx.meta ?? {},
        last_notified_at: now,
      });
    }

    if (notify) {
      const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin");
      const ids = (admins ?? []).map((a) => a.id);
      if (ids.length) {
        await notifyUsers(admin, {
          userIds: ids,
          type: "system",
          title: existing ? `Still failing: ${ctx.source}` : `New error in ${ctx.source}`,
          body: `${ctx.path ? `${ctx.path} — ` : ""}${message.slice(0, 160)}`,
          link: "/settings#errors",
          push: false,
        });
      }
    }
  } catch {
    // 0121 not applied, or the tracker itself is down. console.error above stands.
  }

  void sendToSentry({ name, message, stack, source: ctx.source, path: ctx.path ?? null, meta: ctx.meta ?? {} });
}

/**
 * A raw Sentry envelope. Only when SENTRY_DSN is set; a bad DSN or a slow
 * ingest is swallowed. Format per Sentry's envelope spec — headers line,
 * item header, event JSON.
 */
async function sendToSentry(ev: {
  name: string;
  message: string;
  stack?: string;
  source: string;
  path: string | null;
  meta: Record<string, unknown>;
}): Promise<void> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  try {
    const url = new URL(dsn);
    const key = url.username;
    const projectId = url.pathname.replace(/^\/+/, "");
    if (!key || !projectId) return;
    const endpoint = `${url.protocol}//${url.host}/api/${projectId}/envelope/`;
    const eventId = randomUUID().replace(/-/g, "");
    const sentAt = new Date().toISOString();
    const event = {
      event_id: eventId,
      timestamp: sentAt,
      platform: "node",
      level: "error",
      environment: process.env.NODE_ENV ?? "production",
      tags: { source: ev.source, ...(ev.path ? { path: ev.path } : {}) },
      extra: ev.meta,
      exception: {
        values: [
          {
            type: ev.name,
            value: ev.message,
            ...(ev.stack ? { stacktrace: { frames: framesOf(ev.stack) } } : {}),
          },
        ],
      },
    };
    const body =
      JSON.stringify({ event_id: eventId, sent_at: sentAt, dsn }) +
      "\n" +
      JSON.stringify({ type: "event", content_type: "application/json" }) +
      "\n" +
      JSON.stringify(event) +
      "\n";
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${key}, sentry_client=arc-crm/1.0`,
      },
      body,
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    // Sentry is a mirror, never the record.
  }
}

/** Sentry wants frames oldest-first; a V8 stack is newest-first. */
function framesOf(stack: string): { function: string; filename: string; lineno?: number; colno?: number }[] {
  return stack
    .split("\n")
    .filter((l) => /^\s*at\s/.test(l))
    .slice(0, 30)
    .map((l) => {
      const m = l.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
      return m
        ? { function: m[1] ?? "<anonymous>", filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) }
        : { function: l.trim().replace(/^at\s+/, ""), filename: "<unknown>" };
    })
    .reverse();
}

// ---- Reading and resolving (the Errors panel on /settings) ---------------

export type ErrorEventRow = {
  id: string;
  source: string;
  message: string;
  path: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  stack: string | null;
};

/** Open faults first, newest activity first. Empty on a database without 0121. */
export async function listErrorEvents(limit = 50): Promise<ErrorEventRow[]> {
  try {
    const { data, error } = await createAdminClient()
      .from("error_events")
      .select("id, source, message, path, count, first_seen_at, last_seen_at, resolved_at, stack")
      .order("resolved_at", { ascending: true, nullsFirst: true })
      .order("last_seen_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []).map((e) => ({
      id: e.id,
      source: e.source,
      message: e.message,
      path: e.path,
      count: e.count,
      firstSeenAt: e.first_seen_at,
      lastSeenAt: e.last_seen_at,
      resolvedAt: e.resolved_at,
      stack: e.stack,
    }));
  } catch {
    return [];
  }
}

/** How many distinct faults are open, and how many were seen in the last day. */
export async function errorSummary(): Promise<{ open: number; lastDay: number }> {
  try {
    const admin = createAdminClient();
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const [openRes, dayRes] = await Promise.all([
      admin.from("error_events").select("id", { count: "exact", head: true }).is("resolved_at", null),
      admin.from("error_events").select("id", { count: "exact", head: true }).gte("last_seen_at", since),
    ]);
    return { open: openRes.count ?? 0, lastDay: dayRes.count ?? 0 };
  } catch {
    return { open: 0, lastDay: 0 };
  }
}
