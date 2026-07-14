"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import { cleanNoticeBody } from "@/lib/notice";
import { draftNotice, isNoticeAIConfigured } from "@/lib/ai/notice";
import { sendNoticeEmail } from "@/lib/email";

export type SaveNoticeInput = {
  notice_number: string;
  notice_date: string; // ISO YYYY-MM-DD
  to_name: string;
  to_details: string;
  subject: string;
  body: string;
  source_input: string;
};

export async function saveNotice(
  input: SaveNoticeInput,
): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!input.notice_number?.trim()) {
    return { ok: false, error: "Notice number is required." };
  }
  if (!input.notice_date) {
    return { ok: false, error: "Notice date is required." };
  }
  if (!input.body?.trim()) {
    return { ok: false, error: "The notice has no message yet." };
  }

  const { data: inserted, error } = await supabase
    .from("notices")
    .insert({
      notice_number: input.notice_number.trim(),
      notice_date: input.notice_date,
      to_name: input.to_name.trim(),
      to_details: input.to_details,
      subject: input.subject.trim(),
      body: input.body,
      source_input: input.source_input,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/notices");
  return { ok: true, id: inserted.id };
}

export async function deleteNotice(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase.from("notices").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/notices");
  return { ok: true };
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Email a notice as a PDF attachment. `notice` carries the exact document to
 * send (so what's on screen is what goes out), and `id` — when the notice is
 * already saved — gets stamped with who it went to. Only ever called from the
 * send dialog's explicit "Send" click.
 */
export async function sendNotice(input: {
  id?: string;
  notice: Omit<SaveNoticeInput, "source_input">;
  emails: string[];
  message?: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const emails = (input.emails ?? [])
    .map((e) => String(e).trim())
    .filter((e) => isEmail(e));
  if (!emails.length) {
    return { ok: false, error: "Enter a valid email address to send to." };
  }
  if (!input.notice?.body?.trim()) {
    return { ok: false, error: "The notice has no message yet." };
  }

  const result = await sendNoticeEmail({
    to: emails,
    message: input.message?.trim() || undefined,
    notice: {
      notice_number: input.notice.notice_number,
      notice_date: input.notice.notice_date,
      to_name: input.notice.to_name,
      to_details: input.notice.to_details,
      subject: input.notice.subject,
      body: input.notice.body,
    },
  });

  if (!result.sent) {
    return { ok: false, error: result.error || "The email failed to send." };
  }

  // Best-effort audit stamp — the email has already gone, so a failure here
  // must not read as a failed send.
  if (input.id) {
    try {
      await supabase
        .from("notices")
        .update({
          recipient_email: emails.join(", "),
          sent_at: new Date().toISOString(),
        })
        .eq("id", input.id);
    } catch {
      // ignore — stamping is non-critical
    }
  }

  revalidatePath("/notices");
  return { ok: true };
}

export type DraftNoticeResult =
  | { ok: true; subject: string; body: string }
  | { ok: false; error: string };

/**
 * Turn the user's dictated/typed reason into the formal notice body. On any
 * failure the caller keeps whatever is already in the box, so a bad AI day
 * costs a rewrite by hand rather than the whole notice.
 */
export async function generateNoticeBody(input: {
  rawInput: string;
  toName?: string;
  subject?: string;
}): Promise<DraftNoticeResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!input.rawInput?.trim()) {
    return { ok: false, error: "Say or type what the notice is about first." };
  }
  if (!isNoticeAIConfigured()) {
    return {
      ok: false,
      error: "AI writing isn't configured. Add OPENAI_API_KEY.",
    };
  }

  try {
    const drafted = await draftNotice({
      rawInput: input.rawInput,
      toName: input.toName,
      subject: input.subject,
    });
    return { ok: true, subject: drafted.subject, body: drafted.body };
  } catch (error) {
    console.error("Notice draft error:", error);
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Couldn't write the notice. Try again.",
    };
  }
}

/**
 * Polish a body the user has already got in front of them — the "make this
 * more professional" pass on hand-edited text, as opposed to a fresh draft
 * from raw notes.
 */
export async function refineNoticeBody(input: {
  body: string;
  toName?: string;
  subject?: string;
}): Promise<DraftNoticeResult> {
  return generateNoticeBody({
    rawInput: cleanNoticeBody(input.body),
    toName: input.toName,
    subject: input.subject,
  });
}
