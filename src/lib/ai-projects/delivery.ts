import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AiDeliveryDestination, Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";
import { logSystemWrite } from "@/lib/system-audit";

import { backendLinkFor, postToBackend } from "./backend";
import { nextDeliveryState } from "./delivery-core";
import { PROJECT_WITH_CLIENT, type AiProjectWithClient } from "./projects";
import { insertLeadIntoSupabase, mapLeadRow, supabaseLinkFor } from "./supabase-destination";

type DB = SupabaseClient<Database>;

/**
 * Getting a captured lead onto the client's own system (0127).
 *
 * The agency owner will not be reading the CRM, so a lead that only lands
 * here has not really been captured. This posts it, signed, to an endpoint
 * on the client's own site — which is theirs to do anything with: write to
 * their database, forward to whatever CRM they use, ping their phone.
 *
 * The shape is a queue rather than a call because the client's server is not
 * the agency's to rely on. A lead is enqueued the moment it is captured,
 * tried once in the same request (so a healthy endpoint has it within a
 * second), and anything that fails is retried by the tick over about nine
 * hours before giving up loudly on the Leads tab.
 *
 * The email notification from 0126 is unchanged and still goes out. It costs
 * nothing and it is the fallback for a client whose endpoint is down.
 */

const DRAIN_BUDGET_MS = 5_000;
/** Deliveries per tick. Small: they are HTTP calls to other people's servers. */
const MAX_PER_TICK = 10;

/**
 * Queue a lead for every destination this project has switched on.
 *
 * One row per destination rather than one row that tries both: a client can
 * have a webhook AND a Supabase, and a webhook that is working must not sit
 * in a retry queue because their database is refusing an insert.
 */
export async function enqueueDelivery(
  db: DB,
  opts: {
    project: AiProjectWithClient;
    leadId: string | null;
    conversationId: string | null;
    kind?: "lead" | "handoff";
    preview?: boolean;
  },
): Promise<string[]> {
  const { project } = opts;
  if (opts.preview) return []; // a rehearsal must never reach the client's system

  const destinations: AiDeliveryDestination[] = [];
  if (project.lead_delivery_enabled && backendLinkFor(project)) destinations.push("webhook");
  // A hand-off is a conversation, not a row: only the webhook carries it.
  if (
    (opts.kind ?? "lead") === "lead" &&
    project.supabase_delivery_enabled &&
    supabaseLinkFor(project)
  ) {
    destinations.push("supabase");
  }
  if (!destinations.length) return [];

  try {
    const { data, error } = await db
      .from("ai_deliveries")
      .insert(
        destinations.map((destination) => ({
          project_id: project.id,
          lead_id: opts.leadId,
          conversation_id: opts.conversationId,
          kind: opts.kind ?? "lead",
          destination,
          status: "pending" as const,
          next_attempt_at: new Date().toISOString(),
        })),
      )
      .select("id");
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => r.id);
  } catch (e) {
    await captureError(e, { source: "route", path: "ai/delivery/enqueue", meta: { project: project.id } });
    return [];
  }
}

