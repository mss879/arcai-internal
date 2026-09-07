import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { decryptToken } from "@/lib/social/crypto";
import type { AiProject } from "@/lib/types";

import { callClientEndpoint, readJsonBody } from "./outbound";
import type { AiProjectWithClient } from "./projects";
import { TOOL_RESULT_MAX_CHARS, type ToolDef } from "./tool-core";

type DB = SupabaseClient<Database>;

/**
 * The calendar the agent checks before it offers a time (0127).
 *
 * Two providers, one contract. Whichever is chosen, the agent gets the same
 * two tools with the same names and the same arguments, so the prompt, the
 * widget and the transcript never have to know which is behind them:
 *
 *   endpoint — the client's own site answers. Their server talks to whatever
 *              calendar they actually use, which is the honest place for a
 *              Google refresh token to live: on the business's own server,
 *              not in the agency's CRM.
 *   cal_com  — the CRM talks to Cal.com directly with an API key. Turnkey
 *              for a client who already books through Cal.com.
 *
 * A calendar tool is never a row in `ai_tools`; it appears when a provider is
 * chosen and disappears when it is not.
 */

export const CALENDAR_TOOL_NAMES = ["check_availability", "book_appointment"] as const;

const CAL_COM_BASE = "https://api.cal.com/v2";
/** Cal.com requires this header and quietly serves an older shape without it. */
const CAL_SLOTS_VERSION = "2024-09-04";
const CAL_BOOKINGS_VERSION = "2024-08-13";

export function calendarEnabled(project: AiProject): boolean {
  if (project.calendar_provider === "cal_com") {
    return Boolean(decryptToken(project.calendar_api_key_enc) && project.calendar_event_type_id);
  }
  if (project.calendar_provider === "endpoint") return Boolean(project.backend_base_url);
  return false;
}

/**
 * The two tools, as the model sees them.
 *
 * `id` is prefixed `calendar:` so the executor can tell them from a tool the
 * agency defined, and `path` carries the endpoint provider's path so the
 * ordinary custom-tool runner can serve that case unchanged.
 */
export function calendarToolDefs(project: AiProject): ToolDef[] {
  if (!calendarEnabled(project)) return [];
  const tz = project.calendar_timezone || "Asia/Colombo";
  return [
    {
      id: "calendar:check_availability",
      name: "check_availability",
      label: "Checking the diary…",
      description: `Check which appointment times are free on a given date. Use this before offering or promising any time, and never guess availability. Times are in ${tz}.`,
      kind: "read",
      method: "POST",
      path: project.calendar_availability_path,
      timeout_ms: 10_000,
      parameters: [
        { name: "date", type: "string", description: "The date to check, as YYYY-MM-DD", required: true },
      ],
    },
    {
      id: "calendar:book_appointment",
      name: "book_appointment",
      label: "Booking the appointment…",
      description: `Book an appointment at a time you have already confirmed is free with check_availability. Only call this once the visitor has given their name and email and has clearly agreed to a specific time. Times are in ${tz}.`,
      kind: "write",
      method: "POST",
      path: project.calendar_book_path,
      timeout_ms: 12_000,
      parameters: [
        { name: "date", type: "string", description: "The date, as YYYY-MM-DD", required: true },
        { name: "time", type: "string", description: "The start time, as HH:MM in 24-hour form", required: true },
        { name: "name", type: "string", description: "The visitor's full name", required: true },
        { name: "email", type: "string", description: "The visitor's email address", required: true },
        { name: "notes", type: "string", description: "Anything they said about what they need", required: false },
      ],
    },
  ];
}

export function isCalendarTool(tool: ToolDef): boolean {
  return tool.id.startsWith("calendar:");
}

// ---- Cal.com ---------------------------------------------------------------

function calBase(project: AiProject): string {
  return (project.calendar_api_base?.trim() || CAL_COM_BASE).replace(/\/+$/, "");
}

/** Pull ISO start times out of whatever shape Cal.com answers with. */
export function readCalSlots(json: Record<string, unknown> | null): string[] {
  const data = (json?.data ?? json) as unknown;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object" && typeof (v as { start?: unknown }).start === "string") {
      out.push((v as { start: string }).start);
    }
  };
  if (Array.isArray(data)) data.forEach(push);
  else if (data && typeof data === "object") {
    // Usually keyed by date: { "2026-09-10": [{ start }, …] }
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value)) value.forEach(push);
      else push(value);
    }
  }
  return out.filter((s) => !Number.isNaN(Date.parse(s)));
}

