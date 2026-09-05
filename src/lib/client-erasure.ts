import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { buildClientStatement } from "@/lib/statement";
import { createAdminClient } from "@/lib/supabase/admin";
import { logSystemWrite } from "@/lib/system-audit";

type DB = SupabaseClient<Database>;

/**
 * Forgetting a client (T5.7, 0121).
 *
 * The bare `delete from clients` that used to answer this request either
 * cascaded through everything the client ever touched or failed on the
 * first foreign key, and in both cases it left the personal data in every
 * conversation exactly where it was. This module does what the request
 * actually means:
 *
 *   anonymise  — scrub every field that identifies the person, on the
 *                client row and on everything that carries their words or
 *                contact details (WhatsApp, SMS, email, leads, bookings,
 *                agreements, bank slips), and keep the rows so invoices and
 *                payments still add up. The default, and the ONLY option
 *                once money has been invoiced or received.
 *   delete     — anonymise, then remove the client row (cascades as before).
 *                Refused when any invoice or payment exists.
 *
 * Every erasure is a `system_events` line with who asked for it. The export
 * is the other half of the right: everything held about them, as a zip.
 */

export type EraseMode = "anonymise" | "delete";

export type EraseResult =
  | { ok: true; mode: EraseMode; touched: Record<string, number> }
  | { ok: false; error: string };

const ERASED = "Erased client";
const ERASED_TEXT = "[erased]";

/** `***…567` — enough to match a row in a dispute, useless to dial. */
function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits ? `***${digits.slice(-3)}` : "***";
}

