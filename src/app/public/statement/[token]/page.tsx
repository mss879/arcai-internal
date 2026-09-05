import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { INVOICE_COMPANY, INVOICE_SIGNOFF, invoiceBank } from "@/lib/invoice";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { buildClientStatement, clientIdForStatementToken } from "@/lib/statement";
import { createAdminClient } from "@/lib/supabase/admin";

import { PublicStatement, type PublicStatementData } from "./statement-view";

export const metadata = {
  title: "Statement of account — ARC AI",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * A client's statement of account, on its own public page (T4.6).
 *
 * The same rules as the public invoice: the token IS the credential, the
 * read is scoped to that one client, every column is hand-picked, and the
 * page is noindex. It is what the portal's "Statement" link opens and what
 * a WhatsApp or SMS fallback links to when the PDF cannot be sent directly.
 * Rate-limited by IP, because it is several queries per view.
 */
export default async function PublicStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { token } = await params;
  if (!isUuid(token)) notFound();

  const supabase = createAdminClient();

  const limit = await enforceRateLimit(
    supabase,
    `statement-page:${clientIp(await headers())}`,
    { limit: 60, windowSec: 300 },
  );
  if (!limit.ok) {
    return (
      <div className="min-h-screen app-bg px-4 py-16 text-center text-sm text-slate-600">
        Too many requests. Please try again in a few minutes.
      </div>
    );
  }

  const clientId = await clientIdForStatementToken(supabase, token);
  if (!clientId) notFound();

  const q = await searchParams;
  const from = isoDay(q.from);
  const to = isoDay(q.to);
  const statement = await buildClientStatement(supabase, clientId, { from, to });
  if (!statement) notFound();

  const bank = invoiceBank(null);
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);

  const data: PublicStatementData = {
    statement,
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
    pdfHref: `/api/public/statement/${token}/pdf${qs.toString() ? `?${qs}` : ""}`,
  };

  return <PublicStatement data={data} />;
}

function isoDay(value: string | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