/** ISO instants as times a person would say, in the project's zone. */
export function formatSlots(isoTimes: string[], timeZone: string, limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const iso of isoTimes) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) continue;
    let label: string;
    try {
      label = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
    } catch {
      label = at.toISOString().slice(11, 16);
    }
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= limit) break;
  }
  return out;
}

async function calFetch(
  project: AiProject,
  path: string,
  opts: { method: "GET" | "POST"; version: string; body?: unknown; timeoutMs: number },
) {
  const apiKey = decryptToken(project.calendar_api_key_enc);
  if (!apiKey) return { ok: false as const, error: "No Cal.com API key is stored for this project.", json: null, status: 0 };
  const call = await callClientEndpoint({
    url: `${calBase(project)}${path}`,
    method: opts.method,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    timeoutMs: opts.timeoutMs,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "cal-api-version": opts.version,
    },
  });
  const json = readJsonBody(call.body);
  if (!call.ok) {
    const detail =
      (typeof json?.error === "object" && json.error && typeof (json.error as { message?: string }).message === "string"
        ? (json.error as { message: string }).message
        : null) ||
      (typeof json?.message === "string" ? json.message : null) ||
      call.error ||
      "Cal.com did not accept that.";
    return { ok: false as const, error: detail.slice(0, 300), json, status: call.status };
  }
  return { ok: true as const, error: null, json, status: call.status };
}

async function calAvailability(
  project: AiProject,
  date: string,
): Promise<{ ok: boolean; content: Record<string, unknown> }> {
  const tz = project.calendar_timezone || "Asia/Colombo";
  const params = new URLSearchParams({
    eventTypeId: String(project.calendar_event_type_id ?? ""),
    start: date,
    end: date,
    timeZone: tz,
  });
  const res = await calFetch(project, `/slots?${params.toString()}`, {
    method: "GET",
    version: CAL_SLOTS_VERSION,
    timeoutMs: 10_000,
  });
  if (!res.ok) return { ok: false, content: { ok: false, error: res.error } };

  const slots = formatSlots(readCalSlots(res.json), tz);
  if (!slots.length) {
    return { ok: true, content: { ok: true, result: { date, free: false, times: [], note: "Nothing free that day." } } };
  }
  return { ok: true, content: { ok: true, result: { date, free: true, times: slots, timezone: tz } } };
}

async function calBook(
  project: AiProject,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; content: Record<string, unknown> }> {
  const tz = project.calendar_timezone || "Asia/Colombo";
  const date = String(args.date ?? "");
  const time = String(args.time ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) {
    return { ok: false, content: { ok: false, error: "Ask for the date as YYYY-MM-DD and the time as HH:MM." } };
  }
  // Cal.com wants the instant in UTC; the visitor spoke in the project's zone.
  const start = zonedToUtcIso(date, time, tz);
  if (!start) return { ok: false, content: { ok: false, error: "That date and time could not be read." } };

  const res = await calFetch(project, "/bookings", {
    method: "POST",
    version: CAL_BOOKINGS_VERSION,
    timeoutMs: 12_000,
    body: {
      start,
      eventTypeId: Number(project.calendar_event_type_id),
      attendee: {
        name: String(args.name ?? "").slice(0, 120),
        email: String(args.email ?? "").slice(0, 200),
        timeZone: tz,
        language: "en",
      },
      ...(args.notes ? { bookingFieldsResponses: { notes: String(args.notes).slice(0, 500) } } : {}),
      metadata: { source: "arc-ai-website-assistant" },
    },
  });
  if (!res.ok) return { ok: false, content: { ok: false, error: res.error } };

  const data = (res.json?.data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    content: {
      ok: true,
      result: {
        booked: true,
        date,
        time,
        timezone: tz,
        reference: typeof data.uid === "string" ? data.uid : null,
      },
      message: `Booked for ${date} at ${time} (${tz}). A confirmation email is on its way.`,
    },
  };
}

/**
 * A wall-clock time in a named zone, as a UTC instant.
 *
 * Done by measuring the zone's offset at that moment rather than assuming
 * one: Colombo does not observe daylight saving, but a client in London does,
 * and a booking an hour out is worse than no booking at all.
 */
