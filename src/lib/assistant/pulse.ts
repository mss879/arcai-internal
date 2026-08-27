import "server-only";

/**
 * The pulse — what Arcus notices about the business (0102).
 *
 * The rule that shapes this whole file: **derive, don't duplicate.** The app
 * already has watchers that do real work — the risk radar ranks projects
 * nightly, the anomaly guards run every tick, finance chases installments,
 * delivery flags stalled jobs — and every one of them already notifies. A
 * second system computing the same things would double the alerts and, worse,
 * eventually disagree with the first.
 *
 * So this reads what those subsystems have ALREADY WRITTEN (`projects
 * .risk_rank`, `project_anomalies`, blocked flags, invoice rows) and files
 * them into one feed the assistant can curate from. It never inserts a
 * `notifications` row itself; `processAssistantNudges` below decides what is
 * worth interrupting for, and the morning briefing sweeps up the rest.
 *
 * Dedupe is what makes the feed usable. Every event carries a `dedupe_key`
 * that includes the record AND the window it belongs to, so a condition that
 * stays true for a week is one row, not one per minute.
 *
 * Nothing here throws: it runs inside the shared tick.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { inQuietHours } from "@/lib/assistant/quiet-hours";
import { sendPushToUser } from "@/lib/push";
import { localDateInTimezone } from "@/lib/wa-coaching";

type DB = SupabaseClient<Database>;

/** The pulse is cheap but not free; a quarter-hour is plenty for "noticing". */
const PULSE_INTERVAL_MS = 15 * 60_000;

/** Written rather than nothing when a member has no config row yet. */
const DEFAULT_TZ = "Asia/Colombo";

/** How overdue an invoice must be before it is worth saying anything. */
const INVOICE_OVERDUE_DAYS = 7;

/** A blocked job is normal for a few days; a fortnight is a problem. */
const BLOCKED_ALERT_DAYS = 10;

/** At most this many events per pass, so one bad day can't flood the feed. */
const MAX_EVENTS_PER_PASS = 25;

/** Minimum gap between two interrupting nudges, whatever the budget allows. */
const NUDGE_SPACING_MS = 90 * 60_000;

type NewEvent = {
  source: string;
  kind: "info" | "warning" | "win" | "action";
  title: string;
  body?: string | null;
  href?: string | null;
  importance: number;
  dedupeKey: string;
  payload?: Record<string, unknown>;
};

