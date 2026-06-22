import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { renderInvoicePdf, type InvoiceEmailData } from "@/lib/invoice-pdf";

export const runtime = "nodejs";

/**
 * Render an invoice to a real PDF and stream it back as a file download
 * (Content-Disposition: attachment). This is what the "Download PDF" buttons
 * call so the browser saves the file straight away instead of opening the
 * print dialog. It reuses the same @react-pdf renderer that email attachments
 * use, so the downloaded file matches exactly what gets emailed.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Partial<InvoiceEmailData>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  if (!Array.isArray(body.items)) {
    return NextResponse.json(
      { error: "Invoice is missing line items." },
      { status: 400 },
    );
  }

  const invoice: InvoiceEmailData = {
    invoice_number: String(body.invoice_number ?? ""),
    invoice_date: String(body.invoice_date ?? ""),
    bill_to_name: String(body.bill_to_name ?? ""),
    bill_to_details: String(body.bill_to_details ?? ""),
    items: body.items.map((it) => ({
      item: String(it?.item ?? ""),
      description: String(it?.description ?? ""),
      qty: String(it?.qty ?? ""),
      rate: String(it?.rate ?? ""),
      total: Number(it?.total ?? 0),
    })),
    grand_total: Number(body.grand_total ?? 0),
    due_today: Number(body.due_today ?? 0),
  };

  const pdf = await renderInvoicePdf(invoice);

  // Strip characters that can't safely sit in a filename (e.g. the "#" prefix).
  const safeNumber =
    invoice.invoice_number.replace(/[^a-zA-Z0-9._-]/g, "") || "invoice";

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Invoice-${safeNumber}.pdf"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
    },
  });
}