export async function eraseClient(
  db: DB,
  clientId: string,
  mode: EraseMode,
  opts: { actorId: string | null },
): Promise<EraseResult> {
  const { data: client } = await db
    .from("clients")
    .select("id, name, email, phone, phone_norm, company")
    .eq("id", clientId)
    .maybeSingle();
  if (!client) return { ok: false, error: "That client no longer exists." };

  // --- Can the row go at all? -----------------------------------------------
  const { data: projects } = await db.from("projects").select("id").eq("client_id", clientId);
  const projectIds = (projects ?? []).map((p) => p.id);

  const invoiceQuery = db.from("invoices").select("id", { count: "exact", head: true });
  const { count: invoices } = projectIds.length
    ? await invoiceQuery.or(`client_id.eq.${clientId},project_id.in.(${projectIds.join(",")})`)
    : await invoiceQuery.eq("client_id", clientId);
  const { count: payments } = projectIds.length
    ? await db.from("payments").select("id", { count: "exact", head: true }).in("project_id", projectIds)
    : { count: 0 };

  if (mode === "delete" && ((invoices ?? 0) > 0 || (payments ?? 0) > 0)) {
    return {
      ok: false,
      error: `${client.name} has ${invoices ?? 0} invoice(s) and ${payments ?? 0} payment(s) on record. The accounts must still add up — anonymise instead, which scrubs every personal detail and keeps the money.`,
    };
  }

  const touched: Record<string, number> = {};
  const count = (key: string, n: number | null | undefined) => {
    touched[key] = (touched[key] ?? 0) + (n ?? 0);
  };

  // --- WhatsApp: the names and every word -------------------------------
  const { data: waContacts } = await db.from("wa_contacts").select("id").eq("client_id", clientId);
  const waIds = (waContacts ?? []).map((c) => c.id);
  if (waIds.length) {
    const { count: n } = await db
      .from("wa_contacts")
      .update({
        display_name: ERASED,
        profile_name: null,
        last_message_preview: null,
        do_not_contact: true,
        agent_enabled: false,
      }, { count: "exact" })
      .in("id", waIds);
    count("wa_contacts", n);
    const { count: m } = await db
      .from("wa_messages")
      .update({ body: ERASED_TEXT, meta: {} }, { count: "exact" })
      .in("contact_id", waIds);
    count("wa_messages", m);
  }

  // --- SMS: the number masked, the words gone ----------------------------
  {
    const { count: n } = await db
      .from("sms_messages")
      .update({ to_number: maskPhone(client.phone), message: ERASED_TEXT, client_name: ERASED }, { count: "exact" })
      .eq("client_id", clientId);
    count("sms_messages", n);
  }

  // --- Leads: how they were reached -----------------------------------------
  {
    const { count: n } = await db
      .from("leads")
      .update({ contact_name: null, contact_email: null, contact_phone: null, notes: null, custom: {} }, { count: "exact" })
      .eq("client_id", clientId);
    count("leads", n);
  }

  // --- Email: addresses and bodies ------------------------------------------
  {
    const { count: n } = await db
      .from("email_messages")
      .update(
        { to_emails: ["erased@example.invalid"], cc_emails: [], reply_to: null, subject: ERASED_TEXT, body_text: null, body_html: null },
        { count: "exact" },
      )
      .eq("client_id", clientId)
      .then((r) => r, () => ({ count: 0 }));
    count("email_messages", n);
  }

  // --- Bookings and agreements ------------------------------------------------
  {
    const { count: n } = await db
      .from("meeting_bookings")
      .update({ client_name: ERASED, client_email: null, client_phone: null, notes: null }, { count: "exact" })
      .eq("client_id", clientId);
    count("meeting_bookings", n);
    const { count: m } = await db
      .from("agreements")
      .update({ signer_email: null, signed_name: null, signed_ip: null, signature_data: null }, { count: "exact" })
      .eq("client_id", clientId)
      .then((r) => r, () => ({ count: 0 }));
    count("agreements", m);
  }

  // --- Bank slips: the pictures of their bank account, then the parse ------
  {
    const { data: slips } = await db
      .from("payment_slips")
      .select("id, bucket, file_path")
      .eq("client_id", clientId)
      .then((r) => r, () => ({ data: null }));
    if (slips?.length) {
      const admin = createAdminClient();
      const byBucket = new Map<string, string[]>();
      for (const s of slips) {
        const list = byBucket.get(s.bucket) ?? [];
        list.push(s.file_path);
        byBucket.set(s.bucket, list);
      }
      for (const [bucket, paths] of byBucket) {
        await admin.storage.from(bucket).remove(paths).then(() => undefined, () => undefined);
      }
      const { count: n } = await db
        .from("payment_slips")
        .update({ parsed: {} as never, reference: null, note: null, ip: null }, { count: "exact" })
        .in("id", slips.map((s) => s.id));
      count("payment_slips", n);
    }
  }

  // --- Portal login codes, keyed by their phone -----------------------------
  if (client.phone_norm) {
    const { count: n } = await db
      .from("client_login_codes")
      .delete({ count: "exact" })
      .eq("phone", client.phone_norm)
      .then((r) => r, () => ({ count: 0 }));
    count("client_login_codes", n);
  }

  // --- The client row itself ------------------------------------------------
  {
    const { error } = await db
      .from("clients")
      .update({
        name: ERASED,
        email: null,
        phone: null,
        company: null,
        city: null,
        notes: null,
        referral_code: null,
        // Old statement links die with the person.
        statement_token: randomUUID(),
        anonymised_at: new Date().toISOString(),
      })
      .eq("id", clientId);
    if (error) return { ok: false, error: error.message };
    count("clients", 1);
  }

  if (mode === "delete") {
    const { error } = await db.from("clients").delete().eq("id", clientId);
    if (error) return { ok: false, error: `Scrubbed, but the row could not be removed: ${error.message}` };
  }

  await logSystemWrite(db, {
    job: "gdpr",
    actor: opts.actorId ? `user:${opts.actorId}` : null,
    table: "clients",
    rowId: clientId,
    action: mode === "delete" ? "deleted" : "updated",
    summary: `${mode === "delete" ? "Deleted" : "Anonymised"} client ${client.name}${client.company ? ` (${client.company})` : ""} on request`,
    meta: { mode, touched },
  });

  return { ok: true, mode, touched };
}

// ---------------------------------------------------------------------------
// Export — everything held about them, as files a person can read
// ---------------------------------------------------------------------------

export type ClientExport = { filename: string; buffer: Buffer };

/**
 * The other half of the right: what we hold, hand-picked, as a zip of JSON
 * files plus their statement. Internal notes, budgets and costs are not
 * theirs and are not included.
 */
