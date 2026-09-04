import { notFound } from "next/navigation";

import type { ChainLink } from "@/components/projects/chain-card";
import { requireProfile } from "@/lib/auth";
import { clientTimeline } from "@/lib/client-timeline";
import { computeProjectProgress } from "@/lib/project-progress";
import { PROJECT_MONEY_SELECT, balanceDue, settledAmount } from "@/lib/projects";
import { createClient } from "@/lib/supabase/server";

import { ClientDetail, type ClientView } from "./client-detail";

export const metadata = { title: "Client" };

/**
 * One client, everything (0112).
 *
 * Until now a client's projects, quotes, invoices, payments, meetings and
 * conversations were reachable only by opening each module and filtering by
 * name; the client's OWN portal (/portal) joined more of it than the team's
 * screens did. This page lifts that query shape and adds the rest. Two waves:
 * the records keyed by client_id, then the ones keyed by those records'
 * ids (invoices by project, messages by WhatsApp thread).
 */
export default async function ClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [profile, supabase] = await Promise.all([requireProfile(), createClient()]);

  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!client) notFound();

  // ---- Wave 1: keyed by the client ----------------------------------------
  const [
    projectsRes,
    leadsRes,
    quotesRes,
    proposalsRes,
    plansRes,
    meetingsRes,
    bookingsRes,
    waContactsRes,
    churnRes,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select(
        `id, name, status, delivery_stage, due_date, currency, total_value, deposit_paid, share_token, portal_passcode, portal_revoked_at, portal_last_sent_at, progress_override, live_url, preview_url, launched_at, created_at, ${PROJECT_MONEY_SELECT}, milestones:project_milestones(status, client_visible, kind)`,
      )
      .eq("client_id", id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("leads")
      .select("id, title, status, value, currency, created_at, won_at")
      .eq("client_id", id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("quotes")
      .select(
        "id, quote_number, title, grand_total, currency, status, share_token, created_at, accepted_at, invoice_id",
      )
      .eq("client_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("proposals")
      .select("id, project_name, grand_total, proposal_date, project_id")
      .eq("client_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("payment_plans")
      .select(
        "id, title, total, currency, status, project_id, installments:payment_installments(id, seq, amount, due_date, status, paid_at)",
      )
      .eq("client_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("meetings")
      .select("id, title, meeting_at, duration_minutes, location_type, location, meeting_url")
      .eq("client_id", id)
      .order("meeting_at", { ascending: false })
      .limit(30),
    supabase
      .from("meeting_bookings")
      .select("id, booking_date, start_time, end_time, status, notes")
      .eq("client_id", id)
      .order("booking_date", { ascending: false })
      .limit(30),
    supabase
      .from("wa_contacts")
      .select("id, wa_id, display_name, last_message_at, last_inbound_at, do_not_contact")
      .eq("client_id", id)
      .order("last_message_at", { ascending: false, nullsFirst: false }),
    supabase
      .from("churn_alerts")
      .select("id, severity, reason, status, created_at")
      .eq("client_id", id)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  type ProjectRow = {
    id: string;
    name: string;
    status: string;
    delivery_stage: string | null;
    due_date: string | null;
    currency: string;
    total_value: number | null;
    deposit_paid: number | null;
    share_token: string | null;
    portal_passcode: string | null;
    portal_revoked_at: string | null;
    portal_last_sent_at: string | null;
    progress_override: number | null;
    live_url: string | null;
    preview_url: string | null;
    launched_at: string | null;
    created_at: string;
    payments: { id: string; amount: number; status: string; paid_at: string | null; method: string | null; notes: string | null }[] | null;
    company_payments: { id: string; price_lkr: number; is_paid: boolean; created_at: string; company_name: string }[] | null;
    milestones: { status: string; client_visible: boolean | null; kind: string }[] | null;
  };
  type PlanRow = {
    id: string;
    title: string;
    total: number;
    currency: string;
    status: string;
    project_id: string | null;
    installments:
      | { id: string; seq: number; amount: number; due_date: string; status: string; paid_at: string | null }[]
      | null;
  };
  // The nested selects aren't declared in the hand-authored DB types.
  const projectRows = (projectsRes.data ?? []) as unknown as ProjectRow[];
  const planRows = (plansRes.data ?? []) as unknown as PlanRow[];
  const leads = leadsRes.data ?? [];
  const waContacts = waContactsRes.data ?? [];

  const projectIds = projectRows.map((p) => p.id);
  const leadIds = leads.map((l) => l.id);
  const waContactIds = waContacts.map((c) => c.id);

  // ---- Wave 2: keyed by what wave 1 found ---------------------------------
  const invoiceQuery = supabase
    .from("invoices")
    .select(
      "id, invoice_number, invoice_date, grand_total, due_today, amount_paid, stamp, share_token, project_id, currency",
    )
    .order("invoice_date", { ascending: false })
    .limit(60);
  const [invoicesRes, smsRes, waMessagesRes, timeline] = await Promise.all([
    projectIds.length
      ? invoiceQuery.or(`client_id.eq.${id},project_id.in.(${projectIds.join(",")})`)
      : invoiceQuery.eq("client_id", id),
    supabase
      .from("sms_messages")
      .select("id, to_number, message, kind, status, created_at")
      .eq("client_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    waContactIds.length
      ? supabase
          .from("wa_messages")
          .select("id, contact_id, direction, body, status, sent_by, created_at")
          .in("contact_id", waContactIds)
          .order("created_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [] }),
    clientTimeline(supabase, { clientId: id, leadIds, projectIds, waContactIds }),
  ]);

  // ---- View model ----------------------------------------------------------
  const projects: ClientView["projects"] = projectRows.map((p) => {
    const received = settledAmount(p);
    const totalValue = Number(p.total_value) || 0;
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      stage: p.delivery_stage,
      dueDate: p.due_date,
      currency: p.currency || "LKR",
      totalValue,
      received,
      balance: balanceDue(p),
      progress: computeProjectProgress({
        status: p.status,
        deliveryStage: p.delivery_stage,
        milestones: p.milestones ?? [],
        override: p.progress_override,
      }).percent,
      shareToken: p.share_token,
      portalPasscode: p.portal_passcode,
      portalRevoked: Boolean(p.portal_revoked_at),
      portalLastSentAt: p.portal_last_sent_at,
      liveUrl: p.live_url,
      previewUrl: p.preview_url,
      launchedAt: p.launched_at,
      createdAt: p.created_at,
    };
  });

  const currency = projects[0]?.currency ?? "LKR";
  const summary = {
    projects: projects.length,
    open: projects.filter((p) => p.status !== "completed" && p.status !== "cancelled").length,
    totalValue: projects.reduce((s, p) => s + p.totalValue, 0),
    received: projects.reduce((s, p) => s + p.received, 0),
    balance: projects.reduce((s, p) => s + p.balance, 0),
    currency,
  };

  const invoices = invoicesRes.data ?? [];
  const quotes = quotesRes.data ?? [];
  const proposals = proposalsRes.data ?? [];

  const chain: ChainLink[] = [
    ...leads.map((l) => ({
      kind: "lead" as const,
      label: l.title,
      sublabel: l.status === "won" ? "Won" : l.status === "lost" ? "Lost" : "Open lead",
      href: `/crm/lead/${l.id}`,
      amount: l.value === null ? null : Number(l.value),
    })),
    ...quotes.map((q) => ({
      kind: "quote" as const,
      label: `${q.quote_number}${q.title ? ` — ${q.title}` : ""}`,
      sublabel: q.status,
      href: "/invoices?tab=quotes",
      amount: Number(q.grand_total) || 0,
    })),
    ...proposals.map((p) => ({
      kind: "proposal" as const,
      label: p.project_name || "Proposal",
      sublabel: p.proposal_date,
      href: "/proposals",
      amount: Number(p.grand_total) || 0,
    })),
    ...projects.map((p) => ({
      kind: "project" as const,
      label: p.name,
      sublabel: `${p.progress}% built`,
      href: `/projects/${p.id}`,
      amount: p.totalValue,
    })),
    ...(invoices.length
      ? [
          {
            kind: "invoice" as const,
            label: invoices.length === 1 ? `Invoice ${invoices[0].invoice_number}` : "Invoices",
            sublabel: null,
            href: "/invoices?tab=past",
            amount: invoices.reduce((s, i) => s + (Number(i.grand_total) || 0), 0),
            count: invoices.length,
          },
        ]
      : []),
    ...(summary.received > 0
      ? [
          {
            kind: "payment" as const,
            label: "Received",
            sublabel: null,
            href: "/payments",
            amount: summary.received,
          },
        ]
      : []),
  ];

  const conversations: ClientView["conversations"] = [
    ...(waMessagesRes.data ?? []).map((m) => ({
      id: `wa:${m.id}`,
      channel: "whatsapp" as const,
      direction: m.direction === "in" ? ("in" as const) : ("out" as const),
      body: m.body,
      at: m.created_at,
      status: m.status,
      actor: m.direction === "in" ? "client" : (m.sent_by ?? "team"),
    })),
    ...(smsRes.data ?? []).map((s) => ({
      id: `sms:${s.id}`,
      channel: "sms" as const,
      direction: "out" as const,
      body: s.message,
      at: s.created_at,
      status: s.status,
      actor: "team",
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const view: ClientView = {
    client: {
      id: client.id,
      name: client.name,
      company: client.company,
      email: client.email,
      phone: client.phone,
      city: client.city,
      status: client.status,
      notes: client.notes,
      createdAt: client.created_at,
      portalLastLoginAt: client.portal_last_login_at,
      portalLoginCount: client.portal_login_count ?? 0,
    },
    isAdmin: profile.role === "admin",
    baseUrl: (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, ""),
    summary,
    projects,
    leads: leads.map((l) => ({
      id: l.id,
      title: l.title,
      status: l.status,
      value: l.value === null ? null : Number(l.value),
      currency: l.currency,
      createdAt: l.created_at,
      wonAt: l.won_at,
    })),
    quotes: quotes.map((q) => ({
      id: q.id,
      number: q.quote_number,
      title: q.title,
      total: Number(q.grand_total) || 0,
      currency: q.currency,
      status: q.status,
      shareToken: q.share_token,
      createdAt: q.created_at,
      acceptedAt: q.accepted_at,
      invoiced: Boolean(q.invoice_id),
    })),
    proposals: proposals.map((p) => ({
      id: p.id,
      projectName: p.project_name,
      total: Number(p.grand_total) || 0,
      date: p.proposal_date,
      projectId: p.project_id,
    })),
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.invoice_number,
      date: i.invoice_date,
      total: Number(i.grand_total) || 0,
      dueToday: Number(i.due_today) || 0,
      amountPaid: i.amount_paid === null ? null : Number(i.amount_paid),
      stamp: i.stamp,
      shareToken: i.share_token,
      projectId: i.project_id,
      currency: i.currency,
    })),
    plans: planRows.map((p) => ({
      id: p.id,
      title: p.title,
      total: Number(p.total) || 0,
      currency: p.currency,
      status: p.status,
      projectId: p.project_id,
      installments: (p.installments ?? [])
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((i) => ({
          id: i.id,
          seq: i.seq,
          amount: Number(i.amount) || 0,
          dueDate: i.due_date,
          status: i.status,
          paidAt: i.paid_at,
        })),
    })),
    meetings: (meetingsRes.data ?? []).map((m) => ({
      id: m.id,
      title: m.title,
      at: m.meeting_at,
      durationMinutes: m.duration_minutes,
      locationType: m.location_type,
      location: m.location,
      meetingUrl: m.meeting_url,
    })),
    bookings: (bookingsRes.data ?? []).map((b) => ({
      id: b.id,
      date: b.booking_date,
      start: b.start_time,
      end: b.end_time,
      status: b.status,
      notes: b.notes,
    })),
    waContacts: waContacts.map((c) => ({
      id: c.id,
      waId: c.wa_id,
      displayName: c.display_name,
      lastMessageAt: c.last_message_at,
      doNotContact: c.do_not_contact,
    })),
    conversations,
    churn: (churnRes.data ?? []).map((c) => ({
      id: c.id,
      severity: c.severity,
      reason: c.reason,
      status: c.status,
      createdAt: c.created_at,
    })),
    timeline,
    chain,
  };

  return <ClientDetail view={view} />;
}