export function zonedToUtcIso(date: string, time: string, timeZone: string): string | null {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const naive = Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  if (Number.isNaN(naive)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(naive));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asZone = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    // asZone − naive is the zone's offset at that instant; subtract it back.
    return new Date(naive - (asZone - naive)).toISOString();
  } catch {
    return null;
  }
}

/** Run one calendar tool. Only reached when a provider is configured. */
export async function runCalendarTool(
  db: DB,
  opts: {
    project: AiProjectWithClient;
    tool: ToolDef;
    args: Record<string, unknown>;
    conversationId: string;
    preview: boolean;
  },
): Promise<{ ok: boolean; content: Record<string, unknown> }> {
  const { project, tool } = opts;
  const started = Date.now();

  let result: { ok: boolean; content: Record<string, unknown> };
  if (tool.name === "check_availability") {
    result = await calAvailability(project, String(opts.args.date ?? ""));
  } else if (opts.preview) {
    // A rehearsal on the Deploy tab must not put a real appointment in a
    // real diary.
    result = {
      ok: true,
      content: { ok: true, result: "Preview mode — this would have been booked, but nothing was written to the calendar." },
    };
  } else {
    result = await calBook(project, opts.args);
  }

  try {
    await db.from("ai_tool_calls").insert({
      project_id: project.id,
      conversation_id: opts.conversationId,
      tool_id: null,
      tool_name: tool.name,
      arguments: opts.args,
      ok: result.ok,
      status: null,
      latency_ms: Date.now() - started,
      error: result.ok ? null : String((result.content as { error?: string }).error ?? "").slice(0, 500),
      response_excerpt: JSON.stringify(result.content).slice(0, 500),
    });
    await db
      .from("ai_projects")
      .update({
        calendar_verified_at: result.ok ? new Date().toISOString() : project.calendar_verified_at,
        calendar_last_error: result.ok ? null : String((result.content as { error?: string }).error ?? "").slice(0, 300),
      })
      .eq("id", project.id);
  } catch {
    // Logging must never cost the visitor their answer.
  }

  const content = result.content;
  const json = JSON.stringify(content);
  return json.length > TOOL_RESULT_MAX_CHARS
    ? { ok: result.ok, content: { ok: result.ok, result: json.slice(0, TOOL_RESULT_MAX_CHARS) } }
    : result;
}

/** "Send test" for the calendar: ask for tomorrow's slots. */
export async function testCalendar(db: DB, project: AiProjectWithClient): Promise<{ ok: boolean; detail: string }> {
  if (project.calendar_provider === "none") return { ok: false, detail: "No calendar is set for this project." };
  if (!calendarEnabled(project)) {
    return {
      ok: false,
      detail:
        project.calendar_provider === "cal_com"
          ? "Add the Cal.com API key and event type id first."
          : "Connect the client's backend first — the endpoint calendar runs on their site.",
    };
  }
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const defs = calendarToolDefs(project);
  const check = defs.find((t) => t.name === "check_availability")!;

  if (project.calendar_provider === "cal_com") {
    const res = await calAvailability(project, tomorrow);
    const detail = res.ok
      ? `Cal.com answered for ${tomorrow}: ${JSON.stringify((res.content as { result: unknown }).result)}`
      : String((res.content as { error?: string }).error ?? "Cal.com did not answer.");
    await db
      .from("ai_projects")
      .update({
        calendar_verified_at: res.ok ? new Date().toISOString() : null,
        calendar_last_error: res.ok ? null : detail.slice(0, 500),
      })
      .eq("id", project.id);
    return { ok: res.ok, detail };
  }

  const { runCustomTool } = await import("./custom-tools");
  const res = await runCustomTool(db, {
    project,
    tool: check,
    args: { date: tomorrow },
    conversationId: "00000000-0000-0000-0000-000000000000",
    preview: true,
  });
  const detail = res.ok
    ? `The client's site answered for ${tomorrow}: ${JSON.stringify(res.content)}`
    : String((res.content as { error?: string }).error ?? "The client's site did not answer.");
  await db
    .from("ai_projects")
    .update({
      calendar_verified_at: res.ok ? new Date().toISOString() : null,
      calendar_last_error: res.ok ? null : detail.slice(0, 500),
    })
    .eq("id", project.id);
  return { ok: res.ok, detail };
}
