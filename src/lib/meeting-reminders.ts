import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { appLink } from "@/lib/app-url";
import type { Database } from "@/lib/database.types";
import { sendPushToUser } from "@/lib/push";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { countSmsSegments, normalizePhone } from "@/lib/sms-utils";

type DB = SupabaseClient<Database>;

/** How long before a meeting starts the reminder goes out. */
const REMINDER_HOURS = 3;

/** Notify.lk is Sri Lankan; start times are texted in local time. */
const TIME_ZONE = "Asia/Colombo";

export type MeetingReminderResult = {
  meeting_reminders: number;
  sms_sent: number;
};

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

function remainingLabel(startMs: number, nowMs: number): string {
  const mins = Math.max(1, Math.round((startMs - nowMs) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h} hours`;
}

type MeetingRow = {
  id: string;
  title: string;
  meeting_at: string;
  location_type: "online" | "in_person";
  location: string | null;
  meeting_url: string | null;
  attendees: { user_id: string }[] | null;
};

/**
 * Built-in meeting reminders, run from the automation tick: once a meeting
 * is less than REMINDER_HOURS away, every assigned attendee gets an in-app
 * notification, a push and an SMS. For ONLINE meetings the SMS carries the
 * join link; for in-person ones it carries the venue instead.
 *
 * `meetings.reminder_sent_at` guarantees the reminder fires exactly once;
 * changing the start time clears it (see meetings/scheduled-actions.ts) so
 * the reminder re-arms. Meetings whose start already passed are skipped.
 */
export async function processMeetingReminders(
  supabase: DB,
): Promise<MeetingReminderResult> {
  const result: MeetingReminderResult = { meeting_reminders: 0, sms_sent: 0 };

  const now = Date.now();
  const windowEnd = new Date(now + REMINDER_HOURS * 3600_000).toISOString();

  const { data: due } = await supabase
    .from("meetings")
    .select(
      "id, title, meeting_at, location_type, location, meeting_url, attendees:meeting_attendees(user_id)",
    )
    .is("reminder_sent_at", null)
    .gt("meeting_at", new Date(now).toISOString())
    .lte("meeting_at", windowEnd)
    .limit(100);
  const meetings = (due ?? []) as unknown as MeetingRow[];
  if (!meetings.length) return result;

  // One profile lookup for every attendee across the batch.
  const attendeeIds = [
    ...new Set(
      meetings.flatMap((m) => (m.attendees ?? []).map((a) => a.user_id)),
    ),
  ];
  const { data: profiles } = attendeeIds.length
    ? await supabase
        .from("profiles")
        .select("id, full_name, phone")
        .in("id", attendeeIds)
    : { data: [] };
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

  const smsReady = isSmsConfigured();
  const appUrl = appLink("/dashboard");

  for (const meeting of meetings) {
    const startMs = new Date(meeting.meeting_at).getTime();
    const remaining = remainingLabel(startMs, Date.now());
    const when = formatWhen(meeting.meeting_at);
    const shortTitle =
      meeting.title.length > 50 ? `${meeting.title.slice(0, 47)}...` : meeting.title;

    // Online → text the join link; in-person → text the venue.
    const detail =
      meeting.location_type === "online"
        ? meeting.meeting_url
          ? `Join: ${meeting.meeting_url}`
          : appUrl
            ? `Open: ${appUrl}`
            : ""
        : meeting.location
          ? `Location: ${meeting.location}`
          : appUrl
            ? `Open: ${appUrl}`
            : "";
    const smsMessage =
      `ARC AI: Meeting reminder - "${shortTitle}" starts in ${remaining} (${when}).` +
      (detail ? ` ${detail}` : "");
    const notifTitle = `Meeting in ${remaining}`;
    const notifBody = `"${meeting.title}" starts ${when}.`;

    const recipients = [
      ...new Set((meeting.attendees ?? []).map((a) => a.user_id)),
    ];

    for (const userId of recipients) {
      await supabase.from("notifications").insert({
        user_id: userId,
        type: "system",
        title: notifTitle,
        body: notifBody,
        link: "/dashboard",
      });
      await sendPushToUser({
        userId,
        title: notifTitle,
        body: notifBody,
        link: "/dashboard",
      });

      const profile = profileById.get(userId);
      if (!smsReady || !profile?.phone) continue;
      const phone = normalizePhone(profile.phone);
      if (!phone.ok) continue;

      const sent = await sendSms({
        to: phone.value,
        message: smsMessage,
        contactName: profile.full_name || undefined,
      });
      await supabase.from("sms_messages").insert({
        to_number: phone.value,
        message: smsMessage,
        client_name: profile.full_name ?? "",
        kind: "meeting_reminder",
        status: sent.ok ? "sent" : "failed",
        error: sent.ok ? null : sent.error,
        segments: countSmsSegments(smsMessage),
        created_by: null,
      });
      if (sent.ok) result.sms_sent++;
    }

    // Mark dispatched even if a channel failed — retrying every tick would
    // spam attendees. The in-app notification already landed.
    await supabase
      .from("meetings")
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq("id", meeting.id);
    result.meeting_reminders++;
  }

  return result;
}
