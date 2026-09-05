import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseSlipImage, parseSlipText, type ParsedSlip } from "@/lib/ai/receipt";
import { capabilityAudienceIds } from "@/lib/capabilities-server";
import { notifyClient } from "@/lib/client-notify";
import { STORAGE_BUCKETS } from "@/lib/constants";
import type { Database, PaymentSlipMatch, PaymentSlipSource, SlipParsed } from "@/lib/database.types";
import { notifyUsers } from "@/lib/notify";
import { recordPayment } from "@/lib/payments";
import { logSystemWrite } from "@/lib/system-audit";

type DB = SupabaseClient<Database>;

/**
 * The bank-transfer slip as the "pay" button (0120).
 *
 * There is no gateway. A client pays by bank transfer, photographs the slip
 * and — until now — sent it on WhatsApp, where it became a task and nothing
 * reconciled. Now a slip is a row: uploaded from the public invoice page,
 * the portal or a WhatsApp thread; read by the same eyes that read supplier
 * receipts; matched against what the invoice still owes; and queued for a
 * finance person to confirm. Only that confirmation records money, and it
 * does so through recordPayment() like every other payment.
 *
 * A future gateway is `source: 'gateway'` + `payments.provider_ref`: its
 * webhook calls recordPayment() directly and this file is never involved.
 */

export const MAX_SLIP_BYTES = 10 * 1024 * 1024;
const DUPLICATE_WINDOW_DAYS = 30;

const ACCEPTED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export function slipMimeOk(mime: string): boolean {
  return ACCEPTED_MIME.has(mime.toLowerCase());
}

export type CreateSlipInput = {
  source: PaymentSlipSource;
  /** The bytes, when this call uploads them. */
  file?: { buffer: Buffer; mime: string; name: string } | null;
  /** An object already in a bucket (WhatsApp media): skip the upload. */
  existing?: { bucket: string; path: string; mime: string | null; size: number | null; publicUrl: string | null } | null;
  /** Fields a classifier already read (the WhatsApp webhook's). */
  prefilled?: Partial<ParsedSlip> | null;
  invoiceId?: string | null;
  projectId?: string | null;
  clientId?: string | null;
  waContactId?: string | null;
  waMessageId?: string | null;
  note?: string | null;
  ip?: string | null;
};

export type CreateSlipResult =
  | { ok: true; slipId: string; match: PaymentSlipMatch; duplicate: boolean }
  | { ok: false; error: string };

