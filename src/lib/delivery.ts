import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { appLink } from "@/lib/app-url";
import { fireAutomationTrigger, type TriggerEvent } from "@/lib/automation";
import type { Database, DeliveryEventKind, DeliveryStage } from "@/lib/database.types";
import {
  getWaAgentConfig,
  isQuietHours,
  notifyEveryone,
  sendAndLogWa,
} from "@/lib/wa-agent";
import { sendWhatsAppTemplate, sendWhatsAppCtaUrl } from "@/lib/whatsapp";

type DB = SupabaseClient<Database>;
type DeliverySettings = Database["public"]["Tables"]["delivery_settings"]["Row"];

/** How many projects one tick may chase — keeps the tick fast. */
const MAX_CHASES_PER_TICK = 5;
/** How many stalled projects one tick may alert on. */
const MAX_STALLED_PER_TICK = 10;

// ---------------------------------------------------------------------------
// Settings + shared helpers
// ---------------------------------------------------------------------------

export async function getDeliverySettings(supabase: DB): Promise<DeliverySettings> {
  const { data } = await supabase
    .from("delivery_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (data) return data;
  // Self-heal: the migration seeds this row, but never assume.
  const { data: created } = await supabase
    .from("delivery_settings")
    .upsert({ id: 1 }, { onConflict: "id" })
    .select("*")
    .single();
  if (!created) throw new Error("delivery_settings row is missing (run migration 0084).");
  return created;
}

export async function logDeliveryEvent(
  supabase: DB,
  projectId: string,
  kind: DeliveryEventKind,
  detail: string,
  actor: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await supabase.from("delivery_events").insert({
    project_id: projectId,
    kind,
    detail,
    actor,
    meta: meta ?? null,
  });
}

/** {{name}}/{{project_name}}/{{portal_link}}/{{missing_items}} for the
 * delivery messages (welcome, chaser, milestones). */
export function renderDeliveryMessage(
  text: string,
  vars: Record<string, string | null | undefined>,
): string {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, (value ?? "").trim());
  }
  // A token nobody filled must never reach the client.
  return out.replace(/\{\{[a-z_]+\}\}/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

/** Is the 24h customer-service window open for this contact? */
export function withinWaWindow(lastInboundAt: string | null): boolean {
  return (
    !!lastInboundAt &&
    Date.now() - new Date(lastInboundAt).getTime() < 24 * 3600_000
  );
}

/** The WhatsApp thread for a client — null when there's none or they opted
 * out. Delivery messages only ever ride an existing thread or a phone the
 * client gave us; contact creation happens in startWaOnboarding. */
export async function waContactForClient(
  supabase: DB,
  clientId: string | null,
): Promise<
  | Pick<
      Database["public"]["Tables"]["wa_contacts"]["Row"],
      "id" | "wa_id" | "last_inbound_at" | "do_not_contact" | "mode"
    >
  | null
> {
  if (!clientId) return null;
  const { data } = await supabase
    .from("wa_contacts")
    .select("id, wa_id, last_inbound_at, do_not_contact, mode")
    .eq("client_id", clientId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!data || data.do_not_contact) return null;
  return data;
}

/** Log an outbound WhatsApp we sent through a raw sender (template/CTA),
 * mirroring what sendAndLogWa does for plain text. */
export async function logOutboundWa(
  supabase: DB,
  contactId: string,
  body: string,
  waMessageId: string | null,
  ok: boolean,
  error?: string,
): Promise<void> {
  await supabase.from("wa_messages").insert({
    contact_id: contactId,
    wa_message_id: waMessageId,
    direction: "out",
    body,
    status: ok ? "sent" : "failed",
    error: ok ? null : (error ?? "send failed"),
    sent_by: "automation",
  });
  await supabase
    .from("wa_contacts")
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: body.slice(0, 160),
      last_direction: "out",
    })
    .eq("id", contactId);
}

// ---------------------------------------------------------------------------
// Stage mutator — the ONE way a project's delivery stage moves
// ---------------------------------------------------------------------------

/**
 * Move a project's delivery stage. Used by the hub board, the
 * set_delivery_stage automation step and the onboarding agent alike, so
 * triggers and milestone messages fire identically no matter who moved it.
 */