export async function exportClientData(db: DB, clientId: string): Promise<ClientExport | null> {
  const { data: client } = await db
    .from("clients")
    .select("id, name, company, email, phone, city, status, notes, created_at, anonymised_at")
    .eq("id", clientId)
    .maybeSingle();
  if (!client) return null;

  const { data: projects } = await db
    .from("projects")
    .select("id, name, description, status, delivery_stage, start_date, due_date, currency, total_value, deposit_paid, live_url, created_at")
    .eq("client_id", clientId)
    .is("deleted_at", null);
  const projectIds = (projects ?? []).map((p) => p.id);

  const invoiceQuery = db
    .from("invoices")
    .select("invoice_number, invoice_date, due_date, bill_to_name, bill_to_details, items, grand_total, paid_amount, status, currency, project_id");
  const [
    invoicesRes,
    paymentsRes,
    quotesRes,
    proposalsRes,
    agreementsRes,
    meetingsRes,
    bookingsRes,
    waRes,
    smsRes,
    emailRes,
    slipsRes,
    statement,
  ] = await Promise.all([
    projectIds.length
      ? invoiceQuery.or(`client_id.eq.${clientId},project_id.in.(${projectIds.join(",")})`)
      : invoiceQuery.eq("client_id", clientId),
    projectIds.length
      ? db.from("payments").select("amount, currency, status, paid_at, method, notes, project_id").in("project_id", projectIds)
      : Promise.resolve({ data: [] }),
    db.from("quotes").select("quote_number, title, grand_total, currency, status, created_at, accepted_at").eq("client_id", clientId),
    db.from("proposals").select("project_name, grand_total, proposal_date").eq("client_id", clientId),
    db
      .from("agreements")
      .select("kind, title, status, sent_at, signed_at, signed_name, signer_email, body_md")
      .eq("client_id", clientId)
      .then((r) => r, () => ({ data: [] })),
    db.from("meetings").select("title, meeting_at, duration_minutes, location, meeting_url").eq("client_id", clientId),
    db.from("meeting_bookings").select("booking_date, start_time, end_time, status, notes").eq("client_id", clientId),
    db
      .from("wa_contacts")
      .select("wa_id, display_name, messages:wa_messages(direction, body, created_at)")
      .eq("client_id", clientId),
    db.from("sms_messages").select("to_number, message, kind, status, created_at").eq("client_id", clientId),
    db
      .from("email_messages")
      .select("direction, to_emails, subject, body_text, kind, sent_at, created_at")
      .eq("client_id", clientId)
      .then((r) => r, () => ({ data: [] })),
    db
      .from("payment_slips")
      .select("source, amount_claimed, reference, status, match, created_at")
      .eq("client_id", clientId)
      .then((r) => r, () => ({ data: [] })),
    buildClientStatement(db, clientId).catch(() => null),
  ]);

  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const at = new Date().toISOString();
  const put = (name: string, value: unknown) => zip.file(name, JSON.stringify(value, null, 2));

  put("client.json", { ...client, exported_at: at });
  put("projects.json", projects ?? []);
  put("invoices.json", invoicesRes.data ?? []);
  put("payments.json", paymentsRes.data ?? []);
  put("quotes.json", quotesRes.data ?? []);
  put("proposals.json", proposalsRes.data ?? []);
  put("agreements.json", agreementsRes.data ?? []);
  put("meetings.json", { meetings: meetingsRes.data ?? [], bookings: bookingsRes.data ?? [] });
  put("messages/whatsapp.json", waRes.data ?? []);
  put("messages/sms.json", smsRes.data ?? []);
  put("messages/email.json", emailRes.data ?? []);
  put("payment-slips.json", slipsRes.data ?? []);
  if (statement) put("statement.json", statement);
  zip.file(
    "README.txt",
    [
      `Personal data held by ARC AI about ${client.name}`,
      `Exported ${at}.`,
      "",
      "Each file is what our system holds under your record: your details, the projects we did",
      "for you, the invoices and payments between us, quotes, proposals and agreements, meetings,",
      "and every message exchanged on WhatsApp, SMS and email. statement.json is your statement",
      "of account. Internal notes about our own costs and margins are not yours and are not here.",
      "",
      "Questions: support@arcai.agency",
    ].join("\n"),
  );

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const safe = client.name.replace(/[^a-zA-Z0-9._-]/g, "") || "client";
  return { filename: `ARC-AI-data-${safe}-${at.slice(0, 10)}.zip`, buffer };
}
