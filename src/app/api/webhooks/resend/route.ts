import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { suppressEmail } from "@/lib/lead-outreach";

export const runtime = "nodejs";

/**
 * Resend webhook — flags a contact when an email we sent bounces or is marked
 * as spam, so the team knows to get a valid address before the next quote.
 *
 * Resend signs webhooks with Svix: headers svix-id / svix-timestamp /
 * svix-signature, HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed by the
 * base64 secret (RESEND_WEBHOOK_SECRET, "whsec_…" from the Resend dashboard).
 * Verified inline, mirroring verifyWaSignature in src/lib/whatsapp.ts.
 */

const TOLERANCE_MS = 5 * 60 * 1000; // reject stale timestamps (replay guard)

function verifySignature(rawBody: string, headers: Headers): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return false; // no secret configured → reject (fail closed)

  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;

  const tsMs = Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TOLERANCE_MS) {
    return false;
  }

  try {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = createHmac("sha256", key)
      .update(`${id}.${ts}.${rawBody}`)
      .digest("base64");
    const expectedBuf = Buffer.from(expected);
    // Header is space-separated "v1,<sig>" pairs — any match passes.
    for (const part of sigHeader.split(" ")) {
      const sig = part.split(",")[1];
      if (!sig) continue;
      const given = Buffer.from(sig);
      if (given.length === expectedBuf.length && timingSafeEqual(given, expectedBuf)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function recipientsOf(data: Record<string, unknown>): string[] {
  const to = data.to;
  const arr = Array.isArray(to) ? to : to ? [to] : [];
  return arr.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const type = String(event.type ?? "");
  const providerId = String(
    (event.data as Record<string, unknown> | undefined)?.email_id ?? "",
  ).trim();

  // 0117 — the positive signals. They aren't alerts and nobody needs telling;
  // they just make the email log truthful about what happened after the send,
  // which is what "did they even open it?" is asked from.
  if (
    type === "email.delivered" ||
    type === "email.opened" ||
    type === "email.clicked"
  ) {
    if (providerId) {
      try {
        await recordEngagement(providerId, type);
      } catch (e) {
        console.error("[resend-webhook] engagement update failed:", e);
      }
    }
    return NextResponse.json({ ok: true });
  }

  // Only care about hard-negative signals beyond that; ack everything else so
  // Resend stops retrying.
  if (type !== "email.bounced" && type !== "email.complained") {
    return NextResponse.json({ ok: true, ignored: type || "unknown" });
  }

  const recipients = recipientsOf(event.data ?? {});
  if (recipients.length === 0) return NextResponse.json({ ok: true, note: "no recipient" });

  const label =
    type === "email.complained"
      ? "marked our email as spam"
      : "bounced (undeliverable)";

  try {
    const supabase = createAdminClient();
    const { data: profiles } = await supabase.from("profiles").select("id");

    // 0115 — mark the send itself. Resend's `email_id` is the message id
    // sendAndLogEmail() stored as provider_id, so this is an exact join
    // rather than the address guess the rest of this handler has to make.
    if (providerId) {
      const now = new Date().toISOString();
      await supabase
        .from("email_messages")
        .update({
          status: type === "email.complained" ? "complained" : "bounced",
          bounced_at: now,
          error: `Recipient ${label}.`,
        })
        .eq("provider_id", providerId);
    }

    for (const email of recipients) {
      // Never cold-email a bounced/complained address again.
      await suppressEmail(
        supabase,
        email,
        type === "email.complained" ? "complaint" : "bounce",
      );

      // Leave a trace on any matching CRM lead(s).
      const { data: leads } = await supabase
        .from("leads")
        .select("id")
        .ilike("contact_email", email)
        .order("created_at", { ascending: false })
        .limit(5);

      let link = "/crm";
      if (leads && leads.length > 0) {
        link = `/crm/lead/${leads[0].id}`;
        for (const lead of leads) {
          await supabase.from("lead_activities").insert({
            lead_id: lead.id,
            kind: "note",
            title: "✉️ Email bounced",
            body: `Our email to ${email} ${label}. Get a valid email before sending quotes or invoices.`,
            actor_id: null,
          });
        }
      }

      // Alert the whole team.
      const rows = (profiles ?? []).map((p) => ({
        user_id: p.id,
        type: "system" as const,
        title: "Email bounced",
        body: `${email} ${label} — the contact needs a valid email.`,
        link,
      }));
      if (rows.length > 0) await supabase.from("notifications").insert(rows);
    }
  } catch (e) {
    // Best-effort alerting — don't make Resend retry forever on our own error.
    console.error("[resend-webhook] handling failed:", e);
  }

  return NextResponse.json({ ok: true });
}

/**
 * Stamp a delivery, an open or a click onto the send it belongs to.
 *
 * Counts rather than flags: "opened 4 times" is a different signal from
 * "opened", and the first timestamp is the one worth keeping, so a later open
 * never overwrites it.
 */
async function recordEngagement(
  providerId: string,
  type: "email.delivered" | "email.opened" | "email.clicked",
): Promise<void> {
  const supabase = createAdminClient();
  const { data: row } = await supabase
    .from("email_messages")
    .select("id, status, opened_at, open_count, clicked_at, click_count, lead_id, subject")
    .eq("provider_id", providerId)
    .maybeSingle();
  if (!row) return;

  const now = new Date().toISOString();

  // 0117 — the FIRST open or click of an outreach email is a fact worth a
  // line on the lead's timeline; the fifth is not. Best-effort: the count on
  // the message is the record, the activity is the headline.
  const noteOnLead = async (title: string) => {
    if (!row.lead_id) return;
    await supabase
      .from("lead_activities")
      .insert({ lead_id: row.lead_id, kind: "email", title, actor_id: null })
      .then(() => undefined, () => undefined);
  };

  if (type === "email.delivered") {
    await supabase
      .from("email_messages")
      .update({
        // A bounce can arrive after a delivery event; never walk that back.
        status: row.status === "sent" ? "delivered" : row.status,
        delivered_at: now,
      })
      .eq("id", row.id);
    return;
  }

  if (type === "email.opened") {
    await supabase
      .from("email_messages")
      .update({
        opened_at: row.opened_at ?? now,
        open_count: (row.open_count ?? 0) + 1,
      })
      .eq("id", row.id);
    if (!row.opened_at) await noteOnLead(`Opened: ${row.subject || "our email"}`);
    return;
  }

  await supabase
    .from("email_messages")
    .update({
      // A click implies an open, even if the open pixel was blocked.
      opened_at: row.opened_at ?? now,
      clicked_at: row.clicked_at ?? now,
      click_count: (row.click_count ?? 0) + 1,
    })
    .eq("id", row.id);
  if (!row.clicked_at) await noteOnLead(`Clicked a link in: ${row.subject || "our email"}`);
}
