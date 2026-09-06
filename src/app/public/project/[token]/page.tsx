import { notFound } from "next/navigation";
import { differenceInCalendarDays, startOfToday } from "date-fns";

import { asDocumentBrief, documentBriefApplies } from "@/lib/document-brief";
import { createAdminClient } from "@/lib/supabase/admin";
import { PortalClient, type PortalProject } from "./portal-client";
import { PortalLock } from "./portal-lock";
import { DELIVERY_STAGES, STORAGE_BUCKETS } from "@/lib/constants";
import { checkPortalGate } from "@/lib/portal-access";
import { computeProjectProgress } from "@/lib/project-progress";
import { buildLedger, settledAmount } from "@/lib/projects";
import { referralCodeFor, referralLink } from "@/lib/referrals";
import type {
  DeliveryStage,
  PortalLanguage,
  ProjectDocumentRequest,
} from "@/lib/types";

export const metadata = {
  title: "Client Portal - ARC AI",
  description: "Secure workspace to share files and track your project timeline.",
  // The link is unguessable, but "unguessable" stops meaning anything the
  // moment a client pastes it somewhere a crawler can reach.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The client-facing project portal.
 *
 * Reached with no login, so three rules hold everywhere on this route:
 *
 *   1. Nothing is read without the share token. Every query is scoped by the
 *      project the token resolved to — no unfiltered table reads.
 *   2. Nothing internal crosses to the browser. The project row carries our
 *      internal budget, our cost expenses, our commission allocations and the
 *      share token itself; a Server Component serialises whatever it hands to
 *      a Client Component into the page, so the portal builds an explicit
 *      client-safe view model instead of passing the row through.
 *   3. Since 0094 the project may also carry a passcode. Nothing below the
 *      gate is fetched until it's answered — the lock screen is rendered from
 *      the access columns alone, so a holder of the link without the code
 *      can't even read the project's name out of the page source.
 */
export default async function PublicProjectPortal({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // A share token is a UUID. Anything else can't match a row, so don't spend a
  // database round-trip (or leak timing) on it.
  if (!isUuid(token)) notFound();

  // Unauthenticated route: the service role is the only way in, which makes
  // scoping every query by hand the entire security model here.
  const supabase = createAdminClient();

  // ---- The gate, before anything else is read ---------------------------
  const { data: access } = await supabase
    .from("projects")
    .select(
      "id, portal_passcode, portal_expires_at, portal_revoked_at, portal_locked_until, portal_failed_attempts, portal_language",
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!access) notFound();

  const language = (access.portal_language ?? "en") as PortalLanguage;
  const gate = await checkPortalGate({
    token,
    passcode: access.portal_passcode,
    expiresAt: access.portal_expires_at,
    revokedAt: access.portal_revoked_at,
    lockedUntil: access.portal_locked_until,
    failedAttempts: access.portal_failed_attempts ?? 0,
  });

  if (gate.state !== "open") {
    return (
      <PortalLock
        token={token}
        language={language}
        blocked={
          gate.state === "expired"
            ? "expired"
            : gate.state === "revoked"
              ? "revoked"
              : gate.state === "locked"
                ? "locked"
                : undefined
        }
      />
    );
  }

  // ---- Past the gate ----------------------------------------------------
  const { data: project } = await supabase
    .from("projects")
    // Explicit column list, never select("*") — see rule 2 above.
    .select(
      "id, name, description, status, service_type, delivery_stage, currency, total_value, deposit_paid, deposit_required_percent, document_brief, created_at, start_date, due_date, proposal_url, proposal_name, invoice_url, invoice_name, progress_override, preview_url, live_url, launched_at, client_note, client_note_at, booking_slug, client_id, client:clients(name, company)",
    )
    .eq("id", access.id)
    .maybeSingle();

  if (!project) notFound();

  // Scoped by project id, and only the columns each surface renders.
  const [
    requestsRes,
    linkedRes,
    ownRes,
    milestonesRes,
    approvalsRes,
    changesRes,
    commentsRes,
    pulseRes,
  ] = await Promise.all([
    supabase
      .from("project_document_requests")
      .select(
        "id, project_id, title, description, status, file_url, file_name, submitted_at, required, category, position, created_at",
      )
      .eq("project_id", project.id)
      .neq("status", "na")
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("company_payments")
      .select("id, price_lkr, is_paid, created_at, company_name")
      .eq("project_id", project.id),
    supabase
      .from("payments")
      .select("id, amount, status, paid_at, method")
      .eq("project_id", project.id),
    // Client-visible phases only. Launch checks are never sent this way.
    supabase
      .from("project_milestones")
      .select("id, title, detail, status, due_date, position")
      .eq("project_id", project.id)
      .eq("kind", "milestone")
      .eq("client_visible", true)
      .order("position", { ascending: true }),
    supabase
      .from("project_approvals")
      .select("id, title, detail, status, signer_name, signed_at, created_at")
      .eq("project_id", project.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("project_change_requests")
      .select("id, body, status, quoted_amount, quote_note, created_at")
      .eq("project_id", project.id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("project_comments")
      .select("id, milestone_id, author_type, author_name, body, created_at")
      .eq("project_id", project.id)
      .order("created_at", { ascending: true })
      .limit(60),
    // Only whether they've already answered today — never the score itself.
    supabase
      .from("project_pulses")
      .select("id, created_at")
      .eq("project_id", project.id)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const money = {
    total_value: project.total_value,
    deposit_paid: project.deposit_paid,
    company_payments: linkedRes.data ?? [],
    payments: ownRes.data ?? [],
  };

  const received = settledAmount(money);
  const totalValue = Number(project.total_value) || 0;

  const client = project.client as unknown as {
    name: string;
    company: string | null;
  } | null;

  const stage = (project.delivery_stage ?? null) as DeliveryStage | null;

  // 0112 — the one number the client sees. The milestones query above is
  // already the client-visible set, which is exactly what the rule counts.
  const progress = computeProjectProgress({
    status: project.status,
    deliveryStage: stage,
    milestones: (milestonesRes.data ?? []).map((m) => ({
      status: m.status,
      client_visible: true,
      kind: "milestone",
    })),
    override: project.progress_override,
  });

  // A pulse already given in the last week isn't asked for again.
  // differenceInCalendarDays rather than Date.now(): react-hooks/purity
  // forbids the impure global during render.
  const lastPulse = pulseRes.data?.[0]?.created_at ?? null;
  const pulseAskedRecently = lastPulse
    ? differenceInCalendarDays(startOfToday(), new Date(lastPulse)) < 7
    : false;

  // 0117 — the four things a client should be able to do from their own
  // page: download what we made, sign what we sent, see what's booked, and
  // book more time. Each degrades to an empty list rather than failing the
  // page, because 0117 may not have been applied yet.
  const [deliverablesRes, agreementsRes, meetingsRes, bookingRes, referralCode, slipRes] =
    await Promise.all([
      supabase
        .from("project_deliverables")
        .select("id, title, file_path, version, size_bytes, created_at")
        .eq("project_id", project.id)
        .eq("visible_to_client", true)
        .order("created_at", { ascending: false })
        .limit(50)
        .then((r) => r, () => ({ data: null })),
      project.client_id
        ? supabase
            .from("agreements")
            .select("id, kind, title, status, share_token, signed_at")
            .eq("client_id", project.client_id)
            .neq("status", "void")
            .neq("status", "draft")
            .order("created_at", { ascending: false })
            .limit(20)
            .then((r) => r, () => ({ data: null }))
        : Promise.resolve({ data: null }),
      project.client_id
        ? supabase
            .from("meetings")
            .select("id, title, meeting_at, duration_minutes, location, meeting_url")
            .eq("client_id", project.client_id)
            .gte("meeting_at", new Date().toISOString())
            .order("meeting_at", { ascending: true })
            .limit(10)
            .then((r) => r, () => ({ data: null }))
        : Promise.resolve({ data: null }),
      // The project's own slug wins; otherwise the workspace's first active
      // booking link, so a portal gets one without anybody configuring it.
      project.booking_slug
        ? Promise.resolve({ data: { slug: project.booking_slug } })
        : supabase
            .from("meeting_links")
            .select("slug")
            .eq("active", true)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle()
            .then((r) => r, () => ({ data: null })),
      // 0117 — minted on first sight, so only a client who reaches their
      // portal ever gets a code. Null when there is no client or no 0117.
      project.client_id
        ? referralCodeFor(supabase, project.client_id).catch(() => null)
        : Promise.resolve(null),
      // 0120 — a slip already waiting on this project.
      supabase
        .from("payment_slips")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id)
        .eq("status", "pending")
        .then((r) => r, () => ({ count: 0 })),
    ]);

  // One Storage call for every deliverable, not one each.
  const deliverableRows = deliverablesRes.data ?? [];
  const signedByPath = new Map<string, string>();
  if (deliverableRows.length) {
    const { data: signed } = await supabase.storage
      .from(STORAGE_BUCKETS.projectDocs)
      .createSignedUrls(
        deliverableRows.map((d) => d.file_path),
        3600,
      );
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) signedByPath.set(row.path, row.signedUrl);
    }
  }

  // 0124 — the scope the proposal describes, for "what we're building" when
  // nobody wrote a description, and a "what's included" list. Only what a
  // client may see: the summary and the deliverables, never the warnings.
  const storedBrief = documentBriefApplies(project.created_at)
    ? asDocumentBrief(project.document_brief)
    : null;
  const brief =
    storedBrief?.proposal && (storedBrief.proposal.summary || storedBrief.proposal.deliverables.length)
      ? {
          summary: storedBrief.proposal.summary,
          deliverables: storedBrief.proposal.deliverables.slice(0, 8),
        }
      : null;

  const view: PortalProject = {
    name: project.name,
    description: project.description,
    depositPercent:
      project.deposit_required_percent != null ? Number(project.deposit_required_percent) : null,
    brief,
    status: project.status,
    serviceType: project.service_type,
    stage,
    stageIndex: stage ? DELIVERY_STAGES.indexOf(stage) : -1,
    currency: project.currency,
    totalValue,
    received,
    balance: Math.max(0, totalValue - received),
    paidPercent: totalValue ? Math.min(100, Math.round((received / totalValue) * 100)) : 0,
    startDate: project.start_date,
    dueDate: project.due_date,
    clientName: client?.name ?? null,
    clientCompany: client?.company ?? null,
    documents: [
      project.proposal_url
        ? { label: project.proposal_name || "Proposal", url: project.proposal_url }
        : null,
      project.invoice_url
        ? { label: project.invoice_name || "Invoice", url: project.invoice_url }
        : null,
    ].filter(Boolean) as { label: string; url: string }[],
    // Only settled money, and only the fields a client should see — no
    // internal notes, no receipt paths, no duplicate warnings.
    payments: buildLedger(money)
      .filter((row) => row.paid)
      .map((row) => ({
        id: row.id,
        amount: row.amount,
        date: row.date,
        label: row.source === "deposit" ? "deposit" : "payment",
      })),
    milestones: (milestonesRes.data ?? []).map((m) => ({
      id: m.id,
      title: m.title,
      detail: m.detail,
      done: m.status === "done",
      dueDate: m.due_date,
    })),
    approvals: (approvalsRes.data ?? []).map((a) => ({
      id: a.id,
      title: a.title,
      detail: a.detail,
      status: a.status,
      signerName: a.signer_name,
      signedAt: a.signed_at,
    })),
    changeRequests: (changesRes.data ?? []).map((c) => ({
      id: c.id,
      body: c.body,
      status: c.status,
      quotedAmount: c.quoted_amount ? Number(c.quoted_amount) : null,
      quoteNote: c.quote_note,
      createdAt: c.created_at,
    })),
    comments: (commentsRes.data ?? []).map((c) => ({
      id: c.id,
      milestoneId: c.milestone_id,
      fromClient: c.author_type === "client",
      authorName: c.author_name,
      body: c.body,
      createdAt: c.created_at,
    })),
    deliverables: deliverableRows
      .filter((d) => signedByPath.has(d.file_path))
      .map((d) => ({
        id: d.id,
        title: d.title,
        url: signedByPath.get(d.file_path)!,
        version: d.version,
        sizeBytes: d.size_bytes,
        createdAt: d.created_at,
      })),
    agreements: (agreementsRes.data ?? []).map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      status: a.status,
      url: `/a/${a.share_token}`,
      signedAt: a.signed_at,
    })),
    meetings: (meetingsRes.data ?? []).map((m) => ({
      id: m.id,
      title: m.title,
      at: m.meeting_at,
      durationMinutes: m.duration_minutes,
      location: m.location,
      joinUrl: m.meeting_url,
      icsUrl: `/api/public/meeting/${token}/ics?meeting=${m.id}`,
    })),
    bookingUrl: bookingRes.data?.slug
      ? `/book/${bookingRes.data.slug}?project=${token}`
      : null,
    referral: (() => {
      const link = referralCode ? referralLink(referralCode) : null;
      return referralCode && link ? { code: referralCode, link } : null;
    })(),
    slipPending: (slipRes.count ?? 0) > 0,
    askForPulse: !pulseAskedRecently && stage !== null,
    // 0112
    progressPercent: progress.percent,
    clientNote: project.client_note,
    clientNoteAt: project.client_note_at,
    previewUrl: project.preview_url,
    liveUrl: project.live_url,
    launchedAt: project.launched_at,
  };

  return (
    <PortalClient
      token={token}
      project={view}
      language={language}
      initialRequests={(requestsRes.data ?? []) as ProjectDocumentRequest[]}
    />
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
