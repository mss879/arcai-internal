"use server";

import { revalidatePath } from "next/cache";

import { parseThreadKey } from "@/lib/inbox";
import { notifyUsers } from "@/lib/notify";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import { sendWaMessageAction } from "@/app/(app)/whatsapp/actions";
import { sendSmsAction } from "@/app/(app)/sms/actions";
import { postTeamComment } from "@/app/(app)/projects/cx-actions";

/**
 * The inbox's own writes: ownership, tags, notes, snooze, and one reply entry
 * point that dispatches to whichever channel the thread is on.
 *
 * Replying deliberately delegates to the actions each channel already had,
 * rather than talking to Meta or Notify.lk here. Those carry rules the inbox
 * must not lose — a team WhatsApp send pauses the AI for that thread, an SMS
 * always writes its log row even when it fails, a portal comment resolves the
 * author's name. Reimplementing any of that here is how they drift apart.
 */

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** Create or update the conversation_meta row for a thread. */
async function upsertMeta(
  key: string,
  patch: Record<string, unknown>,
): Promise<ActionResult> {
  const parsed = parseThreadKey(key);
  if (!parsed) return { ok: false, error: "That conversation doesn't exist." };

  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("conversation_meta")
    .upsert(
      { channel: parsed.channel, ref_id: parsed.refId, ...patch },
      { onConflict: "channel,ref_id" },
    );
  if (error) return { ok: false, error: error.message };

  revalidatePath("/inbox");
  return { ok: true };
}

/**
 * Give a conversation an owner, and tell them.
 *
 * This is the point of the inbox: a thread with a name on it is a thread
 * somebody is actually going to answer.
 */
export async function assignThread(
  key: string,
  userId: string | null,
): Promise<ActionResult> {
  const res = await upsertMeta(key, {
    assigned_to: userId,
    assigned_at: userId ? new Date().toISOString() : null,
  });
  if (!res.ok) return res;

  if (userId) {
    const { supabase, user } = await authed();
    if (user && userId !== user.id) {
      await notifyUsers(supabase, {
        userIds: [userId],
        type: "inbox",
        title: "A conversation is yours",
        body: "You've been assigned a conversation in the inbox.",
        link: `/inbox?thread=${encodeURIComponent(key)}`,
        actorId: user.id,
      });
    }
  }
  return res;
}

export async function setThreadTags(key: string, tags: string[]): Promise<ActionResult> {
  const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 12);
  return upsertMeta(key, { tags: clean });
}

export async function setThreadNotes(key: string, notes: string): Promise<ActionResult> {
  return upsertMeta(key, { notes: notes.trim() || null });
}

/**
 * Hide a thread until a date. Nothing is deleted and nothing is marked done —
 * a snoozed thread reappears on its own, which is the only honest way to say
 * "not now" about someone else's message.
 */
export async function snoozeThread(
  key: string,
  until: string | null,
): Promise<ActionResult> {
  return upsertMeta(key, { snoozed_until: until });
}

/** Stamp when this thread was last looked at. */
export async function markThreadRead(key: string): Promise<ActionResult> {
  const parsed = parseThreadKey(key);
  if (!parsed) return { ok: false, error: "That conversation doesn't exist." };

  const res = await upsertMeta(key, { last_read_at: new Date().toISOString() });

  // WhatsApp keeps its own unread counter on the contact row, and /whatsapp
  // reads it too — clear it there as well so the two screens agree.
  if (parsed.channel === "whatsapp") {
    const { supabase, user } = await authed();
    if (user) {
      await supabase
        .from("wa_contacts")
        .update({ unread: 0, needs_attention: false })
        .eq("id", parsed.refId);
      revalidatePath("/whatsapp");
    }
  }
  return res;
}

/**
 * Reply on whatever channel the thread is on.
 *
 * Email is not repliable from here: there is no inbound mailbox, so a reply
 * would be a new outbound message with no thread to attach to. Compose is the
 * honest verb for that, and it lives elsewhere.
 */
export async function replyToThread(
  key: string,
  body: string,
): Promise<ActionResult> {
  const parsed = parseThreadKey(key);
  if (!parsed) return { ok: false, error: "That conversation doesn't exist." };

  const text = body.trim();
  if (!text) return { ok: false, error: "Write something first." };

  let res: ActionResult;
  switch (parsed.channel) {
    case "whatsapp":
      res = await sendWaMessageAction(parsed.refId, text);
      break;
    case "sms": {
      const { supabase } = await authed();
      // Carry the client through so the text lands on their record, the same
      // way the SMS screen does it.
      const { data: last } = await supabase
        .from("sms_messages")
        .select("client_id, client_name")
        .eq("to_number", parsed.refId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      res = await sendSmsAction({
        phone: parsed.refId,
        message: text,
        clientId: last?.client_id ?? null,
        clientName: last?.client_name ?? undefined,
      });
      break;
    }
    case "portal":
      res = await postTeamComment(parsed.refId, text);
      break;
    case "email":
      return {
        ok: false,
        error: "Email replies aren't sent from here — use Compose.",
      };
  }

  if (res.ok) revalidatePath("/inbox");
  return res;
}