export async function setProjectDeliveryStage(
  supabase: DB,
  projectId: string,
  newStage: DeliveryStage,
  opts: { actor: string; suppressMilestone?: boolean },
): Promise<{ ok: boolean; detail: string }> {
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, delivery_stage, client_id, share_token")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, detail: "Project not found." };
  const oldStage = project.delivery_stage;
  if (oldStage === newStage)
    return { ok: true, detail: `Already in ${newStage}.` };

  const { error } = await supabase
    .from("projects")
    .update({
      delivery_stage: newStage,
      delivery_stage_changed_at: new Date().toISOString(),
    })
    .eq("id", projectId);
  if (error) return { ok: false, detail: error.message };

  await logDeliveryEvent(
    supabase,
    projectId,
    "stage_changed",
    `${oldStage ?? "not started"} → ${newStage}`,
    opts.actor,
    { old_stage: oldStage, new_stage: newStage },
  );

  // Fire the automation triggers with everything a recipe's steps need.
  const client = project.client_id
    ? (
        await supabase
          .from("clients")
          .select("id, name, phone, email")
          .eq("id", project.client_id)
          .maybeSingle()
      ).data
    : null;
  const portalLink = project.share_token
    ? appLink(`/public/project/${project.share_token}`)
    : null;
  const payload: Record<string, unknown> = {
    old_stage: oldStage,
    new_stage: newStage,
    name: client?.name ?? "",
    phone: client?.phone ?? null,
    email: client?.email ?? null,
    ...(portalLink ? { portal_link: portalLink } : {}),
  };
  const base = {
    client: client ?? null,
    project: { id: project.id, name: project.name },
    payload,
  } satisfies Partial<TriggerEvent>;

  await fireAutomationTrigger(supabase, {
    trigger: "project_stage_changed",
    ...base,
    triggerKey: `${projectId}:stage:${newStage}`,
  });
  if (newStage === "delivered") {
    await fireAutomationTrigger(supabase, {
      trigger: "project_delivered",
      ...base,
      triggerKey: `${projectId}:delivered`,
    });

    // MON-4 — raise the balance invoice, when the project asked for it.
    // Soft on purpose: a project that is fully paid, or has nothing to bill,
    // simply doesn't produce one, and a failure here must never stop a
    // delivery from being recorded.
    try {
      const { data: settings } = await supabase
        .from("projects")
        .select("auto_invoice_on_delivery")
        .eq("id", projectId)
        .maybeSingle();
      if (settings?.auto_invoice_on_delivery) {
        const { generateProjectInvoice } = await import("@/lib/project-automation");
        const invoice = await generateProjectInvoice(supabase, projectId);
        await logDeliveryEvent(
          supabase,
          projectId,
          "stage_changed",
          invoice.ok
            ? `Invoice ${invoice.invoiceNumber} raised automatically`
            : `No invoice raised — ${invoice.detail}`,
          "automation",
        );
      }
    } catch (e) {
      console.error("[delivery] auto-invoice failed:", e);
    }
  }

  if (!opts.suppressMilestone) {
    await sendMilestoneMessage(supabase, {
      projectId: project.id,
      projectName: project.name,
      clientId: project.client_id,
      clientName: client?.name ?? null,
      stage: newStage,
      portalLink,
    });
  }

  return { ok: true, detail: `${project.name}: ${oldStage ?? "not started"} → ${newStage}` };
}

/**
 * The built-in client milestone message for a stage move — only when the team
 * wrote one for that stage in Delivery Settings, at most once per project per
 * stage, riding the 24h-window ladder (free text → CTA button → team task).
 */
