import { notFound } from "next/navigation";

import {
  INVOICE_COMPANY,
  INVOICE_SIGNOFF,
  invoiceBank,
  stampImage,
} from "@/lib/invoice";
import { createAdminClient } from "@/lib/supabase/admin";

import { PublicInvoice, type PublicInvoiceData } from "./invoice-view";

export const metadata = {
  title: "Invoice — ARC AI",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * A single invoice, on its own public page (0093).
 *
 * This is the ONLY thing a client is given at deposit time. It is not the
 * project portal and it is not a way into one: nothing here links to /public
 * /project, the project is never named beyond the line item the client already
 * agreed to, and the query reads the invoice row alone. Same rules as the
 * portal — scoped read, hand-picked fields, unguessable token, noindex.
 */
export default async function PublicInvoicePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!isUuid(token)) notFound();

  const supabase = createAdminClient();

  const { data: invoice } = await supabase
    .from("invoices")
    // Explicit list. `project_id`, `created_by` and `recipient_email` are
    // deliberately absent — none of them are the client's business.
    .select(
      "invoice_number, invoice_date, bill_to_name, bill_to_details, items, grand_total, due_today, amount_paid, stamp, bank_account",
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!invoice) notFound();

  const bank = invoiceBank(invoice.bank_account);

  const data: PublicInvoiceData = {
    invoiceNumber: invoice.invoice_number,
    invoiceDate: invoice.invoice_date,
    billToName: invoice.bill_to_name,
    billToDetails: invoice.bill_to_details,
    items: invoice.items ?? [],
    grandTotal: Number(invoice.grand_total) || 0,
    amountPaid: Number(invoice.amount_paid) || 0,
    dueToday: Number(invoice.due_today) || 0,
    stampSrc: stampImage(invoice.stamp),
    stampLabel:
      invoice.stamp === "deposit_paid"
        ? "Deposit paid"
        : invoice.stamp === "payment_received"
          ? "Payment received"
          : null,
    company: {
      name: INVOICE_COMPANY.name,
      phones: INVOICE_COMPANY.phones,
      email: INVOICE_COMPANY.email,
      website: INVOICE_COMPANY.website,
      addressLines: [...INVOICE_COMPANY.addressLines],
    },
    bank: {
      bankName: bank.bankName,
      accountName: bank.accountName,
      accountNumber: bank.accountNumber,
      branch: bank.branch,
    },
    questionsLine: INVOICE_SIGNOFF.questionsLine,
    pdfHref: `/api/public/invoice/${token}/pdf`,
  };

  return <PublicInvoice data={data} />;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
