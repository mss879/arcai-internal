import { NextResponse } from "next/server";

import type { Database, WaMessageStatus } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleInboundWaMessage } from "@/lib/wa-agent";
import { markWhatsAppRead, verifyWaSignature, whatsAppVerifyToken } from "@/lib/whatsapp";

/**
 * Meta WhatsApp Business Cloud API webhook.
 *
 * Point the webhook at  https://<your-domain>/api/whatsapp/webhook  in the
 * Meta App Dashboard (WhatsApp → Configuration), subscribe to the
 * `messages` field, and use WHATSAPP_VERIFY_TOKEN as the verify token.
 *
 *   GET   the one-time subscription handshake (hub.challenge echo)
 *   POST  inbound messages + delivery statuses. Each message is stored,
 *         deduped (Meta retries!), run through keyword rules, fired into
 *         the automation engine and finally answered by the AI agent.
 *
 * Always answers 200 — a thrown error would make Meta retry forever and
 * eventually disable the webhook.
 */

type WaWebhookMessage = {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
};

type WaWebhookValue = {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: WaWebhookMessage[];
  statuses?: {
    id?: string;
    status?: string;
    errors?: { title?: string; message?: string }[];
  }[];
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (mode === "subscribe" && token && token === whatsAppVerifyToken()) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: "Verification failed." }, { status: 403 });
}

export async function POST(request: Request) {
  const raw = await request.text();

  if (!verifyWaSignature(raw, request.headers.get("x-hub-signature-256"))) {
    // Signed apps only: reject forgeries outright.
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  let payload: { entry?: { changes?: { value?: WaWebhookValue }[] }[] };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    const supabase = createAdminClient();
    const ownNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;
        // Multi-number safety: ignore events for numbers we don't manage.
        if (
          ownNumberId &&
          value.metadata?.phone_number_id &&
          value.metadata.phone_number_id !== ownNumberId
        ) {
          continue;
        }

        await handleStatuses(supabase, value);
        await handleMessages(supabase, value);
      }
    }
  } catch (e) {
    console.error("[whatsapp] webhook processing failed:", e);
  }

  return NextResponse.json({ ok: true });
}

type DB = ReturnType<typeof createAdminClient>;

async function handleStatuses(supabase: DB, value: WaWebhookValue): Promise<void> {
  for (const status of value.statuses ?? []) {
    if (!status.id || !status.status) continue;
    const mapped: WaMessageStatus | null =
      status.status === "sent"
        ? "sent"
        : status.status === "delivered"
          ? "delivered"
          : status.status === "read"
            ? "read"
            : status.status === "failed"
              ? "failed"
              : null;
    if (!mapped) continue;

    const patch: Database["public"]["Tables"]["wa_messages"]["Update"] = {
      status: mapped,
    };
    if (mapped === "failed") {
      patch.error =
        status.errors?.[0]?.message || status.errors?.[0]?.title || "Delivery failed.";
    }

    let query = supabase.from("wa_messages").update(patch).eq("wa_message_id", status.id);
    // Never downgrade read → delivered when statuses arrive out of order.
    if (mapped === "delivered") query = query.in("status", ["sent", "delivered"]);
    await query;
  }
}

async function handleMessages(supabase: DB, value: WaWebhookValue): Promise<void> {
  for (const message of value.messages ?? []) {
    const waId = (message.from ?? "").replace(/[^\d]/g, "");
    if (!waId) continue;

    const profileName =
      value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name ?? null;

    const body = extractBody(message);
    const now = new Date().toISOString();

    // Find-or-create the contact.
    let { data: contact } = await supabase
      .from("wa_contacts")
      .select("*")
      .eq("wa_id", waId)
      .maybeSingle();
    if (!contact) {
      const { data: created } = await supabase
        .from("wa_contacts")
        .upsert({ wa_id: waId, profile_name: profileName }, { onConflict: "wa_id" })
        .select("*")
        .single();
      contact = created;
    }
    if (!contact) continue;

    // Store the message; the unique wa_message_id dedupes Meta's retries.
    const { data: stored } = await supabase
      .from("wa_messages")
      .upsert(
        {
          contact_id: contact.id,
          wa_message_id: message.id ?? null,
          direction: "in",
          message_type: message.type ?? "text",
          body,
          status: "received",
        },
        { onConflict: "wa_message_id", ignoreDuplicates: true },
      )
      .select("id");
    // Already processed this exact message on a previous delivery attempt.
    if (message.id && (stored ?? []).length === 0) continue;

    await supabase
      .from("wa_contacts")
      .update({
        profile_name: profileName ?? contact.profile_name,
        unread: (contact.unread ?? 0) + 1,
        last_message_at: now,
        last_inbound_at: now,
        last_message_preview: body.slice(0, 160),
        last_direction: "in",
      })
      .eq("id", contact.id);
    contact.profile_name = profileName ?? contact.profile_name;
    contact.last_inbound_at = now;

    if (message.id) void markWhatsAppRead(message.id);

    // Only text-like content goes to the rules + agent.
    const textual = ["text", "button", "interactive"].includes(message.type ?? "text");
    if (body && textual) {
      await handleInboundWaMessage(supabase, contact, body, message.id ?? null);
    }
  }
}

function extractBody(message: WaWebhookMessage): string {
  if (message.type === "text") return (message.text?.body ?? "").trim();
  if (message.type === "button") return (message.button?.text ?? "").trim();
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      ""
    ).trim();
  }
  return `[${message.type ?? "unsupported"} message]`;
}