export async function createSlip(db: DB, input: CreateSlipInput): Promise<CreateSlipResult> {
  // --- Resolve what it pays ---------------------------------------------
  let invoice: {
    id: string;
    project_id: string | null;
    client_id: string | null;
    grand_total: number;
    paid_amount: number;
    currency: string | null;
  } | null = null;
  if (input.invoiceId) {
    const { data } = await db
      .from("invoices")
      .select("id, project_id, client_id, grand_total, paid_amount, currency, status")
      .eq("id", input.invoiceId)
      .maybeSingle();
    if (data && data.status !== "void") {
      invoice = {
        id: data.id,
        project_id: data.project_id,
        client_id: data.client_id,
        grand_total: Number(data.grand_total) || 0,
        paid_amount: Number(data.paid_amount) || 0,
        currency: data.currency,
      };
    }
  }
  const projectId = input.projectId ?? invoice?.project_id ?? null;
  let clientId = input.clientId ?? invoice?.client_id ?? null;
  if (!clientId && projectId) {
    const { data: project } = await db.from("projects").select("client_id").eq("id", projectId).maybeSingle();
    clientId = project?.client_id ?? null;
  }

  // --- Store the file ------------------------------------------------------
  let bucket = input.existing?.bucket ?? STORAGE_BUCKETS.paymentSlips;
  let path = input.existing?.path ?? "";
  let mime = input.existing?.mime ?? input.file?.mime ?? null;
  let size = input.existing?.size ?? input.file?.buffer.length ?? null;
  let parseUrl: string | null = input.existing?.publicUrl ?? null;

  if (input.file) {
    if (!slipMimeOk(input.file.mime)) {
      return { ok: false, error: "Send a photo (JPG, PNG) or a PDF of the slip." };
    }
    if (input.file.buffer.length > MAX_SLIP_BYTES) {
      return { ok: false, error: "That file is over 10MB — a screenshot of the slip is plenty." };
    }
    const ext = input.file.mime.includes("pdf") ? "pdf" : input.file.mime.includes("png") ? "png" : input.file.mime.includes("webp") ? "webp" : "jpg";
    bucket = STORAGE_BUCKETS.paymentSlips;
    path = `${invoice?.id ?? projectId ?? clientId ?? "unlinked"}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: uploadError } = await db.storage
      .from(bucket)
      .upload(path, input.file.buffer, { contentType: input.file.mime, upsert: false });
    if (uploadError) return { ok: false, error: uploadError.message };
    mime = input.file.mime;
    size = input.file.buffer.length;
  } else if (!path) {
    return { ok: false, error: "No slip to file." };
  }

  // --- Read it ---------------------------------------------------------------
  let parsed: ParsedSlip | null = null;
  try {
    if (mime?.includes("pdf")) {
      const bytes = input.file?.buffer ?? (await downloadBytes(db, bucket, path));
      if (bytes) {
        const { extractText, getDocumentProxy } = await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(bytes));
        const { text } = await extractText(pdf, { mergePages: true });
        parsed = parseSlipText(typeof text === "string" ? text : String(text ?? ""));
      }
    } else if (input.file) {
      parsed = await parseSlipImage(
        `data:${input.file.mime};base64,${input.file.buffer.toString("base64")}`,
      );
    } else if (parseUrl) {
      parsed = await parseSlipImage(parseUrl);
    } else {
      const signed = await db.storage.from(bucket).createSignedUrl(path, 600);
      parseUrl = signed.data?.signedUrl ?? null;
      if (parseUrl) parsed = await parseSlipImage(parseUrl);
    }
  } catch (e) {
    console.error("[slips] parse failed:", e);
  }
  const merged: ParsedSlip = {
    amount: input.prefilled?.amount ?? parsed?.amount ?? null,
    currency: input.prefilled?.currency ?? parsed?.currency ?? null,
    reference: input.prefilled?.reference ?? parsed?.reference ?? null,
    bank: input.prefilled?.bank ?? parsed?.bank ?? null,
    date: input.prefilled?.date ?? parsed?.date ?? null,
    payer: parsed?.payer ?? null,
    confidence: parsed?.confidence ?? "low",
  };

  // --- Match it against what is owed ---------------------------------------
  const balance = invoice ? Math.max(0, invoice.grand_total - invoice.paid_amount) : null;
  const match = matchSlip(merged.amount, balance);

  // --- The same slip twice --------------------------------------------------
  let duplicate = false;
  if (merged.reference || merged.amount) {
    const since = new Date(Date.now() - DUPLICATE_WINDOW_DAYS * 86_400_000).toISOString();
    let q = db
      .from("payment_slips")
      .select("id")
      .gte("created_at", since)
      .in("status", ["pending", "verified"])
      .limit(1);
    q = merged.reference
      ? q.eq("reference", merged.reference)
      : q.eq("amount_claimed", merged.amount!).eq("invoice_id", invoice?.id ?? "");
    const { data: twin } = await q;
    duplicate = Boolean(twin?.length);
  }

  const { data: row, error } = await db
    .from("payment_slips")
    .insert({
      source: input.source,
      invoice_id: invoice?.id ?? null,
      project_id: projectId,
      client_id: clientId,
      wa_contact_id: input.waContactId ?? null,
      wa_message_id: input.waMessageId ?? null,
      file_path: path,
      bucket,
      mime,
      size_bytes: size,
      parsed: merged as SlipParsed,
      amount_claimed: merged.amount,
      reference: merged.reference,
      note: input.note?.trim() || null,
      status: duplicate ? "duplicate" : "pending",
      match,
      ip: input.ip ?? null,
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "Could not file the slip." };

  // T5.3 — a slip nobody uploaded by hand (the WhatsApp classifier filed it).
  if (input.source === "whatsapp") {
    await logSystemWrite(db, {
      job: "slips:whatsapp",
      table: "payment_slips",
      rowId: row.id,
      action: "created",
      summary: `Bank slip filed from WhatsApp${merged.amount ? ` — ${merged.currency ?? invoice?.currency ?? "LKR"} ${merged.amount.toLocaleString()}` : ""}${invoice ? " against an open invoice" : ""}${duplicate ? " (duplicate)" : ""}`,
      meta: { invoice_id: invoice?.id ?? null, client_id: clientId, match, duplicate },
    });
  }

  // Finance hears about it; the queue does the rest.
  await notifyFinance(db, {
    title: duplicate ? "Payment slip received again" : "Payment slip to verify",
    body: `${merged.amount ? `${merged.currency ?? invoice?.currency ?? "LKR"} ${merged.amount.toLocaleString()}` : "Amount unread"}${merged.reference ? ` · ref ${merged.reference}` : ""} · ${match === "exact" ? "matches the balance" : match === "partial" ? "part of the balance" : match === "mismatch" ? "does NOT match the balance" : "no invoice to match"}`,
    link: "/finance?tab=slips",
  });

  return { ok: true, slipId: row.id, match, duplicate };
}

/** How a claimed amount compares with the balance. Pure. */
export function matchSlip(amount: number | null, balance: number | null): PaymentSlipMatch {
  if (amount === null || balance === null) return "unknown";
  if (balance <= 0) return "mismatch";
  const tolerance = Math.max(1, balance * 0.01);
  if (Math.abs(amount - balance) <= tolerance) return "exact";
  if (amount < balance) return "partial";
  return "mismatch";
}

export type ConfirmSlipInput = {
  slipId: string;
  actorId: string;
  /** Override the parsed amount — what the bank statement actually shows. */
  amount?: number | null;
  paidAt?: string | null;
  /** Point it at a different invoice than the one it arrived on. */
  invoiceId?: string | null;
  /** Send the client a "we've received it" line. Default true. */
  tellClient?: boolean;
};

/**
 * A finance person says the money is real. THIS is the moment an invoice
 * becomes paid — through recordPayment(), never a direct write — and the
 * client is told, through the same ladder as everything else.
 */
export async function confirmSlip(
  db: DB,
  input: ConfirmSlipInput,
): Promise<{ ok: true; paymentId: string | null; told: boolean } | { ok: false; error: string }> {
  const { data: slip } = await db
    .from("payment_slips")
    .select("*")
    .eq("id", input.slipId)
    .maybeSingle();
  if (!slip) return { ok: false, error: "That slip no longer exists." };
  if (slip.status === "verified") return { ok: false, error: "This slip was already confirmed." };

  const invoiceId = input.invoiceId ?? slip.invoice_id ?? null;
  const amount = Number(input.amount ?? slip.amount_claimed ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter the amount the bank actually received." };
  }

  const res = await recordPayment(db, {
    source: slip.source === "whatsapp" ? "whatsapp" : "slip",
    invoiceId,
    projectId: slip.project_id,
    amount,
    paidAt: input.paidAt ?? slip.parsed?.date ?? null,
    method: `Bank transfer${slip.parsed?.bank ? ` (${slip.parsed.bank})` : ""}`,
    notes: slip.reference ? `Slip ref ${slip.reference}` : "Bank slip verified",
    receiptPath: slip.bucket === STORAGE_BUCKETS.paymentSlips ? slip.file_path : null,
    slipId: slip.id,
    actorId: input.actorId,
  });
  if (!res.ok) return res;

  await db
    .from("payment_slips")
    .update({
      status: "verified",
      decided_by: input.actorId,
      decided_at: new Date().toISOString(),
      payment_id: res.paymentId,
      amount_claimed: amount,
      invoice_id: invoiceId,
    })
    .eq("id", slip.id);

  let told = false;
  if (input.tellClient !== false && slip.client_id) {
    const { data: inv } = invoiceId
      ? await db.from("invoices").select("invoice_number, currency, status").eq("id", invoiceId).maybeSingle()
      : { data: null };
    const currency = inv?.currency ?? "LKR";
    const settled = inv?.status === "paid";
    const message = inv
      ? `Thank you — we've received ${currency} ${amount.toLocaleString()} against invoice ${inv.invoice_number}${settled ? ", which is now fully paid" : ""}. — ARC AI`
      : `Thank you — we've received your payment of ${currency} ${amount.toLocaleString()}. — ARC AI`;
    const sent = await notifyClient(db, {
      clientId: slip.client_id,
      projectId: slip.project_id,
      message,
      kind: "slip",
      actorId: input.actorId,
      invoiceId,
    });
    told = sent.ok;
  }

  return { ok: true, paymentId: res.paymentId, told };
}

