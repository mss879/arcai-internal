import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * Everything that happened with one client, in one list (0112).
 *
 * Nine tables each keep their own history — lead activity, delivery events,
 * texts, WhatsApp, quotes, invoices, payments, meetings, bookings — and no
 * screen read them together, so "what's the story with this client?" meant
 * five tabs and a guess. This reads the slices that belong to the client
 * (through their leads, projects and WhatsApp threads), normalises them into
 * one shape, and sorts newest first. Read-only; no new table.
 */

export type TimelineKind =
  | "lead"
  | "delivery"
  | "sms"
  | "whatsapp"
  | "quote"
  | "proposal"
  | "invoice"
  | "payment"
  | "meeting"
  | "booking"
  // 0115 — the half of the relationship that used to happen off-system.
  | "email"
  | "comment"
  | "change_request";

export type TimelineItem = {
  id: string;
  kind: TimelineKind;
  /** ISO timestamp. */
  at: string;
  title: string;
  body: string | null;
  href: string | null;
  /** Who did it, in words: "client", "team", "automation", or a channel. */
  actor: string | null;
};

const PER_SOURCE = 80;

function clip(text: string | null | undefined, max = 160): string | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export async function clientTimeline(
  supabase: DB,
  input: {
    clientId: string;
    leadIds: string[];
    projectIds: string[];
    waContactIds: string[];
    limit?: number;
  },
): Promise<TimelineItem[]> {
  const { clientId, leadIds, projectIds, waContactIds } = input;
  const items: TimelineItem[] = [];

  const [
    activitiesRes,
    eventsRes,
    smsByClientRes,
    smsByProjectRes,
    waRes,
    quotesRes,
    proposalsRes,
    invoicesByClientRes,
    invoicesByProjectRes,
    paymentsRes,
    linkedRes,
    meetingsRes,
    bookingsRes,
    emailsRes,
    commentsRes,
    changesRes,
  ] = await Promise.all([
    leadIds.length
      ? supabase
          .from("lead_activities")
          .select("id, lead_id, kind, title, body, actor_id, created_at")
          .in("lead_id", leadIds)
          .neq("kind", "field_changed")
          .order("created_at", { ascending: false })
          .limit(PER_SOURCE)
      : Promise.resolve({ data: [] }),
    projectIds.length
      ? supabase
          .from("delivery_events")
          .select("id, project_id, kind, detail, actor, created_at")
          .in("project_id", projectIds)
          .order("created_at", { ascending: false })
          .limit(PER_SOURCE)
      : Promise.resolve({ data: [] }),
    supabase
      .from("sms_messages")
      .select("id, to_number, message, kind, status, project_id, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(PER_SOURCE),
    projectIds.length
      ? supabase
          .from("sms_messages")
          .select("id, to_number, message, kind, status, project_id, created_at")
          .in("project_id", projectIds)
          .order("created_at", { ascending: false })
          .limit(PER_SOURCE)
      : Promise.resolve({ data: [] }),
    waContactIds.length
      ? supabase
          .from("wa_messages")
          .select("id, contact_id, direction, body, status, sent_by, created_at")
          .in("contact_id", waContactIds)
          .order("created_at", { ascending: false })
          .limit(PER_SOURCE)
      : Promise.resolve({ data: [] }),
    supabase
      .from("quotes")
      .select(
        "id, quote_number, title, grand_total, currency, status, created_at, sent_at, viewed_at, accepted_at, declined_at, declined_reason",
      )
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(40),
    supabase
      .from("proposals")
      .select("id, project_name, grand_total, proposal_date, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(40),
    supabase
      .from("invoices")
      .select("id, invoice_number, invoice_date, grand_total, due_today, stamp, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(40),
    projectIds.length
      ? supabase
          .from("invoices")
          .select("id, invoice_number, invoice_date, grand_total, due_today, stamp, created_at")
          .in("project_id", projectIds)
          .order("created_at", { ascending: false })
          .limit(40)
      : Promise.resolve({ data: [] }),
    projectIds.length
      ? supabase
          .from("payments")
          .select("id, project_id, amount, currency, status, paid_at, method, created_at")
          .in("project_id", projectIds)
          .order("created_at", { ascending: false })
          .limit(60)
      : Promise.resolve({ data: [] }),
    projectIds.length
      ? supabase
          .from("company_payments")
          .select("id, project_id, price_lkr, is_paid, created_at")
          .in("project_id", projectIds)
          .eq("is_paid", true)
          .order("created_at", { ascending: false })
          .limit(60)
      : Promise.resolve({ data: [] }),
    supabase
      .from("meetings")
      .select("id, title, meeting_at, duration_minutes, location_type")
      .eq("client_id", clientId)
      .order("meeting_at", { ascending: false })
      .limit(40),
    supabase
      .from("meeting_bookings")
      .select("id, booking_date, start_time, status, notes, created_at")
      .eq("client_id", clientId)
      .order("booking_date", { ascending: false })
      .limit(40),
    // 0115 — every email we sent them, by client or by one of their projects.
    supabase
      .from("email_messages")
      .select("id, subject, body_text, to_emails, kind, status, actor, sent_at, created_at")
      .or(
        projectIds.length
          ? `client_id.eq.${clientId},project_id.in.(${projectIds.join(",")})`
          : `client_id.eq.${clientId}`,
      )
      .order("created_at", { ascending: false })
      .limit(PER_SOURCE),
    projectIds.length
      ? supabase
          .from("project_comments")
          .select("id, project_id, author_type, author_name, body, created_at")
          .in("project_id", projectIds)
          .order("created_at", { ascending: false })
          .limit(PER_SOURCE)
      : Promise.resolve({ data: [] }),
    projectIds.length
      ? supabase
          .from("project_change_requests")
          .select("id, project_id, body, status, client_name, created_at")
          .in("project_id", projectIds)
          .order("created_at", { ascending: false })
          .limit(40)
      : Promise.resolve({ data: [] }),
  ]);

  for (const a of activitiesRes.data ?? []) {
    items.push({
      id: `lead:${a.id}`,
      kind: "lead",
      at: a.created_at,
      title: a.title,
      body: clip(a.body),
      href: `/crm/lead/${a.lead_id}`,
      actor: a.kind === "automation" ? "automation" : a.actor_id ? "team" : null,
    });
  }
  for (const e of eventsRes.data ?? []) {
    items.push({
      id: `delivery:${e.id}`,
      kind: "delivery",
      at: e.created_at,
      title: e.detail || e.kind.replace(/_/g, " "),
      body: null,
      href: `/projects/${e.project_id}`,
      actor: e.actor,
    });
  }
  const smsSeen = new Set<string>();
  for (const s of [...(smsByClientRes.data ?? []), ...(smsByProjectRes.data ?? [])]) {
    if (smsSeen.has(s.id)) continue;
    smsSeen.add(s.id);
    items.push({
      id: `sms:${s.id}`,
      kind: "sms",
      at: s.created_at,
      title: `SMS ${s.status === "failed" ? "failed" : "sent"} · ${s.kind.replace(/_/g, " ")}`,
      body: clip(s.message),
      href: s.project_id ? `/projects/${s.project_id}` : "/sms",
      actor: "team",
    });
  }
  for (const w of waRes.data ?? []) {
    items.push({
      id: `wa:${w.id}`,
      kind: "whatsapp",
      at: w.created_at,
      title: w.direction === "in" ? "WhatsApp from the client" : `WhatsApp ${w.sent_by === "agent" ? "from the agent" : "to the client"}`,
      body: clip(w.body),
      href: "/whatsapp",
      actor: w.direction === "in" ? "client" : (w.sent_by ?? "team"),
    });
  }
  for (const q of quotesRes.data ?? []) {
    const money = `${q.currency} ${Number(q.grand_total).toLocaleString()}`;
    const label = q.title || q.quote_number;
    items.push({
      id: `quote:${q.id}:created`,
      kind: "quote",
      at: q.created_at,
      title: `Quote ${q.quote_number} created — ${label}`,
      body: money,
      href: "/invoices?tab=quotes",
      actor: "team",
    });
    if (q.sent_at)
      items.push({ id: `quote:${q.id}:sent`, kind: "quote", at: q.sent_at, title: `Quote ${q.quote_number} sent`, body: money, href: "/invoices?tab=quotes", actor: "team" });
    if (q.viewed_at)
      items.push({ id: `quote:${q.id}:viewed`, kind: "quote", at: q.viewed_at, title: `Quote ${q.quote_number} opened by the client`, body: null, href: "/invoices?tab=quotes", actor: "client" });
    if (q.accepted_at)
      items.push({ id: `quote:${q.id}:accepted`, kind: "quote", at: q.accepted_at, title: `Quote ${q.quote_number} signed 🎉`, body: money, href: "/invoices?tab=quotes", actor: "client" });
    if (q.declined_at)
      items.push({ id: `quote:${q.id}:declined`, kind: "quote", at: q.declined_at, title: `Quote ${q.quote_number} declined`, body: clip(q.declined_reason), href: "/invoices?tab=quotes", actor: "client" });
  }
  for (const p of proposalsRes.data ?? []) {
    items.push({
      id: `proposal:${p.id}`,
      kind: "proposal",
      at: p.created_at,
      title: `Proposal — ${p.project_name || "untitled"}`,
      body: `LKR ${Number(p.grand_total).toLocaleString()}`,
      href: "/proposals",
      actor: "team",
    });
  }
  const invSeen = new Set<string>();
  for (const i of [...(invoicesByClientRes.data ?? []), ...(invoicesByProjectRes.data ?? [])]) {
    if (invSeen.has(i.id)) continue;
    invSeen.add(i.id);
    items.push({
      id: `invoice:${i.id}`,
      kind: "invoice",
      at: i.created_at,
      title: `Invoice ${i.invoice_number} raised${i.stamp === "payment_received" ? " · paid" : i.stamp === "deposit_paid" ? " · deposit paid" : ""}`,
      body: `Total ${Number(i.grand_total).toLocaleString()} · due now ${Number(i.due_today).toLocaleString()}`,
      href: "/invoices?tab=past",
      actor: "team",
    });
  }
  for (const p of paymentsRes.data ?? []) {
    if (p.status !== "paid") continue;
    items.push({
      id: `payment:${p.id}`,
      kind: "payment",
      at: p.paid_at ? `${p.paid_at}T12:00:00.000Z` : p.created_at,
      title: `Payment received — ${p.currency} ${Number(p.amount).toLocaleString()}`,
      body: p.method ? `via ${p.method}` : null,
      href: `/projects/${p.project_id}`,
      actor: "client",
    });
  }
  for (const p of linkedRes.data ?? []) {
    items.push({
      id: `linked:${p.id}`,
      kind: "payment",
      at: p.created_at,
      title: `Payment recorded — LKR ${Number(p.price_lkr).toLocaleString()}`,
      body: "Payments board",
      href: p.project_id ? `/projects/${p.project_id}` : "/payments",
      actor: "client",
    });
  }
  for (const m of meetingsRes.data ?? []) {
    items.push({
      id: `meeting:${m.id}`,
      kind: "meeting",
      at: m.meeting_at,
      title: `Meeting — ${m.title}`,
      body: `${m.duration_minutes} min · ${m.location_type}`,
      href: "/dashboard",
      actor: "team",
    });
  }
  for (const b of bookingsRes.data ?? []) {
    items.push({
      id: `booking:${b.id}`,
      kind: "booking",
      at: `${b.booking_date}T${b.start_time.length === 5 ? `${b.start_time}:00` : b.start_time}`,
      title: `Booked a call (${b.status})`,
      body: clip(b.notes),
      href: "/meetings",
      actor: "client",
    });
  }

  for (const e of emailsRes.data ?? []) {
    const failed =
      e.status === "failed" || e.status === "bounced" || e.status === "complained";
    items.push({
      id: `email:${e.id}`,
      kind: "email",
      at: e.sent_at ?? e.created_at,
      title: failed
        ? `Email didn't arrive — ${e.subject || "(no subject)"}`
        : `Emailed — ${e.subject || "(no subject)"}`,
      body: clip(e.body_text) ?? e.to_emails.join(", "),
      href: `/inbox?channel=email&thread=email:client:${clientId}`,
      actor: e.actor,
    });
  }
  for (const c of commentsRes.data ?? []) {
    items.push({
      id: `comment:${c.id}`,
      kind: "comment",
      at: c.created_at,
      title:
        c.author_type === "client"
          ? `${c.author_name} wrote on the portal`
          : `${c.author_name} replied on the portal`,
      body: clip(c.body),
      href: `/inbox?channel=portal&thread=portal:${c.project_id}`,
      actor: c.author_type,
    });
  }
  for (const r of changesRes.data ?? []) {
    items.push({
      id: `change:${r.id}`,
      kind: "change_request",
      at: r.created_at,
      title: `Change requested (${r.status})`,
      body: clip(r.body),
      href: `/projects/${r.project_id}`,
      actor: "client",
    });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, input.limit ?? 200);
}
