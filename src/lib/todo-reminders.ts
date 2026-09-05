import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { appLink } from "@/lib/app-url";
import { catchUpOccurrence } from "@/lib/todo-recurrence";
import type { Database } from "@/lib/database.types";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { countSmsSegments, normalizePhone } from "@/lib/sms-utils";

type DB = SupabaseClient<Database>;

/** How long before a task's due date the reminder goes out. */
const REMINDER_HOURS = 5;

/** Notify.lk is Sri Lankan; due times are texted in local time. */
const TIME_ZONE = "Asia/Colombo";

export type TodoReminderResult = {
  todo_reminders: number;
  sms_sent: number;
};

function formatDueTime(iso: string): string {
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

function remainingLabel(dueMs: number, nowMs: number): string {
  const mins = Math.max(1, Math.round((dueMs - nowMs) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h} hours`;
}

/**
 * Built-in task deadline reminders, run from the automation tick:
 * once a task's due date is less than REMINDER_HOURS away, the
 * assignee and the creator each get an in-app notification, a push
 * and an SMS (sent with the ARC AI mask, logged to sms_messages).
 *
 * `todos.reminder_sent_at` guarantees the reminder fires exactly
 * once per deadline; saving a task with a new due date clears the
 * flag (see todos/actions.ts) so the reminder re-arms. Tasks whose
 * deadline already passed are skipped — the reminder is only useful
 * before the deadline, and the board shows overdue state anyway.
 */
export async function processTodoReminders(supabase: DB): Promise<TodoReminderResult> {
  const result: TodoReminderResult = { todo_reminders: 0, sms_sent: 0 };

  // 0119 — the safety net under recurring to-dos. A series normally advances
  // when somebody ticks the last one off; this catches the ones nobody ever
  // did, so a weekly job doesn't silently stop existing because it was
  // skipped once.
  await respawnMissedOccurrences(supabase).catch((e) => {
    console.error("[todos] respawning recurrences failed:", e);
  });

  const now = Date.now();
  const windowEnd = new Date(now + REMINDER_HOURS * 3600_000).toISOString();

  const { data: due } = await supabase
    .from("todos")
    .select("id, title, due_date, assigned_to, created_by")
    .neq("status", "done")
    .is("reminder_sent_at", null)
    .gt("due_date", new Date(now).toISOString())
    .lte("due_date", windowEnd)
    .limit(100);
  if (!due?.length) return result;

  // One profile lookup for every assignee/creator in this batch.
  const recipientIds = [
    ...new Set(due.flatMap((t) => [t.assigned_to, t.created_by]).filter((id): id is string => !!id)),
  ];
  const { data: profiles } = recipientIds.length
    ? await supabase.from("profiles").select("id, full_name, phone").in("id", recipientIds)
    : { data: [] };
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

  const smsReady = isSmsConfigured();
  // App link so the recipient can open the board straight from the text.
  const appUrl = appLink("/todos");

  for (const todo of due) {
    if (!todo.due_date) continue;

    const dueMs = new Date(todo.due_date).getTime();
    const remaining = remainingLabel(dueMs, Date.now());
    const when = formatDueTime(todo.due_date);
    // Keep the SMS GSM-7 friendly (no smart punctuation) and short.
    const shortTitle =
      todo.title.length > 60 ? `${todo.title.slice(0, 57)}...` : todo.title;
    const smsMessage = `ARC AI: Task reminder - "${shortTitle}" is due in ${remaining} (${when}). ${appUrl ? `Open: ${appUrl}` : "Check the To-Dos board."}`;
    const notifTitle = `Task due in ${remaining}`;

    const recipients = [
      ...new Set([todo.assigned_to, todo.created_by].filter((id): id is string => !!id)),
    ];

    {
      const { notifyUsers } = await import("@/lib/notify");
      await notifyUsers(supabase, {
        userIds: recipients,
        title: notifTitle,
        body: `"${todo.title}" is due ${when}.`,
        link: "/todos",
      });
    }
    for (const userId of recipients) {
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
        kind: "todo_reminder",
        status: sent.ok ? "sent" : "failed",
        error: sent.ok ? null : sent.error,
        segments: countSmsSegments(smsMessage),
        created_by: null,
      });
      if (sent.ok) result.sms_sent++;
    }

    // Mark dispatched even if a channel failed — the in-app notification
    // landed, and retrying every tick would spam the recipients.
    await supabase
      .from("todos")
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq("id", todo.id);
    result.todo_reminders++;
  }

  return result;
}

/**
 * Bring overdue recurring to-dos forward.
 *
 * Only ones that were never finished AND are already past due: a series is
 * meant to advance on completion, and this is the fallback for when it
 * didn't. Exactly one new occurrence per series — catchUpOccurrence skips
 * every missed date and returns the next real one, so a month of neglect
 * produces one task rather than four.
 */
async function respawnMissedOccurrences(supabase: DB): Promise<number> {
  const now = new Date();

  const { data: stale } = await supabase
    .from("todos")
    .select(
      "id, title, description, priority, due_date, assigned_to, project_id, labels, estimate_minutes, recurrence, recurrence_parent_id, created_by",
    )
    .neq("status", "done")
    .not("recurrence", "is", null)
    .lt("due_date", now.toISOString())
    .limit(50);
  if (!stale?.length) return 0;

  let created = 0;
  for (const todo of stale) {
    const next = catchUpOccurrence(todo.recurrence, todo.due_date!, now);
    if (!next) continue;

    // Don't stack: if the series already has a future occurrence, this one is
    // just late, not lost.
    const seriesId = todo.recurrence_parent_id ?? todo.id;
    const { count } = await supabase
      .from("todos")
      .select("id", { count: "exact", head: true })
      .or(`id.eq.${seriesId},recurrence_parent_id.eq.${seriesId}`)
      .neq("status", "done")
      .gte("due_date", now.toISOString());
    if ((count ?? 0) > 0) continue;

    const { error } = await supabase.from("todos").insert({
      title: todo.title,
      description: todo.description,
      priority: todo.priority,
      status: "todo" as const,
      due_date: next,
      assigned_to: todo.assigned_to,
      project_id: todo.project_id,
      labels: todo.labels,
      estimate_minutes: todo.estimate_minutes,
      recurrence: todo.recurrence,
      recurrence_parent_id: seriesId,
      created_by: todo.created_by,
    });
    if (!error) created += 1;
  }
  return created;
}