export async function rejectSlip(
  db: DB,
  input: { slipId: string; actorId: string; reason: string; tellClient?: boolean },
): Promise<{ ok: true; told: boolean } | { ok: false; error: string }> {
  const { data: slip } = await db
    .from("payment_slips")
    .select("id, status, client_id, project_id, invoice_id")
    .eq("id", input.slipId)
    .maybeSingle();
  if (!slip) return { ok: false, error: "That slip no longer exists." };
  if (slip.status === "verified") return { ok: false, error: "This slip was confirmed — the payment stands." };

  const { error } = await db
    .from("payment_slips")
    .update({
      status: "rejected",
      decided_by: input.actorId,
      decided_at: new Date().toISOString(),
      rejection_reason: input.reason.trim() || null,
    })
    .eq("id", slip.id);
  if (error) return { ok: false, error: error.message };

  let told = false;
  if (input.tellClient !== false && slip.client_id) {
    const sent = await notifyClient(db, {
      clientId: slip.client_id,
      projectId: slip.project_id,
      message: `Hi — we couldn't match the payment slip you sent to your invoice${input.reason.trim() ? ` (${input.reason.trim()})` : ""}. Could you check it and send it again, or reply here? — ARC AI`,
      kind: "slip",
      actorId: input.actorId,
      invoiceId: slip.invoice_id,
    });
    told = sent.ok;
  }
  return { ok: true, told };
}