/** What the client's endpoint receives. Documented in the client kit. */
async function buildPayload(
  db: DB,
  delivery: { id: string; kind: string; lead_id: string | null; conversation_id: string | null },
  project: AiProjectWithClient,
): Promise<Record<string, unknown> | null> {
  const [{ data: lead }, { data: conversation }] = await Promise.all([
    delivery.lead_id
      ? db.from("ai_leads").select("*").eq("id", delivery.lead_id).maybeSingle()
      : Promise.resolve({ data: null }),
    delivery.conversation_id
      ? db
          .from("ai_conversations")
          .select("started_at, page_url, page_title, message_count, handoff_summary")
          .eq("id", delivery.conversation_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (delivery.kind === "lead" && !lead) return null; // the lead was erased; nothing to deliver

  return {
    event: delivery.kind === "handoff" ? "handoff.requested" : "lead.captured",
    project: project.public_key,
    delivery_id: delivery.id,
    lead_id: delivery.lead_id,
    conversation_id: delivery.conversation_id,
    lead: lead
      ? {
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          company: lead.company,
          interest: lead.interest,
          page_url: lead.page_url,
          status: lead.status,
          captured_at: lead.created_at,
        }
      : null,
    conversation: conversation
      ? {
          started_at: conversation.started_at,
          messages: conversation.message_count,
          page_url: conversation.page_url,
          page_title: conversation.page_title,
          summary: conversation.handoff_summary,
        }
      : null,
    sent_at: new Date().toISOString(),
  };
}

/** One attempt at one delivery. Never throws. */
export async function attemptDelivery(db: DB, deliveryId: string): Promise<boolean> {
  try {
    const { data: delivery } = await db.from("ai_deliveries").select("*").eq("id", deliveryId).maybeSingle();
    if (!delivery || delivery.status !== "pending") return false;

    const { data: projectRow } = await db
      .from("ai_projects")
      .select(PROJECT_WITH_CLIENT)
      .eq("id", delivery.project_id)
      .maybeSingle();
    const project = (projectRow as unknown as AiProjectWithClient | null) ?? null;
    if (!project) {
      await db
        .from("ai_deliveries")
        .update({ status: "failed", last_error: "The project was removed." })
        .eq("id", deliveryId);
      return false;
    }

    let ok: boolean;
    let error: string | null;
    let status: number | null = null;

    if (delivery.destination === "supabase") {
      const link = supabaseLinkFor(project);
      const { data: lead } = delivery.lead_id
        ? await db.from("ai_leads").select("*").eq("id", delivery.lead_id).maybeSingle()
        : { data: null };
      if (!link) {
        await db
          .from("ai_deliveries")
          .update({ status: "failed", last_error: "The project's Supabase link was removed." })
          .eq("id", deliveryId);
        return false;
      }
      if (!lead) {
        await db
          .from("ai_deliveries")
          .update({ status: "failed", last_error: "The lead no longer exists." })
          .eq("id", deliveryId);
        return false;
      }
      const res = await insertLeadIntoSupabase(link, mapLeadRow(lead, link.map, project.agent_name));
      ok = res.ok;
      error = res.error;
      status = res.status || null;
    } else {
      const link = backendLinkFor(project);
      if (!link) {
        await db
          .from("ai_deliveries")
          .update({ status: "failed", last_error: "The project's backend link was removed." })
          .eq("id", deliveryId);
        return false;
      }
      const payload = await buildPayload(db, delivery, project);
      if (!payload) {
        await db
          .from("ai_deliveries")
          .update({ status: "failed", last_error: "The lead no longer exists." })
          .eq("id", deliveryId);
        return false;
      }
      const call = await postToBackend(link, project.lead_webhook_path, payload, {
        idempotencyKey: delivery.id,
        timeoutMs: 10_000,
      });
      ok = call.ok;
      error = call.error;
      status = call.status || null;
    }

    const state = nextDeliveryState(delivery.attempts, { ok, error });

    await db
      .from("ai_deliveries")
      .update({
        status: state.status,
        attempts: state.attempts,
        last_status: status,
        last_error: state.status === "sent" ? null : (state as { error: string }).error,
        next_attempt_at: state.nextAttemptAt ?? delivery.next_attempt_at,
        delivered_at: state.status === "sent" ? state.deliveredAt : null,
      })
      .eq("id", deliveryId);

    if (state.status === "failed") {
      // Loud, once: a lead that never reached the client is worth an alert.
      await captureError(
        new Error(
          `Lead delivery to ${delivery.destination} gave up for ${project.name}: ${(state as { error: string }).error}`,
        ),
        { source: "tick", path: "ai/delivery", meta: { project: project.id, delivery: deliveryId } },
      );
      await logSystemWrite(db, {
        job: "aiDeliver",
        table: "ai_deliveries",
        rowId: deliveryId,
        action: "updated",
        summary: `Lead delivery (${delivery.destination}) to ${project.name} failed after ${state.attempts} tries`,
        meta: { project_id: project.id, error: (state as { error: string }).error },
      });
    }
    return state.status === "sent";
  } catch (e) {
    await captureError(e, { source: "tick", path: "ai/delivery/attempt", meta: { delivery: deliveryId } });
    return false;
  }
}

/**
 * The inline attempt, run after the visitor already has their reply.
 *
 * The turn's stream has closed by the time this runs, so the visitor waits
 * for nothing, but the request is still alive — which means a healthy client
 * endpoint has the lead about a second after the conversation ends rather
 * than up to five minutes later on the tick.
 */
export async function drainProjectDeliveries(
  db: DB,
  projectId: string,
  opts: { budgetMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? DRAIN_BUDGET_MS);
  let sent = 0;
  try {
    const { data: due } = await db
      .from("ai_deliveries")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(3);
    for (const row of due ?? []) {
      if (Date.now() > deadline) break;
      if (await attemptDelivery(db, row.id)) sent += 1;
    }
  } catch (e) {
    await captureError(e, { source: "route", path: "ai/delivery/drain", meta: { project: projectId } });
  }
  return sent;
}

export type DeliverPassResult = { tried: number; sent: number };

/**
 * The `aiDeliver` tick pass: everything the inline attempt could not get
 * through. Bounded per tick because each one is an HTTP call to somebody
 * else's server.
 */
export async function processAiDeliver(db: DB, now = new Date()): Promise<DeliverPassResult> {
  const result: DeliverPassResult = { tried: 0, sent: 0 };
  try {
    const { data: due } = await db
      .from("ai_deliveries")
      .select("id")
      .eq("status", "pending")
      .lte("next_attempt_at", now.toISOString())
      .order("next_attempt_at", { ascending: true })
      .limit(MAX_PER_TICK);
    for (const row of due ?? []) {
      result.tried += 1;
      if (await attemptDelivery(db, row.id)) result.sent += 1;
    }
  } catch (e) {
    await captureError(e, { source: "tick", path: "ai/deliver-pass" });
  }
  return result;
}

/** "Retry" on the Backend tab: put a failed row back in the queue. */
export async function requeueDelivery(db: DB, deliveryId: string): Promise<void> {
  await db
    .from("ai_deliveries")
    .update({ status: "pending", attempts: 0, next_attempt_at: new Date().toISOString(), last_error: null })
    .eq("id", deliveryId);
}
