"use server";

/**
 * Confirming a deposit (0093).
 *
 * The sequence the team actually follows: money is expected, someone opens
 * their banking app, sees it, and only then says so. Pressing Confirm is that
 * "only then" — and everything that should follow from it happens in one go:
 *
 *   1. an invoice is raised for the project, stamped DEPOSIT PAID, showing
 *      the deposit against the total and what's left;
 *   2. the client is texted a link to that invoice — the invoice alone, on
 *      its own public page, with no way into the portal or the workspace;
 *   3. the project records who confirmed it and when, which is what stops a
 *      second press raising a second invoice or sending a second text.
 *
 * Deliberately NOT automatic: no webhook or payment stamp can know the money
 * cleared the bank, and an invoice that says PAID when it isn't is worse than
 * no invoice at all.
 */

import { revalidatePath } from "next/cache";

import { nextInvoiceNumber } from "@/lib/invoice";
import { settledAmount } from "@/lib/projects";
import {
  firstName,
  invoiceLink,
  projectClientContact,
  sendClientSms,
} from "@/lib/project-sms";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export type ConfirmDepositResult =
  | {
      ok: true;
      invoiceNumber: string;
      /** The public link, so the UI can show and copy it. */
      link: string | null;
      /** Null when the text went out; a sentence when it couldn't. */
      smsError: string | null;
    }
  | { ok: false; error: string };

/**
 * Confirm the deposit for a project.
 *
 * The invoice is raised first and the text second, on purpose: if the SMS
 * fails (no number, no credit, Notify.lk down) the invoice still exists and
 * the link is handed back for the team to send by hand. The reverse order
 * would risk texting a link to an invoice that was never created.
 */
export async function confirmDeposit(
  projectId: string,
): Promise<ConfirmDepositResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const [projectRes, linkedRes, ownRes, numbersRes] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "id, name, description, currency, total_value, deposit_paid, deposit_confirmed_at, service_type, client_id, client:clients(id, name, company, email, phone)",
      )
      .eq("id", projectId)
      .maybeSingle(),
    supabase
      .from("company_payments")
      .select("price_lkr, is_paid")
      .eq("project_id", projectId),
    supabase.from("payments").select("amount, status").eq("project_id", projectId),
    supabase.from("invoices").select("invoice_number"),
  ]);

  const project = projectRes.data;
  if (!project) return { ok: false, error: "Project not found." };

  // The one-time guard. Re-sending an existing link is a different action.
  if (project.deposit_confirmed_at) {
    return {
      ok: false,
      error: "This deposit was already confirmed. Use “Send again” to re-send the link.",
    };
  }

  const received = settledAmount({
    deposit_paid: project.deposit_paid,
    company_payments: linkedRes.data ?? [],
    payments: ownRes.data ?? [],
  });
  if (received <= 0) {
    return {
      ok: false,
      error: "There's no deposit recorded on this project yet — add it first.",
    };
  }

  const total = Number(project.total_value) || 0;
  if (total <= 0) {
    return {
      ok: false,
      error: "Give the project a total value before invoicing the deposit.",
    };
  }

  const client = project.client as unknown as {
    id: string;
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
  } | null;

  // ---- 1. The stamped invoice -------------------------------------------
  const invoiceNumber = nextInvoiceNumber(
    (numbersRes.data ?? []).map((n) => n.invoice_number),
  );

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      invoice_number: invoiceNumber,
      invoice_date: new Date().toISOString().slice(0, 10),
      bill_to_name: client?.name ?? project.name,
      bill_to_details: [client?.company, client?.email, client?.phone]
        .filter(Boolean)
        .join("\n"),
      items: [
        {
          item: project.name,
          description: project.description ?? "Project as agreed.",
          qty: "1",
          rate: String(total),
          total,
        },
      ],
      grand_total: total,
      // What they've paid, and therefore what the stamp is for.
      amount_paid: received,
      due_today: Math.max(0, total - received),
      project_id: projectId,
      recipient_email: client?.email ?? null,
      created_by: user.id,
    })
    .select("id, invoice_number, share_token")
    .single();

  if (error || !invoice) {
    return { ok: false, error: error?.message ?? "Couldn't create the invoice." };
  }

  // The stamp goes on in its own write, the way saveInvoice has always done
  // it: `invoices.stamp` (0024) is absent on databases that never ran that
  // migration, and an invoice that prints without its rubber stamp is a much
  // better outcome than a confirmation that fails outright. 0095 adds the
  // column back; this keeps working either way.
  const { error: stampError } = await supabase
    .from("invoices")
    .update({ stamp: "deposit_paid" })
    .eq("id", invoice.id);
  if (stampError) {
    console.error("[deposit] couldn't stamp the invoice:", stampError.message);
  }

  // ---- 2. Stamp the project (before the text, so a slow SMS can't leave
  //         the confirmation un-recorded if the request is abandoned) ------
  await supabase
    .from("projects")
    .update({
      deposit_confirmed_at: new Date().toISOString(),
      deposit_confirmed_by: user.id,
      deposit_invoice_id: invoice.id,
    })
    .eq("id", projectId);

  // ---- 3. Text the client the link --------------------------------------
  const link = invoiceLink(invoice.share_token);
  const smsError = await textInvoiceLink(supabase, {
    projectId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    amount: `${project.currency} ${received.toLocaleString()}`,
    link,
    actorId: user.id,
    firstSend: true,
  });

  if (!smsError) {
    await supabase
      .from("invoices")
      .update({ shared_at: new Date().toISOString() })
      .eq("id", invoice.id);
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  revalidatePath("/invoices");
  revalidatePath("/sms");

  return {
    ok: true,
    invoiceNumber: invoice.invoice_number,
    link,
    smsError,
  };
}

