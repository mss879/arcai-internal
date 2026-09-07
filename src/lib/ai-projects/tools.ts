import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { sendAndLogEmail } from "@/lib/email-outbox";
import { captureError } from "@/lib/errors";
import { logSystemWrite } from "@/lib/system-audit";

import { validateLead } from "./chat-core";
import type { ToolDef } from "./tool-core";
import type { AiProjectWithClient } from "./projects";
import type { AiActionKind } from "./stream-core";

type DB = SupabaseClient<Database>;

/**
 * The agent's three abilities (0126), executed.
 *
 * Each returns what the model reads back (`content`) and, when the widget
 * should draw something, an `action`. Preview conversations never email the
 * client: the owner testing the agent from the Deploy tab would otherwise
 * fill the client's inbox with their own rehearsals.
 */

export type ToolContext = {
  db: DB;
  project: AiProjectWithClient;
  conversationId: string;
  pageUrl: string | null;
  preview: boolean;
  /** 0127 — the tools the agency defined against the client's backend. */
  customTools?: ToolDef[];
  /** 0127 — wall-clock left in the visitor's turn, so a slow client endpoint
   *  is declined rather than allowed to kill the stream. */
  remainingMs?: number;
};

export type ToolOutcome = {
  content: unknown;
  action?: { kind: AiActionKind; url?: string };
};

function business(project: AiProjectWithClient): string {
  return project.client?.company || project.client?.name || project.name;
}

/** Email the project's notification address. Never throws. */
export async function notifyProject(
  db: DB,
  project: AiProjectWithClient,
  subject: string,
  body: string,
  opts: { preview?: boolean } = {},
): Promise<{ sent: boolean; error?: string }> {
  const to = project.notification_email?.trim();
  if (!to) return { sent: false, error: "No notification email on the project." };
  if (opts.preview) return { sent: false, error: "Preview conversation — not emailed." };
  try {
    const res = await sendAndLogEmail(db, {
      to,
      kind: "system",
      actor: "system",
      clientId: project.client_id,
      message: { transport: "generic", subject, body },
    });
    return { sent: res.sent, error: res.error };
  } catch (e) {
    await captureError(e, { source: "route", path: "ai/tools/notify", meta: { project: project.id } });
    return { sent: false, error: e instanceof Error ? e.message : "Email failed." };
  }
}

async function notify(ctx: ToolContext, subject: string, body: string): Promise<{ sent: boolean; error?: string }> {
  return notifyProject(ctx.db, ctx.project, subject, body, { preview: ctx.preview });
}

export type LeadForEmail = {
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  interest: string | null;
  page_url: string | null;
};

/** The lead notification, as subject + plain-text body. One place, so the
 * agent's own capture and the Leads tab's "Resend" say the same thing. */
export function leadEmail(project: AiProjectWithClient, lead: LeadForEmail): { subject: string; body: string } {
  const name = lead.name ?? "A visitor";
  const lines = [
    `${name} left their details with the assistant on your website.`,
    "",
    ...(lead.email ? [`Email: ${lead.email}`] : []),
    ...(lead.phone ? [`Phone: ${lead.phone}`] : []),
    ...(lead.company ? [`Company: ${lead.company}`] : []),
    ...(lead.interest ? ["", `What they want: ${lead.interest}`] : []),
    ...(lead.page_url ? ["", `Page: ${lead.page_url}`] : []),
    "",
    `Sent by the ${business(project)} website assistant.`,
  ];
  return { subject: `New lead from your website assistant — ${name}`, body: lines.join("\n") };
}

