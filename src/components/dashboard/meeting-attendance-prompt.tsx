"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { CalendarClock, Check, MapPin, Video, X } from "lucide-react";

import { MeetingFormModal } from "@/components/dashboard/meeting-form-modal";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { MemberLite, MeetingWithAttendees } from "@/lib/types";

import { respondMeetingAttendance } from "@/app/(app)/meetings/scheduled-actions";

/**
 * Post-meeting follow-up. Given the meetings the current user was assigned to
 * that have already ended and they haven't answered for, it pops one modal at
 * a time asking "did you attend?" — Attended / Missed / Reschedule. Closing
 * (X) defers the rest to the next login; answering resolves that meeting.
 */
export function MeetingAttendancePrompt({
  meetings,
  members,
}: {
  meetings: MeetingWithAttendees[];
  members: MemberLite[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [resolved, setResolved] = React.useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = React.useState(false);
  const [rescheduleTarget, setRescheduleTarget] =
    React.useState<MeetingWithAttendees | null>(null);

  const queue = meetings.filter((m) => !resolved.has(m.id));
  const current = queue[0] ?? null;

  function resolve(id: string) {
    setResolved((prev) => new Set(prev).add(id));
  }

  function answer(id: string, attendance: "attended" | "missed") {
    startTransition(async () => {
      const res = await respondMeetingAttendance(id, attendance);
      if (res.ok) {
        resolve(id);
        if (queue.length <= 1) router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  // Nothing left to review (or deferred to next login).
  if (dismissed || !current) return null;

  const online = current.location_type === "online";
  const Icon = online ? Video : MapPin;

  return (
    <>
      <Modal
        open={!rescheduleTarget}
        onClose={() => setDismissed(true)}
        title="How did this meeting go?"
        description={
          queue.length > 1
            ? `You have ${queue.length} past meetings to review.`
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setRescheduleTarget(current)}
              disabled={pending}
              className="mr-auto"
            >
              <CalendarClock className="h-4 w-4" /> Reschedule
            </Button>
            <Button
              variant="danger"
              onClick={() => answer(current.id, "missed")}
              loading={pending}
            >
              <X className="h-4 w-4" /> Didn&apos;t attend
            </Button>
            <Button
              onClick={() => answer(current.id, "attended")}
              loading={pending}
            >
              <Check className="h-4 w-4" /> I attended
            </Button>
          </>
        }
      >
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-base font-bold text-slate-800">{current.title}</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
            <CalendarClock className="h-4 w-4 shrink-0" />
            {format(new Date(current.meeting_at), "EEE, MMM d · h:mm a")}
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
            <Icon className="h-4 w-4 shrink-0" />
            {online
              ? current.meeting_url || "Online"
              : current.location || "In person"}
          </p>
        </div>
        <p className="mt-4 text-sm text-slate-600">
          Did you attend this meeting? If it needs to happen again, reschedule
          it — everyone assigned gets a fresh alert and reminder.
        </p>
      </Modal>

      {/* Reschedule opens the full meeting editor, prefilled. */}
      <MeetingFormModal
        open={!!rescheduleTarget}
        onClose={() => setRescheduleTarget(null)}
        members={members}
        meeting={rescheduleTarget}
        onSaved={() => {
          if (rescheduleTarget) resolve(rescheduleTarget.id);
          setRescheduleTarget(null);
        }}
      />
    </>
  );
}