/** ISO week, so a weekly condition dedupes to one event per week. */
function isoWeek(at = new Date()): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}W${String(week).padStart(2, "0")}`;
}

function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.floor((Date.now() - then) / 86_400_000);
}

/**
 * Look at the business and file what is worth saying.
 *
 * Self-gated to roughly every 15 minutes by probing the newest event it has
 * written — no extra state, the same trick the risk radar uses with its own
 * timestamp column.
 */
export async function processAssistantPulse(
  supabase: DB,
): Promise<{ scanned: boolean; filed: number }> {
  try {
    const { data: last } = await supabase
      .from("assistant_events")
      .select("created_at")
      .eq("source", "pulse-marker")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last && Date.now() - new Date(last.created_at).getTime() < PULSE_INTERVAL_MS) {
      return { scanned: false, filed: 0 };
    }

    const events: NewEvent[] = [];
    const week = isoWeek();

    // --- Money that is late ------------------------------------------------
    // The invoice ledger, read the way the Past tab reads it: an invoice with
    // an amount due that nobody has settled.
    const { data: invoices } = await supabase
      .from("invoices")
      .select("id, invoice_number, bill_to_name, invoice_date, grand_total, amount_paid, sent_at")
      .order("invoice_date", { ascending: false })
      .limit(200);
    for (const inv of invoices ?? []) {
      const outstanding = Number(inv.grand_total ?? 0) - Number(inv.amount_paid ?? 0);
      const age = daysSince(inv.invoice_date);
      if (outstanding <= 0 || age < INVOICE_OVERDUE_DAYS) continue;
      events.push({
        source: "finance",
        kind: "warning",
        title: `${inv.bill_to_name} — invoice ${inv.invoice_number} is ${age} days old`,
        body: `Rs. ${Math.round(outstanding).toLocaleString()} still outstanding.`,
        href: "/invoices?tab=past",
        // A month late is something to act on today; a week late can wait for
        // the briefing.
        importance: age >= 30 ? 3 : 2,
        dedupeKey: `invoice-overdue:${inv.id}:${week}`,
        payload: { invoice_number: inv.invoice_number, outstanding },
      });
    }

    // --- Projects the risk radar has already ranked ------------------------
    // The ranking is the radar's work; the sentence is the radar's too. This
    // only decides that a top-ranked project deserves a place in the feed.
    const { data: risky } = await supabase
      .from("projects")
      .select("id, name, risk_rank, risk_note, blocked_reason, blocked_since, status")
      .is("deleted_at", null)
      .not("risk_rank", "is", null)
      .order("risk_rank", { ascending: true })
      .limit(5);
    for (const project of risky ?? []) {
      if ((project.risk_rank ?? 99) > 3 || project.status !== "active") continue;
      events.push({
        source: "risk",
        kind: "warning",
        title: `${project.name} is the ${ordinal(project.risk_rank ?? 1)} riskiest project right now`,
        body: project.risk_note,
        href: `/projects/${project.id}`,
        importance: 2,
        dedupeKey: `project-risk:${project.id}:${week}`,
      });
    }

    // --- Jobs waiting on someone else for too long -------------------------
    const { data: blocked } = await supabase
      .from("projects")
      .select("id, name, blocked_reason, blocked_since")
      .is("deleted_at", null)
      .not("blocked_since", "is", null)
      .limit(50);
    for (const project of blocked ?? []) {
      const days = daysSince(project.blocked_since);
      if (days < BLOCKED_ALERT_DAYS) continue;
      events.push({
        source: "delivery",
        kind: "action",
        title: `${project.name} has been blocked for ${days} days`,
        body: project.blocked_reason,
        href: `/projects/${project.id}`,
        importance: 3,
        dedupeKey: `project-blocked:${project.id}:${week}`,
      });
    }

    // --- Anomalies the rule-based guards raised ----------------------------
    const { data: anomalies } = await supabase
      .from("project_anomalies")
      .select("id, project_id, kind, detail, created_at")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(20);
    for (const anomaly of anomalies ?? []) {
      events.push({
        source: "anomaly",
        kind: "warning",
        title: `Something looks off: ${anomaly.kind.replace(/_/g, " ")}`,
        body: anomaly.detail,
        href: anomaly.project_id ? `/projects/${anomaly.project_id}` : "/projects/insights",
        importance: 2,
        dedupeKey: `anomaly:${anomaly.id}`,
      });
    }

    // --- Wins, because a feed of only bad news gets muted ------------------
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const { data: paid } = await supabase
      .from("payments")
      .select("id, amount, status, paid_at, project_id, projects(name)")
      .eq("status", "paid")
      .gte("paid_at", since)
      .limit(20);
    for (const payment of paid ?? []) {
      const project = payment.projects as { name?: string } | null;
      events.push({
        source: "finance",
        kind: "win",
        title: `Rs. ${Math.round(Number(payment.amount ?? 0)).toLocaleString()} came in${project?.name ? ` on ${project.name}` : ""}`,
        href: payment.project_id ? `/projects/${payment.project_id}` : "/payments",
        importance: 1,
        dedupeKey: `payment-in:${payment.id}`,
      });
    }

    const filed = await fileEvents(supabase, events.slice(0, MAX_EVENTS_PER_PASS));

    // The self-gate marker. Written last so a pass that failed halfway is
    // retried on the next tick rather than skipped for fifteen minutes.
    await supabase.from("assistant_events").insert({
      source: "pulse-marker",
      kind: "info",
      title: "pulse",
      importance: 1,
      status: "done",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    return { scanned: true, filed };
  } catch {
    return { scanned: false, filed: 0 };
  }
}

function ordinal(n: number): string {
  return n === 1 ? "" : n === 2 ? "second " : n === 3 ? "third " : `${n}th `;
}

/** Insert, letting the unique dedupe index quietly drop repeats. */
async function fileEvents(supabase: DB, events: NewEvent[]): Promise<number> {
  if (!events.length) return 0;
  const { data, error } = await supabase
    .from("assistant_events")
    .upsert(
      events.map((e) => ({
        source: e.source,
        kind: e.kind,
        title: e.title,
        body: e.body ?? null,
        href: e.href ?? null,
        importance: e.importance,
        dedupe_key: e.dedupeKey,
        payload: e.payload ?? {},
      })),
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) return 0;
  return data?.length ?? 0;
}

/**
 * Decide what is worth interrupting for.
 *
 * Only importance ≥ 3 is ever allowed to buzz. Everything else waits for the
 * morning briefing, which is the point of having a briefing at all. Three
 * separate brakes apply on top: the member's quiet hours, their daily budget,
 * and a minimum spacing so two urgent things half a minute apart do not
 * arrive as two separate interruptions.
 *
 * Per-user notification rows, deliberately NOT `notifyEveryone` — that helper
 * also sends SMS, and Arcus is an in-app copilot.
 */
export async function processAssistantNudges(
  supabase: DB,
): Promise<{ sent: number }> {
  try {
    const { data: urgent } = await supabase
      .from("assistant_events")
      .select("id, title, body, href, importance, surfaced_via")
      .eq("status", "new")
      .gte("importance", 3)
      .order("importance", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(5);
    const pending = (urgent ?? []).filter((e) => !e.surfaced_via.includes("nudge"));
    if (!pending.length) return { sent: 0 };

    const { data: configs } = await supabase
      .from("assistant_config")
      .select("user_id, timezone, quiet_start, quiet_end, nudges_per_day, nudges_sent_on, nudge_count")
      .limit(50);
    if (!configs?.length) return { sent: 0 };

    let sent = 0;
    for (const config of configs) {
      const tz = config.timezone || DEFAULT_TZ;
      if (inQuietHours(tz, config.quiet_start, config.quiet_end)) continue;

      const today = localDateInTimezone(tz);
      const usedToday = config.nudges_sent_on === today ? config.nudge_count : 0;
      if (usedToday >= (config.nudges_per_day ?? 3)) continue;

      // Spacing: the member's last assistant notification, whatever raised it.
      const { data: recent } = await supabase
        .from("notifications")
        .select("created_at")
        .eq("user_id", config.user_id)
        .eq("type", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (
        recent &&
        Date.now() - new Date(recent.created_at).getTime() < NUDGE_SPACING_MS
      ) {
        continue;
      }

      const event = pending[0];
      await supabase.from("notifications").insert({
        user_id: config.user_id,
        type: "assistant",
        title: event.title,
        body: event.body,
        link: event.href ?? "/dashboard",
      });
      await sendPushToUser({
        userId: config.user_id,
        title: event.title,
        body: event.body,
        link: event.href ?? "/dashboard",
      });
      await supabase
        .from("assistant_config")
        .update({ nudges_sent_on: today, nudge_count: usedToday + 1 })
        .eq("user_id", config.user_id);
      sent += 1;
    }

    if (sent) {
      const event = pending[0];
      await supabase
        .from("assistant_events")
        .update({
          status: "surfaced",
          surfaced_via: [...event.surfaced_via, "nudge"],
        })
        .eq("id", event.id);
    }

    return { sent };
  } catch {
    return { sent: 0 };
  }
}

// `inQuietHours` moved to `@/lib/assistant/quiet-hours` (0104) so the
// terminal's spoken alerts apply the SAME rule in the browser. Imported at
// the top; the bodies moved verbatim, so nudge behaviour is unchanged.
