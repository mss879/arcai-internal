"use server";

import { revalidatePath } from "next/cache";

import { appLink } from "@/lib/app-url";
import { createClient } from "@/lib/supabase/server";
import { sendPushToUser } from "@/lib/push";
import { sendSmsToUser } from "@/lib/sms-alerts";
import type {
  ActionResult,
  MeetingAttendance,
  MeetingLocationType,
} from "@/lib/types";

export type MeetingInput = {
  id?: string;
  title: string;
  description?: string;
  /** ISO timestamp for the start (client converts the datetime-local). */
  meeting_at: string;
  duration_minutes?: number;
  location_type: MeetingLocationType;
  /** Venue / address — for in-person meetings. */
  location?: string | null;
  /** Join link — for online meetings; texted in the reminder. */
  meeting_url?: string | null;
  /** Workspace member ids assigned to the meeting. */
  attendee_ids: string[];
};

/** Sri Lanka time — Notify.lk is Sri Lankan, so texts read in local time. */
const TIME_ZONE = "Asia/Colombo";

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

/** Make a hand-typed link tappable in an SMS (prepend https:// if bare). */
function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Create or update a scheduled meeting and keep its attendee list in sync.
 *
 * On the first assignment each newly-added attendee (never the actor) gets an
 * instant SMS + push + in-app notification — mirroring how a to-do assignment
 * alerts the assignee (todos/actions.ts). Editing the meeting only alerts
 * people who are *newly* added, so re-saving doesn't re-text everyone.
 *
 * Changing the start time clears reminder_sent_at so the 3-hour reminder
 * (lib/meeting-reminders.ts) re-arms for the new time.
 */
export async function saveMeeting(input: MeetingInput): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const title = input.title?.trim();
  if (!title) return { ok: false, error: "Give the meeting a title." };
  if (!input.meeting_at) return { ok: false, error: "Pick a date and time." };
  if (Number.isNaN(new Date(input.meeting_at).getTime())) {
    return { ok: false, error: "That date and time isn't valid." };
  }

  const online = input.location_type === "online";
  const meetingUrl = online ? normalizeUrl(input.meeting_url ?? "") : null;
  const location = !online ? input.location?.trim() || null : null;
  if (online && !meetingUrl) {
    return { ok: false, error: "Add the online meeting link." };
  }

  const attendeeIds = [...new Set((input.attendee_ids ?? []).filter(Boolean))];

  const payload = {
    title,
    description: input.description?.trim() || null,
    meeting_at: input.meeting_at,
    duration_minutes: input.duration_minutes ?? 60,
    location_type: input.location_type,
    location,
    meeting_url: meetingUrl,
  };

  // Snapshot previous attendees + start time so we only alert NEW people and
  // re-arm the reminder when the time moves.
  let prevAttendees = new Set<string>();
  let prevMeetingAt: string | null = null;
  if (input.id) {
    const [meetingRes, attendeesRes] = await Promise.all([
      supabase.from("meetings").select("meeting_at").eq("id", input.id).maybeSingle(),
      supabase.from("meeting_attendees").select("user_id").eq("meeting_id", input.id),
    ]);
    prevMeetingAt = meetingRes.data?.meeting_at ?? null;
    prevAttendees = new Set((attendeesRes.data ?? []).map((a) => a.user_id));
  }

  let meetingId = input.id;
  if (input.id) {
    const timeChanged =
      (prevMeetingAt ? new Date(prevMeetingAt).getTime() : null) !==
      new Date(payload.meeting_at).getTime();
    const { error } = await supabase
      .from("meetings")
      .update(timeChanged ? { ...payload, reminder_sent_at: null } : payload)
      .eq("id", input.id);
    if (error) return { ok: false, error: error.message };

    // Rescheduled to a new time → wipe everyone's "did you attend?" answers
    // so they're asked again for the new slot.
    if (timeChanged) {
      await supabase
        .from("meeting_attendees")
        .update({ attendance: null, responded_at: null })
        .eq("meeting_id", input.id);
    }
  } else {
    const { data, error } = await supabase
      .from("meetings")
      .insert(payload)
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    meetingId = data.id;
  }
  if (!meetingId) return { ok: false, error: "Could not save the meeting." };

  // --- Sync attendees (remove dropped, add new) --------------------
  const removed = [...prevAttendees].filter((id) => !attendeeIds.includes(id));
  const added = attendeeIds.filter((id) => !prevAttendees.has(id));
  if (removed.length) {
    await supabase
      .from("meeting_attendees")
      .delete()
      .eq("meeting_id", meetingId)
      .in("user_id", removed);
  }
  if (added.length) {
    const { error } = await supabase
      .from("meeting_attendees")
      .insert(added.map((uid) => ({ meeting_id: meetingId!, user_id: uid })));
    if (error) return { ok: false, error: error.message };
  }

  // --- Alert newly-added attendees (never the actor) ---------------
  const notify = added.filter((id) => id !== user.id);
  if (notify.length) {
    const { data: actor } = await supabase
      .from("profiles")
      .select("full_name, username")
      .eq("id", user.id)
      .single();
    const actorName = actor?.full_name || actor?.username || "Someone";
    const when = formatWhen(payload.meeting_at);
    const notifTitle = `${actorName} added you to a meeting`;
    const notifBody = `"${title}" on ${when}.`;

    const smsTail = online
      ? meetingUrl
        ? `Join: ${meetingUrl}`
        : ""
      : location
        ? `Location: ${location}`
        : (appLink("/dashboard") ? `Open: ${appLink("/dashboard")}` : "");
    const smsMessage =
      `ARC AI: ${actorName} scheduled a meeting - "${title}" on ${when}.` +
      (smsTail ? ` ${smsTail}` : "");

    await Promise.all([
      supabase.from("notifications").insert(
        notify.map((uid) => ({
          user_id: uid,
          actor_id: user.id,
          type: "system" as const,
          title: notifTitle,
          body: notifBody,
          link: "/dashboard",
        })),
      ),
      ...notify.map((uid) =>
        sendPushToUser({
          userId: uid,
          title: notifTitle,
          body: notifBody,
          link: "/dashboard",
        }),
      ),
      ...notify.map((uid) => sendSmsToUser({ userId: uid, message: smsMessage })),
    ]);
  }

  revalidatePath("/dashboard");
  revalidatePath("/meetings");
  return { ok: true };
}

/**
 * Record the current user's answer to the post-meeting "did you attend?"
 * prompt. Only touches this user's own attendee row, so each person answers
 * for themselves. Once answered, the meeting stops prompting them.
 */
export async function respondMeetingAttendance(
  meetingId: string,
  attendance: MeetingAttendance,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("meeting_attendees")
    .update({ attendance, responded_at: new Date().toISOString() })
    .eq("meeting_id", meetingId)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteMeeting(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // meeting_attendees rows cascade on delete (see 0042).
  const { error } = await supabase.from("meetings").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard");
  revalidatePath("/meetings");
  return { ok: true };
}
