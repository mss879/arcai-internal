import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { sendInvoiceEmail } from "@/lib/email";

export const runtime = "nodejs";

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Send a saved invoice by email. This is the ONLY path that actually sends —
 * it fires only when the user taps "Send" on the confirmation card, after
 * seeing the invoice and the recipient address. The assistant model never
 * reaches this route, so nothing is emailed without an explicit human action.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { invoiceId?: unknown; emails?: unknown; email?: unknown; message?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const invoiceId = String(body?.invoiceId ?? "").trim();
  // Accept an array of emails, or the legacy single `email` field.
  const rawEmails = Array.isArray(body?.emails)
    ? body.emails
    : body?.email != null
      ? [body.email]
      : [];
  const emails = rawEmails
    .map((e) => String(e).trim())
    .filter((e) => isEmail(e));
  const message =
    typeof body?.message === "string" ? body.message.trim() || undefined : undefined;

  if (!invoiceId) {
    return NextResponse.json({ ok: false, error: "Missing invoice." }, { status: 400 });
  }
  if (!emails.length) {
    return NextResponse.json(
      { ok: false, error: "No valid email address to send to." },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();

  if (error || !invoice) {
    return NextResponse.json(
      { ok: false, error: "Invoice not found." },
      { status: 404 },
    );
  }

  const result = await sendInvoiceEmail({
    to: emails,
    message,
    invoice: {
      invoice_number: invoice.invoice_number,
      invoice_date: invoice.invoice_date,
      bill_to_name: invoice.bill_to_name,
      bill_to_details: invoice.bill_to_details,
      items: invoice.items ?? [],
      grand_total: Number(invoice.grand_total),
      due_today: Number(invoice.due_today),
      stamp: invoice.stamp ?? null,
    },
  });

  if (!result.sent) {
    return NextResponse.json(
      { ok: false, error: result.error || "The email failed to send." },
      { status: 502 },
    );
  }

  // Best-effort audit stamp. If the 0020 migration hasn't been applied yet the
  // columns won't exist — the email has already gone, so we ignore any error.
  try {
    await supabase
      .from("invoices")
      .update({ recipient_email: emails.join(", "), sent_at: new Date().toISOString() })
      .eq("id", invoiceId);
  } catch {
    // ignore — stamping is non-critical
  }

  return NextResponse.json({ ok: true });
}