async function sendMilestoneMessage(
  supabase: DB,
  opts: {
    projectId: string;
    projectName: string;
    clientId: string | null;
    clientName: string | null;
    stage: DeliveryStage;
    portalLink: string | null;
  },
): Promise<void> {
  try {
    const settings = await getDeliverySettings(supabase);
    if (!settings.milestone_notify_enabled) return;
    const template = (settings.milestone_messages ?? {})[opts.stage];
    if (!template?.trim()) return;

    // Once per project per stage — the delivery_events row IS the stamp.
    const { data: already } = await supabase
      .from("delivery_events")
      .select("id")
      .eq("project_id", opts.projectId)
      .eq("kind", "milestone_sent")
      .contains("meta", { stage: opts.stage })
      .limit(1);
    if (already?.length) return;

    const contact = await waContactForClient(supabase, opts.clientId);
    if (!contact) return;

    const firstName = (opts.clientName ?? "").trim().split(/\s+/)[0] || "there";
    const body = renderDeliveryMessage(template, {
      name: firstName,
      project_name: opts.projectName,
      portal_link: opts.portalLink,
    });
    if (!body) return;

    if (withinWaWindow(contact.last_inbound_at)) {
      if (opts.portalLink) {
        const sent = await sendWhatsAppCtaUrl({
          to: contact.wa_id,
          bodyText: body,
          buttonText: "View progress",
          url: opts.portalLink,
        });
        await logOutboundWa(
          supabase,
          contact.id,
          body,
          sent.ok ? sent.waMessageId : null,
          sent.ok,
          sent.ok ? undefined : sent.error,
        );
        if (!sent.ok) return;
      } else {
        const sent = await sendAndLogWa(supabase, {
          contact,
          body,
          sentBy: "automation",
        });
        if (!sent.ok) return;
      }
      await logDeliveryEvent(
        supabase,
        opts.projectId,
        "milestone_sent",
        `Client notified: ${opts.stage}`,
        "automation",
        { stage: opts.stage },
      );
    } else {
      // Window closed — a milestone is not worth a template of its own;
      // hand it to a human instead of going silent.
      await supabase.from("crm_tasks").insert({
        lead_id: null,
        title: `Tell ${opts.clientName ?? "the client"}: ${opts.projectName} moved to ${opts.stage}`,
        notes: `The milestone message couldn't go out automatically (their 24h WhatsApp window is closed). Message: "${body}"`,
        due_at: new Date().toISOString(),
        created_by: null,
      });
    }
  } catch (e) {
    console.error("[delivery] milestone message failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Payment → trigger event
// ---------------------------------------------------------------------------

/**
 * Build the payment_received TriggerEvent for a payment tied to a project —
 * resolving the client (subject_phone is what send_whatsapp steps run on) and
 * whether this is the FIRST money on the project (the delivery-kickoff filter).
 */
export async function buildPaymentEvent(
  supabase: DB,
  opts: {
    projectId: string;
    amountText: string;
    source: "payments_board" | "project_detail" | "finance";
    triggerKey: string;
  },
): Promise<TriggerEvent | null> {
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client_id, share_token, service_type, onboarding_started_at")
    .eq("id", opts.projectId)
    .maybeSingle();
  if (!project) return null;

  const client = project.client_id
    ? (
        await supabase
          .from("clients")
          .select("id, name, phone, email")
          .eq("id", project.client_id)
          .maybeSingle()
      ).data
    : null;

  // First payment = across BOTH payment tables this project has exactly the
  // one paid row that was just recorded — and onboarding never ran.
  const [companyPaid, projectPaid] = await Promise.all([
    supabase
      .from("company_payments")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id)
      .eq("is_paid", true),
    supabase
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id)
      .eq("status", "paid"),
  ]);
  const paidCount = (companyPaid.count ?? 0) + (projectPaid.count ?? 0);
  const firstPayment = paidCount <= 1 && !project.onboarding_started_at;

  const portalLink = project.share_token
    ? appLink(`/public/project/${project.share_token}`)
    : null;

  return {
    trigger: "payment_received",
    client: client ?? null,
    project: { id: project.id, name: project.name },
    payload: {
      name: client?.name ?? "",
      phone: client?.phone ?? null,
      email: client?.email ?? null,
      amount: opts.amountText,
      service_type: project.service_type,
      source: opts.source,
      first_payment: firstPayment,
      ...(portalLink ? { portal_link: portalLink } : {}),
    },
    triggerKey: opts.triggerKey,
  };
}

// ---------------------------------------------------------------------------
// Tick processors — content chaser + stalled projects
// ---------------------------------------------------------------------------

export type DeliveryTickResult = { chased: number; stalled: number };

export async function processDeliveryAutomations(
  supabase: DB,
): Promise<DeliveryTickResult> {
  const out: DeliveryTickResult = { chased: 0, stalled: 0 };
  try {
    const settings = await getDeliverySettings(supabase);
    if (settings.chaser_enabled) {
      out.chased = await runContentChaser(supabase, settings);
    }
    if (settings.stalled_alerts_enabled) {
      out.stalled = await runStalledScan(supabase, settings);
    }
  } catch (e) {
    console.error("[delivery] tick failed:", e);
  }
  return out;
}

/**
 * Content chaser — the #1 reason agency projects stall is clients sitting on
 * their content. Projects in onboarding/assets with pending REQUIRED items
 * get a WhatsApp nudge listing exactly what's missing, every
 * chaser_interval_days, at most chaser_max_touches times per item.
 */
async function runContentChaser(
  supabase: DB,
  settings: DeliverySettings,
): Promise<number> {
  // The chaser is a self-initiated nudge — it respects quiet hours like
  // every other unprompted send (the agent still ANSWERS 24/7).
  const waConfig = await getWaAgentConfig(supabase);
  if (isQuietHours(waConfig)) return 0;

  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, client_id, share_token")
    .in("delivery_stage", ["onboarding", "assets"])
    .eq("chaser_paused", false)
    // 0090 — an archived project is not chased.
    .is("deleted_at", null)
    // 0092 — nor is one the team has already marked as waiting on something.
    // Chasing a client we know we're blocked on is how nudges get ignored.
    .is("blocked_reason", null)
    .limit(100);
  if (!projects?.length) return 0;

  const { data: items } = await supabase
    .from("project_document_requests")
    .select("id, project_id, title, status, required, chase_count, last_chased_at")
    .in("project_id", projects.map((p) => p.id))
    .eq("status", "pending")
    .eq("required", true);
  if (!items?.length) return 0;

  const byProject = new Map<string, typeof items>();
  for (const item of items) {
    const list = byProject.get(item.project_id) ?? [];
    list.push(item);
    byProject.set(item.project_id, list);
  }

  const intervalMs = Math.max(1, settings.chaser_interval_days) * 24 * 3600_000;
  let sent = 0;

  for (const project of projects) {
    if (sent >= MAX_CHASES_PER_TICK) break;
    const pending = byProject.get(project.id);
    if (!pending?.length) continue;

    // Due when the NEWEST chase on any pending item is older than the
    // interval, and at least one item is still under the touch cap.
    const newestChase = Math.max(
      ...pending.map((i) => (i.last_chased_at ? new Date(i.last_chased_at).getTime() : 0)),
    );
    const underCap = pending.some((i) => i.chase_count < settings.chaser_max_touches);
    if (!underCap || Date.now() - newestChase < intervalMs) continue;

    const contact = await waContactForClient(supabase, project.client_id);
    if (!contact) continue;

    // Claim BEFORE sending (CAS per item on the old chase_count) so a
    // crashed tick can never double-nudge; if every claim loses, another
    // tick beat us to this project.
    let claimed = 0;
    for (const item of pending) {
      const { data } = await supabase
        .from("project_document_requests")
        .update({
          chase_count: item.chase_count + 1,
          last_chased_at: new Date().toISOString(),
        })
        .eq("id", item.id)
        .eq("chase_count", item.chase_count)
        .select("id");
      if (data?.length) claimed++;
    }
    if (!claimed) continue;

    const { data: client } = project.client_id
      ? await supabase
          .from("clients")
          .select("name")
          .eq("id", project.client_id)
          .maybeSingle()
      : { data: null };
    const firstName = (client?.name ?? "").trim().split(/\s+/)[0] || "there";
    const portalLink = project.share_token
      ? appLink(`/public/project/${project.share_token}`)
      : null;
    const missing = pending.map((i) => i.title).join(", ");
    const body = renderDeliveryMessage(settings.chaser_message, {
      name: firstName,
      project_name: project.name,
      missing_items: missing,
      portal_link: portalLink,
    });

    if (withinWaWindow(contact.last_inbound_at)) {
      const res = await sendAndLogWa(supabase, {
        contact,
        body,
        sentBy: "automation",
      });
      if (!res.ok) continue;
      await logDeliveryEvent(
        supabase,
        project.id,
        "chase_sent",
        `Nudged for: ${missing}`,
        "automation",
        { touch: Math.max(...pending.map((i) => i.chase_count)) + 1 },
      );
    } else if (settings.chaser_template_name?.trim()) {
      const res = await sendWhatsAppTemplate({
        to: contact.wa_id,
        template: settings.chaser_template_name.trim(),
        language: settings.chaser_template_lang || "en",
        bodyParams: [firstName],
      });
      await logOutboundWa(
        supabase,
        contact.id,
        `[template: ${settings.chaser_template_name.trim()}]`,
        res.ok ? res.waMessageId : null,
        res.ok,
        res.ok ? undefined : res.error,
      );
      if (!res.ok) continue;
      await logDeliveryEvent(
        supabase,
        project.id,
        "chase_sent",
        `Template nudge for: ${missing}`,
        "automation",
      );
    } else {
      // Window closed, no template — a human has to do the chasing.
      await supabase.from("crm_tasks").insert({
        lead_id: null,
        title: `Chase ${client?.name ?? "the client"} for ${project.name} assets`,
        notes: `Still missing: ${missing}. Their 24h WhatsApp window is closed and no chaser template is set (Delivery → Settings), so the nudge needs a human. Portal: ${portalLink ?? "—"}`,
        due_at: new Date().toISOString(),
        created_by: null,
      });
      await logDeliveryEvent(
        supabase,
        project.id,
        "chase_sent",
        `Handed to the team (window closed, no template). Missing: ${missing}`,
        "automation",
      );
    }
    sent++;
  }
  return sent;
}

/** Admin alert for projects that stopped moving mid-delivery. */
async function runStalledScan(
  supabase: DB,
  settings: DeliverySettings,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - Math.max(1, settings.stalled_days) * 24 * 3600_000,
  ).toISOString();
  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, delivery_stage, updated_at, stalled_alerted_at, client_id")
    .not("delivery_stage", "is", null)
    .not("delivery_stage", "in", "(delivered,aftercare)")
    .lt("updated_at", cutoff)
    // 0090/0092 — archived projects are gone, and a blocked project is
    // waiting, not stalled. Alerting on either trains the team to ignore
    // the alert that matters.
    .is("deleted_at", null)
    .is("blocked_reason", null)
    .limit(100);
  if (!projects?.length) return 0;

  let alerted = 0;
  for (const project of projects) {
    if (alerted >= MAX_STALLED_PER_TICK) break;
    // Re-arm only on REAL activity: our own alert stamp lands in the same
    // transaction as the trigger's updated_at touch, so the two are within
    // a heartbeat of each other — a fresh edit later puts updated_at
    // clearly ahead of the stamp again.
    if (
      project.stalled_alerted_at &&
      new Date(project.updated_at).getTime() -
        new Date(project.stalled_alerted_at).getTime() <=
        60_000
    )
      continue;

    const days = Math.round(
      (Date.now() - new Date(project.updated_at).getTime()) / (24 * 3600_000),
    );
    await supabase
      .from("projects")
      .update({ stalled_alerted_at: new Date().toISOString() })
      .eq("id", project.id);
    await notifyEveryone(supabase, {
      title: `Project stalled: ${project.name}`,
      body: `No movement for ${days} days (stage: ${project.delivery_stage}). Nudge the client or the team.`,
      link: "/delivery",
    });
    await supabase.from("crm_tasks").insert({
      lead_id: null,
      title: `Unstick ${project.name} — idle ${days} days`,
      notes: `The project has been sitting in "${project.delivery_stage}" with no changes for ${days} days. Find the blocker.`,
      due_at: new Date().toISOString(),
      created_by: null,
    });
    await logDeliveryEvent(
      supabase,
      project.id,
      "stalled_alert",
      `Idle ${days} days in ${project.delivery_stage}`,
      "automation",
    );

    // 0096 — the alert stays as it is; this hands the same detection to the
    // automation engine so an escalation ladder can hang off it (AUTO-6).
    const { fireProjectStalled } = await import("@/lib/project-events");
    await fireProjectStalled(supabase, project.id, {
      days,
      stage: project.delivery_stage,
    });
    alerted++;
  }
  return alerted;
}
