import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * Everything waiting on a human decision, in one list (0119).
 *
 * Seven separate things need somebody to say yes: a draft Arcus prepared, a
 * member's advance, a commission allocation, a lesson the WhatsApp agent
 * mined, a cold email waiting to go out, a change the client asked for, and a
 * carousel with no design picked. Each lived on its own screen, which means
 * the ones people forget are the ones on the screen they don't open.
 *
 * This reads them into one shape. It deliberately does NOT act on anything —
 * every queue keeps its own action, with its own rules and its own side
 * effects, and /approvals calls those. Re-implementing "approve a loan" here
 * is how the SMS to the member gets lost.
 */

export type ApprovalKind =
  | "assistant"
  | "loan"
  | "commission"
  | "wa_lesson"
  | "outreach"
  | "change_request"
  | "carousel"
  // 0120
  | "slip";

export type ApprovalItem = {
  /** `<kind>:<id>` — unique across queues. */
  key: string;
  kind: ApprovalKind;
  id: string;
  title: string;
  body: string | null;
  /** Money, when the decision is about money. */
  amount: number | null;
  currency: string | null;
  /** Where to go to act on it, when this list can't. */
  href: string;
  at: string;
  /** Who it concerns, when that is a person rather than a record. */
  subject: string | null;
};

const clip = (text: string | null | undefined, max = 180): string | null => {
  const s = (text ?? "").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * Read all seven queues.
 *
 * Each is wrapped so one missing table — an unapplied migration, a feature
 * not in use — leaves the rest of the list standing. An approvals page that
 * shows six of seven queues is useful; one that shows an error is not.
 */
export async function listApprovalItems(db: DB): Promise<ApprovalItem[]> {
  const safe = async <T>(run: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await run();
    } catch {
      return [];
    }
  };

  const [
    assistant,
    loans,
    commissions,
    lessons,
    outreach,
    changes,
    carousels,
    slips,
  ] = await Promise.all([
    safe(async () => {
      const { data } = await db
        .from("assistant_approvals")
        .select("id, kind, card, created_at, expires_at")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    }),
    safe(async () => {
      const { data } = await db
        .from("member_loans")
        .select("id, user_id, amount, currency, reason, issued_on, created_at")
        .eq("approval", "pending")
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    }),
    safe(async () => {
      const { data } = await db
        .from("commissions")
        .select("id, user_id, amount, note, project_id, created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    }),
    safe(async () => {
      const { data } = await db
        .from("wa_lessons")
        .select("id, title, body, kind, created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    }),
    safe(async () => {
      const { data } = await db
        .from("lead_outreach")
        .select("id, lead_id, subject, body, created_at")
        .eq("status", "ready")
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    }),
    safe(async () => {
      const { data } = await db
        .from("project_change_requests")
        .select("id, project_id, body, status, quoted_amount, client_name, created_at")
        .in("status", ["new", "quoted"])
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    }),
    safe(async () => {
      const { data } = await db
        .from("carousel_posts")
        .select("id, topic, scheduled_for, created_at")
        .eq("status", "ready")
        .is("chosen_option_id", null)
        .order("scheduled_for", { ascending: true })
        .limit(50);
      return data ?? [];
    }),
    // 0120 — bank slips waiting for a finance person.
    safe(async () => {
      const { data } = await db
        .from("payment_slips")
        .select("id, source, status, match, amount_claimed, reference, invoice_id, client_id, created_at")
        .in("status", ["pending", "duplicate"])
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    }),
  ]);

  // Names, in one round-trip rather than per row.
  const userIds = [
    ...new Set([
      ...loans.map((l) => l.user_id),
      ...commissions.map((c) => c.user_id),
    ]),
  ].filter(Boolean);
  const names = new Map<string, string>();
  if (userIds.length) {
    const { data } = await db
      .from("profiles")
      .select("id, full_name")
      .in("id", userIds);
    for (const p of data ?? []) names.set(p.id, p.full_name);
  }

  // 0120 — the slips' invoices and clients, one round-trip each.
  const slipInvoiceNumbers = new Map<string, string>();
  const slipClientNames = new Map<string, string>();
  {
    const invIds = [...new Set(slips.map((sl) => sl.invoice_id).filter((v): v is string => Boolean(v)))];
    const cIds = [...new Set(slips.map((sl) => sl.client_id).filter((v): v is string => Boolean(v)))];
    if (invIds.length) {
      const { data } = await db.from("invoices").select("id, invoice_number").in("id", invIds);
      for (const r of data ?? []) slipInvoiceNumbers.set(r.id, r.invoice_number);
    }
    if (cIds.length) {
      const { data } = await db.from("clients").select("id, name").in("id", cIds);
      for (const r of data ?? []) slipClientNames.set(r.id, r.name);
    }
  }

  const items: ApprovalItem[] = [
    ...assistant.map((a) => ({
      key: `assistant:${a.id}`,
      kind: "assistant" as const,
      id: a.id,
      title: assistantTitle(a.kind),
      body: clip(
        (a.card as { sms?: { message?: string }; email?: { subject?: string } } | null)
          ?.sms?.message ??
          (a.card as { email?: { subject?: string } } | null)?.email?.subject ??
          null,
      ),
      amount: null,
      currency: null,
      href: "/dashboard",
      at: a.created_at,
      subject: null,
    })),
    ...loans.map((l) => ({
      key: `loan:${l.id}`,
      kind: "loan" as const,
      id: l.id,
      title: `Advance for ${names.get(l.user_id) ?? "a team member"}`,
      body: clip(l.reason),
      amount: Number(l.amount),
      currency: l.currency,
      href: `/team/${l.user_id}`,
      at: l.created_at,
      subject: names.get(l.user_id) ?? null,
    })),
    ...commissions.map((c) => ({
      key: `commission:${c.id}`,
      kind: "commission" as const,
      id: c.id,
      title: `Commission for ${names.get(c.user_id) ?? "a team member"}`,
      body: clip(c.note),
      amount: Number(c.amount),
      currency: "LKR",
      href: c.project_id ? `/projects/${c.project_id}` : `/team/${c.user_id}`,
      at: c.created_at,
      subject: names.get(c.user_id) ?? null,
    })),
    ...lessons.map((l) => ({
      key: `wa_lesson:${l.id}`,
      kind: "wa_lesson" as const,
      id: l.id,
      title: l.title,
      body: clip(l.body),
      amount: null,
      currency: null,
      href: "/whatsapp",
      at: l.created_at,
      subject: null,
    })),
    ...outreach.map((o) => ({
      key: `outreach:${o.id}`,
      kind: "outreach" as const,
      id: o.lead_id,
      title: o.subject || "A cold email is ready",
      body: clip(o.body),
      amount: null,
      currency: null,
      href: `/crm/lead/${o.lead_id}`,
      at: o.created_at,
      subject: null,
    })),
    ...changes.map((c) => ({
      key: `change_request:${c.id}`,
      kind: "change_request" as const,
      id: c.id,
      title:
        c.status === "quoted"
          ? "A priced change is waiting to be billed"
          : "A client asked for a change",
      body: clip(c.body),
      amount: c.quoted_amount ? Number(c.quoted_amount) : null,
      currency: "LKR",
      href: `/projects/${c.project_id}`,
      at: c.created_at,
      subject: c.client_name,
    })),
    ...carousels.map((p) => ({
      key: `carousel:${p.id}`,
      kind: "carousel" as const,
      id: p.id,
      title: `Pick a design — ${p.topic}`,
      body: `Scheduled for ${p.scheduled_for}.`,
      amount: null,
      currency: null,
      href: "/content",
      at: p.created_at,
      subject: null,
    })),
    // 0120 — bank slips. Approve records the money at the claimed amount;
    // Finance → Slips is where to look at the picture or change the figure.
    ...slips.map((sl) => ({
      key: `slip:${sl.id}`,
      kind: "slip" as const,
      id: sl.id,
      title:
        sl.status === "duplicate"
          ? "Payment slip — seen before"
          : sl.match === "exact"
            ? "Payment slip — matches the balance"
            : sl.match === "partial"
              ? "Payment slip — part of the balance"
              : sl.match === "mismatch"
                ? "Payment slip — does NOT match"
                : "Payment slip — no invoice to match",
      body: clip(
        [
          sl.invoice_id && slipInvoiceNumbers.get(sl.invoice_id)
            ? `Invoice ${slipInvoiceNumbers.get(sl.invoice_id)}`
            : null,
          sl.reference ? `ref ${sl.reference}` : null,
          `via ${sl.source.replace("_", " ")}`,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      amount: sl.amount_claimed === null ? null : Number(sl.amount_claimed),
      currency: "LKR",
      href: "/finance?tab=slips",
      at: sl.created_at,
      subject: sl.client_id ? (slipClientNames.get(sl.client_id) ?? null) : null,
    })),
  ];

  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function assistantTitle(kind: string): string {
  switch (kind) {
    case "invoice_email":
      return "Arcus drafted an invoice email";
    case "sms":
      return "Arcus drafted a text";
    case "email":
      return "Arcus drafted an email";
    case "whatsapp":
      return "Arcus drafted a WhatsApp message";
    case "campaign_launch":
      return "Arcus wants to launch a campaign";
    case "engine_start":
      return "Arcus wants to start the engine";
    default:
      return "Arcus prepared something";
  }
}

/**
 * How many things are waiting, for the topbar badge.
 *
 * One RPC (0119) rather than seven counts: a badge on every page must be one
 * round-trip. Returns 0 rather than throwing when the function isn't there —
 * a missing badge is better than a broken layout.
 */
export async function approvalsCount(db: DB): Promise<number> {
  try {
    const { data, error } = await db.rpc("approvals_count");
    if (error) return 0;
    return Number(data ?? 0);
  } catch {
    return 0;
  }
}
