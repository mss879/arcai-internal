import { NextResponse } from "next/server";

import { renderInvoicePdf, type InvoiceEmailData } from "@/lib/invoice-pdf";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * The client's own copy of their invoice, as a PDF (0093).
 *
 * The signed-in download route at /api/invoices/pdf takes an invoice in the
 * request body — fine when a teammate is authenticated, wrong here: this one
 * accepts a token and nothing else, and renders strictly what is stored
 * against it. A client can therefore only ever download the document they
 * were sent, never one they describe.
 *
 * GET so it works from a plain link in a text message.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!isUuid(token)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const supabase = createAdminClient();
  const { data: row } = await supabase
    .from("invoices")
    .select(
      "invoice_number, invoice_date, bill_to_name, bill_to_details, items, grand_total, due_today, amount_paid, stamp, bank_account",
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const invoice: InvoiceEmailData = {
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    bill_to_name: row.bill_to_name,
    bill_to_details: row.bill_to_details,
    items: (row.items ?? []).map((it) => ({
      item: String(it?.item ?? ""),
      description: String(it?.description ?? ""),
      qty: String(it?.qty ?? ""),
      rate: String(it?.rate ?? ""),
      total: Number(it?.total ?? 0),
    })),
    grand_total: Number(row.grand_total) || 0,
    due_today: Number(row.due_today) || 0,
    amount_paid: Number(row.amount_paid) || 0,
    stamp: row.stamp,
    bank_account: row.bank_account,
  };

  const pdf = await renderInvoicePdf(invoice);
  const safeNumber =
    invoice.invoice_number.replace(/[^a-zA-Z0-9._-]/g, "") || "invoice";

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="invoice-${safeNumber}.pdf"`,
      // The document is fixed once issued, but the link is private — let the
      // client's own browser cache it and nothing in between.
      "Cache-Control": "private, max-age=3600",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
