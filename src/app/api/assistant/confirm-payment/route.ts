import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { getAssistantProfile } from "@/lib/auth";
import { recordPayment } from "@/lib/payments";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Record money against an invoice, on the assistant's behalf (0120).
 *
 * Fires only when a person taps the confirmation card. Through
 * recordPayment(), so the payment row, the invoice state, the project's
 * ledger and History line and the single payment_received all happen once —
 * exactly as they would from the Past invoices list. The model never
 * reaches this route.
 */
export async function POST(request: Request) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { invoiceId?: unknown; amount?: unknown; paidAt?: unknown; method?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const invoiceId = String(body?.invoiceId ?? "").trim();
  const amount = Number(body?.amount);
  if (!invoiceId || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { ok: false, error: "Need the invoice and a positive amount." },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, project_id, currency, status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) {
    return NextResponse.json({ ok: false, error: "That invoice no longer exists." }, { status: 404 });
  }
  if (invoice.status === "void" || invoice.status === "paid") {
    return NextResponse.json(
      { ok: false, error: `That invoice is already ${invoice.status}.` },
      { status: 400 },
    );
  }

  const res = await recordPayment(supabase, {
    source: "assistant",
    invoiceId: invoice.id,
    projectId: invoice.project_id,
    amount,
    currency: invoice.currency,
    paidAt: typeof body?.paidAt === "string" ? body.paidAt : null,
    method: typeof body?.method === "string" ? body.method : null,
    actorId: profile.id,
    actorLabel: "assistant",
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
  }

  revalidatePath("/invoices");
  if (invoice.project_id) revalidatePath(`/projects/${invoice.project_id}`);
  return NextResponse.json({ ok: true, status: res.invoiceStatus });
}