/**
 * Re-send the deposit invoice link.
 *
 * Same invoice, same link — a client who lost the text gets the document they
 * already have, not a new one with a new number.
 */
export async function resendDepositInvoice(
  projectId: string,
): Promise<ActionResult & { link?: string | null }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("id, currency, deposit_invoice_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project?.deposit_invoice_id) {
    return { ok: false, error: "No deposit invoice has been raised yet." };
  }

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, invoice_number, share_token, amount_paid")
    .eq("id", project.deposit_invoice_id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "That invoice no longer exists." };

  const link = invoiceLink(invoice.share_token);
  const smsError = await textInvoiceLink(supabase, {
    projectId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    amount: `${project.currency} ${Number(invoice.amount_paid ?? 0).toLocaleString()}`,
    link,
    actorId: user.id,
    firstSend: false,
  });
  if (smsError) return { ok: false, error: smsError };

  await supabase
    .from("invoices")
    .update({ shared_at: new Date().toISOString() })
    .eq("id", invoice.id);

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/sms");
  return { ok: true, link };
}

/**
 * The message itself. Returns null on success, or the reason it didn't go.
 *
 * Kept short deliberately — one segment where possible, no marketing, and the
 * link last so it's the thing their thumb lands on.
 */
async function textInvoiceLink(
  supabase: Awaited<ReturnType<typeof authed>>["supabase"],
  opts: {
    projectId: string;
    invoiceId: string;
    invoiceNumber: string;
    amount: string;
    link: string | null;
    actorId: string;
    firstSend: boolean;
  },
): Promise<string | null> {
  const contact = await projectClientContact(supabase, opts.projectId);
  if ("error" in contact) return contact.error;

  const name = firstName(contact.clientName);
  // Kept tight on purpose: the link alone is ~72 characters, and every 160
  // characters is another segment the agency pays for.
  const body = opts.firstSend
    ? `Hi ${name}, we've received your deposit of ${opts.amount} for ${contact.projectName}. Invoice ${opts.invoiceNumber}:`
    : `Hi ${name}, your invoice ${opts.invoiceNumber} for ${contact.projectName}:`;

  // No link configured (NEXT_PUBLIC_APP_URL unset) — say so rather than
  // texting a sentence that trails off into nothing.
  if (!opts.link) {
    return "The invoice was created, but NEXT_PUBLIC_APP_URL isn't set so there's no public link to send.";
  }

  const res = await sendClientSms(supabase, {
    contact,
    message: `${body}\n${opts.link}\n— ARC AI`,
    kind: "payment_reminder",
    invoiceId: opts.invoiceId,
    actorId: opts.actorId,
    eventDetail: opts.firstSend
      ? `Deposit confirmed — invoice ${opts.invoiceNumber} texted to ${contact.clientName}`
      : `Invoice ${opts.invoiceNumber} link re-sent to ${contact.clientName}`,
  });

  return res.ok ? null : res.error;
}