export async function executeAiTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolOutcome> {
  switch (name) {
    case "capture_lead":
      return captureLead(ctx, args);
    case "offer_booking":
      return offerBooking(ctx);
    case "request_human":
      return requestHuman(ctx, args);
    default: {
      // 0127 — anything else is a tool the agency defined against the
      // client's own backend. A name that is not on that list never reaches
      // the network: the model can only call what it was handed, and this is
      // the check that keeps that true.
      const custom = (ctx.customTools ?? []).find((t) => t.name === name);
      if (!custom) return { content: { ok: false, error: `Unknown tool ${name}.` } };

      // A calendar tool on the `cal_com` provider is answered by Cal.com; on
      // `endpoint` it is an ordinary call to the client's own site, so it
      // falls through to the runner below unchanged.
      const { isCalendarTool } = await import("./calendar");
      if (isCalendarTool(custom) && ctx.project.calendar_provider === "cal_com") {
        const { runCalendarTool } = await import("./calendar");
        const res = await runCalendarTool(ctx.db, {
          project: ctx.project,
          tool: custom,
          args: (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
          conversationId: ctx.conversationId,
          preview: ctx.preview,
        });
        return { content: res.content };
      }

      const { runCustomTool } = await import("./custom-tools");
      const res = await runCustomTool(ctx.db, {
        project: ctx.project,
        tool: custom,
        args,
        conversationId: ctx.conversationId,
        preview: ctx.preview,
        remainingMs: ctx.remainingMs,
      });
      return { content: res.content };
    }
  }
}

async function captureLead(ctx: ToolContext, args: unknown): Promise<ToolOutcome> {
  if (!ctx.project.lead_capture_enabled) return { content: { ok: false, error: "Lead capture is off." } };
  const checked = validateLead(args);
  if (!checked.ok) return { content: { ok: false, error: checked.error } };
  const lead = checked.lead;

  const { data: existing } = await ctx.db.from("ai_leads").select("id").eq("conversation_id", ctx.conversationId).maybeSingle();
  const row = {
    project_id: ctx.project.id,
    conversation_id: ctx.conversationId,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    interest: lead.interest,
    page_url: ctx.pageUrl,
  };
  let leadId: string;
  if (existing) {
    const { error } = await ctx.db.from("ai_leads").update(row).eq("id", existing.id);
    if (error) return { content: { ok: false, error: error.message } };
    leadId = existing.id;
  } else {
    const { data, error } = await ctx.db.from("ai_leads").insert(row).select("id").single();
    if (error || !data) return { content: { ok: false, error: error?.message ?? "Could not save the lead." } };
    leadId = data.id;
  }
  await ctx.db.from("ai_conversations").update({ lead_id: leadId }).eq("id", ctx.conversationId);

  const email = leadEmail(ctx.project, { ...lead, page_url: ctx.pageUrl });
  const mail = await notify(ctx, email.subject, email.body);
  await ctx.db
    .from("ai_leads")
    .update(mail.sent ? { notified_at: new Date().toISOString(), notify_error: null } : { notify_error: mail.error ?? "not sent" })
    .eq("id", leadId);

  // 0127 — and onto the client's own system, which is the point of the whole
  // thing: the agency does not work these leads, the client does.
  const { enqueueDelivery } = await import("./delivery");
  await enqueueDelivery(ctx.db, {
    project: ctx.project,
    leadId,
    conversationId: ctx.conversationId,
    kind: "lead",
    preview: ctx.preview,
  });

  await logSystemWrite(ctx.db, {
    job: "aiChat",
    actor: "system:aiChat",
    table: "ai_leads",
    rowId: leadId,
    action: existing ? "updated" : "created",
    summary: `Lead ${existing ? "updated" : "captured"} by ${ctx.project.agent_name} for ${business(ctx.project)}: ${lead.name}`,
    meta: { project_id: ctx.project.id, emailed: mail.sent, preview: ctx.preview },
  });

  return { content: { ok: true }, action: { kind: "lead_saved" } };
}

async function offerBooking(ctx: ToolContext): Promise<ToolOutcome> {
  const url = ctx.project.booking_url?.trim();
  if (!ctx.project.booking_enabled || !url) return { content: { ok: false, error: "Booking is not available." } };
  await ctx.db.from("ai_conversations").update({ booking_offered_at: new Date().toISOString() }).eq("id", ctx.conversationId);
  return { content: { ok: true, url }, action: { kind: "booking", url } };
}

async function requestHuman(ctx: ToolContext, args: unknown): Promise<ToolOutcome> {
  if (!ctx.project.handoff_enabled) return { content: { ok: false, error: "Hand-off is off." } };
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const summary = typeof a.summary === "string" ? a.summary.trim().slice(0, 500) : "";
  const email = typeof a.email === "string" ? a.email.trim().slice(0, 200) : "";
  const nowIso = new Date().toISOString();

  await ctx.db
    .from("ai_conversations")
    .update({ handoff_requested_at: nowIso, handoff_summary: summary || null })
    .eq("id", ctx.conversationId);

  const { data: messages } = await ctx.db
    .from("ai_messages")
    .select("role, content, created_at")
    .eq("conversation_id", ctx.conversationId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(30);
  const transcript = (messages ?? [])
    .reverse()
    .map((m) => `${m.role === "user" ? "Visitor" : ctx.project.agent_name}: ${m.content}`)
    .join("\n\n");

  const lines = [
    `A visitor on your website asked to speak to a person.`,
    "",
    ...(summary ? [`What they need: ${summary}`, ""] : []),
    ...(email ? [`Their email: ${email}`, ""] : []),
    ...(ctx.pageUrl ? [`Page: ${ctx.pageUrl}`, ""] : []),
    "Conversation so far:",
    "",
    transcript || "(no messages)",
    "",
    `Sent by the ${business(ctx.project)} website assistant.`,
  ];
  const mail = await notify(ctx, `A website visitor wants to talk to a person${summary ? ` — ${summary.slice(0, 60)}` : ""}`, lines.join("\n"));
  if (mail.sent) {
    await ctx.db.from("ai_conversations").update({ handoff_notified_at: nowIso }).eq("id", ctx.conversationId);
  }
  const { enqueueDelivery: queueHandoff } = await import("./delivery");
  await queueHandoff(ctx.db, {
    project: ctx.project,
    leadId: null,
    conversationId: ctx.conversationId,
    kind: "handoff",
    preview: ctx.preview,
  });

  await logSystemWrite(ctx.db, {
    job: "aiChat",
    actor: "system:aiChat",
    table: "ai_conversations",
    rowId: ctx.conversationId,
    action: "updated",
    summary: `Hand-off requested on ${business(ctx.project)}'s assistant${summary ? `: ${summary.slice(0, 120)}` : ""}`,
    meta: { project_id: ctx.project.id, emailed: mail.sent, preview: ctx.preview },
  });

  return {
    content: {
      ok: true,
      note: mail.sent
        ? "The team has been notified by email and will follow up."
        : "The request was recorded; the team will see it in their dashboard.",
    },
    action: { kind: "handoff_done" },
  };
}
