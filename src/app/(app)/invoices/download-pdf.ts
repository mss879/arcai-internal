import type { InvoiceItem } from "@/lib/database.types";

export type InvoicePdfPayload = {
  invoice_number: string;
  invoice_date: string; // ISO YYYY-MM-DD
  bill_to_name: string;
  bill_to_details: string;
  items: InvoiceItem[];
  grand_total: number;
  due_today: number;
  stamp?: string | null;
};

/**
 * Generate the invoice PDF on the server and save it straight to the user's
 * machine. We fetch the rendered file as a blob and click a temporary <a> with
 * a `download` attribute — no print dialog, no extra clicks.
 */
export async function downloadInvoicePdf(
  payload: InvoicePdfPayload,
): Promise<void> {
  const res = await fetch("/api/invoices/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let message = "Couldn't generate the PDF.";
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // non-JSON error body — keep the default message
    }
    throw new Error(message);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const safeNumber =
    (payload.invoice_number || "invoice").replace(/[^a-zA-Z0-9._-]/g, "") ||
    "invoice";

  const a = document.createElement("a");
  a.href = url;
  a.download = `Invoice-${safeNumber}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