export type SlipQueueRow = {
  id: string;
  source: PaymentSlipSource;
  status: Database["public"]["Tables"]["payment_slips"]["Row"]["status"];
  match: PaymentSlipMatch;
  createdAt: string;
  /** Signed for an hour. */
  previewUrl: string | null;
  isPdf: boolean;
  parsed: SlipParsed;
  amountClaimed: number | null;
  reference: string | null;
  note: string | null;
  invoice: { id: string; number: string; total: number; paid: number; balance: number; currency: string } | null;
  project: { id: string; name: string } | null;
  client: { id: string; name: string } | null;
  rejectionReason: string | null;
};

/** The queue, newest first, with previews. Tolerates 0120 not being applied. */
export async function listSlips(db: DB, opts: { status?: "pending" | "all" } = {}): Promise<SlipQueueRow[]> {
  try {
    let q = db
      .from("payment_slips")
      .select("id, source, status, match, created_at, bucket, file_path, mime, parsed, amount_claimed, reference, note, invoice_id, project_id, client_id, rejection_reason")
      .order("created_at", { ascending: false })
      .limit(100);
    if (opts.status !== "all") q = q.in("status", ["pending", "duplicate"]);
    const { data: rows } = await q;
    if (!rows?.length) return [];

    const invoiceIds = [...new Set(rows.map((r) => r.invoice_id).filter((v): v is string => Boolean(v)))];
    const projectIds = [...new Set(rows.map((r) => r.project_id).filter((v): v is string => Boolean(v)))];
    const clientIds = [...new Set(rows.map((r) => r.client_id).filter((v): v is string => Boolean(v)))];
    const [invRes, projRes, clientRes] = await Promise.all([
      invoiceIds.length
        ? db.from("invoices").select("id, invoice_number, grand_total, paid_amount, currency").in("id", invoiceIds)
        : Promise.resolve({ data: [] as { id: string; invoice_number: string; grand_total: number; paid_amount: number; currency: string | null }[] }),
      projectIds.length ? db.from("projects").select("id, name").in("id", projectIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      clientIds.length ? db.from("clients").select("id, name").in("id", clientIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    ]);
    const invoices = new Map((invRes.data ?? []).map((i) => [i.id, i]));
    const projects = new Map((projRes.data ?? []).map((p) => [p.id, p]));
    const clients = new Map((clientRes.data ?? []).map((c) => [c.id, c]));

    // One signed-URL call per bucket.
    const byBucket = new Map<string, string[]>();
    for (const r of rows) byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r.file_path]);
    const urls = new Map<string, string>();
    for (const [bucket, paths] of byBucket) {
      const { data } = await db.storage.from(bucket).createSignedUrls(paths, 3600);
      for (const u of data ?? []) if (u.path && u.signedUrl) urls.set(`${bucket}:${u.path}`, u.signedUrl);
    }

    return rows.map((r) => {
      const inv = r.invoice_id ? invoices.get(r.invoice_id) : null;
      return {
        id: r.id,
        source: r.source,
        status: r.status,
        match: r.match,
        createdAt: r.created_at,
        previewUrl: urls.get(`${r.bucket}:${r.file_path}`) ?? null,
        isPdf: Boolean(r.mime?.includes("pdf")),
        parsed: r.parsed ?? {},
        amountClaimed: r.amount_claimed === null ? null : Number(r.amount_claimed),
        reference: r.reference,
        note: r.note,
        invoice: inv
          ? {
              id: inv.id,
              number: inv.invoice_number,
              total: Number(inv.grand_total) || 0,
              paid: Number(inv.paid_amount) || 0,
              balance: Math.max(0, (Number(inv.grand_total) || 0) - (Number(inv.paid_amount) || 0)),
              currency: inv.currency ?? "LKR",
            }
          : null,
        project: r.project_id ? (projects.get(r.project_id) ?? null) : null,
        client: r.client_id ? (clients.get(r.client_id) ?? null) : null,
        rejectionReason: r.rejection_reason,
      };
    });
  } catch {
    return [];
  }
}

async function downloadBytes(db: DB, bucket: string, path: string): Promise<Buffer | null> {
  const { data } = await db.storage.from(bucket).download(path);
  if (!data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/** T5.2 — admins and the members with the finance tick. */
async function notifyFinance(db: DB, input: { title: string; body: string; link: string }): Promise<void> {
  try {
    const ids = await capabilityAudienceIds("finance");
    if (!ids.length) return;
    await notifyUsers(db, { userIds: ids, type: "approval", title: input.title, body: input.body, link: input.link });
  } catch {
    // never fail a slip on a notification
  }
}
