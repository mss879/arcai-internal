import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { getAssistantProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { sendAndLogWa } from "@/lib/wa-agent";
import { isWhatsAppConfigured } from "@/lib/whatsapp";

export const runtime = "nodejs";

/**
 * Send a WhatsApp message the assistant prepared.
 *
 * Goes through sendAndLogWa with sentBy 'team', which is deliberate: that is
 * what writes the wa_messages row, updates the thread preview AND pauses the
 * agent for this contact. A person has taken over the conversation — the AI
 * replying on top of them is the exact confusion this avoids.
 *
 * Opt-out is re-checked here rather than trusted from the card: the card was
 * built when the model wrote the draft, and somebody may have opted out
 * between then and the tap.
 */
export async function POST(request: Request) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!isWhatsAppConfigured()) {
    return NextResponse.json(
      { ok: false, error: "WhatsApp isn't configured." },
      { status: 400 },
    );
  }

  let body: { contactId?: unknown; message?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const contactId = String(body?.contactId ?? "").trim();
  const message = String(body?.message ?? "").trim();
  if (!contactId || !message) {
    return NextResponse.json(
      { ok: false, error: "Need a conversation and a message." },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data: contact } = await supabase
    .from("wa_contacts")
    .select("id, wa_id, do_not_contact")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json(
      { ok: false, error: "That conversation no longer exists." },
      { status: 404 },
    );
  }
  if (contact.do_not_contact) {
    return NextResponse.json(
      { ok: false, error: "They have opted out of WhatsApp messages." },
      { status: 400 },
    );
  }

  const sent = await sendAndLogWa(supabase, {
    contact: { id: contact.id, wa_id: contact.wa_id },
    body: message,
    sentBy: "team",
    authorId: profile.id,
  });

  revalidatePath("/whatsapp");
  revalidatePath("/inbox");

  if (!sent.ok) {
    return NextResponse.json(
      { ok: false, error: sent.error || "The message failed to send." },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
