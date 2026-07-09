"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, MapPin, Trash2, Video } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import type {
  MeetingLocationType,
  MemberLite,
  MeetingWithAttendees,
} from "@/lib/types";

import {
  deleteMeeting,
  saveMeeting,
  type MeetingInput,
} from "@/app/(app)/meetings/scheduled-actions";

const DURATIONS = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 45, label: "45 min" },
  { value: 60, label: "1 hour" },
  { value: 90, label: "1.5 hours" },
  { value: 120, label: "2 hours" },
  { value: 180, label: "3 hours" },
];

function toLocalInput(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function MeetingFormModal({
  open,
  onClose,
  members,
  meeting,
  defaultAt,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  members: MemberLite[];
  meeting?: MeetingWithAttendees | null;
  defaultAt?: string | null;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [deleting, startDelete] = React.useTransition();

  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [at, setAt] = React.useState("");
  const [duration, setDuration] = React.useState(60);
  const [locationType, setLocationType] =
    React.useState<MeetingLocationType>("online");
  const [meetingUrl, setMeetingUrl] = React.useState("");
  const [location, setLocation] = React.useState("");
  const [attendees, setAttendees] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!open) return;
    setTitle(meeting?.title ?? "");
    setDescription(meeting?.description ?? "");
    setAt(toLocalInput(meeting?.meeting_at ?? defaultAt ?? null));
    setDuration(meeting?.duration_minutes ?? 60);
    setLocationType(meeting?.location_type ?? "online");
    setMeetingUrl(meeting?.meeting_url ?? "");
    setLocation(meeting?.location ?? "");
    setAttendees(meeting?.attendee_ids ?? []);
  }, [open, meeting, defaultAt]);

  function toggleAttendee(id: string) {
    setAttendees((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function submit() {
    if (!title.trim()) {
      toast.error("Give the meeting a title.");
      return;
    }
    if (!at) {
      toast.error("Pick a date and time.");
      return;
    }
    if (locationType === "online" && !meetingUrl.trim()) {
      toast.error("Add the online meeting link.");
      return;
    }
    const input: MeetingInput = {
      id: meeting?.id,
      title: title.trim(),
      description: description.trim() || undefined,
      meeting_at: new Date(at).toISOString(),
      duration_minutes: duration,
      location_type: locationType,
      location: locationType === "in_person" ? location.trim() || null : null,
      meeting_url: locationType === "online" ? meetingUrl.trim() || null : null,
      attendee_ids: attendees,
    };
    startTransition(async () => {
      const res = await saveMeeting(input);
      if (res.ok) {
        toast.success(meeting ? "Meeting updated" : "Meeting scheduled");
        onSaved?.();
        router.refresh();
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  function remove() {
    if (!meeting?.id) return;
    startDelete(async () => {
      const res = await deleteMeeting(meeting.id);
      if (res.ok) {
        toast.success("Meeting deleted");
        onSaved?.();
        router.refresh();
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  const online = locationType === "online";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={meeting ? "Edit meeting" : "New meeting"}
      description="Set a time, pick online or in person, and assign your team. They're texted now and 3 hours before."
      size="lg"
      footer={
        <>
          {meeting && (
            <Button
              variant="danger"
              onClick={remove}
              loading={deleting}
              disabled={pending}
              className="mr-auto"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={pending || deleting}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending} disabled={deleting}>
            {meeting ? "Save changes" : "Schedule meeting"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What's the meeting about?"
            autoFocus
          />
        </Field>

        <Field label="Details">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Agenda, context, anything the team should know…"
            rows={3}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Date & time" required>
            <Input
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </Field>
          <Field label="Duration">
            <Select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Where">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { key: "online", label: "Online", icon: Video },
                { key: "in_person", label: "In person", icon: MapPin },
              ] as const
            ).map((opt) => {
              const active = locationType === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setLocationType(opt.key)}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition",
                    active
                      ? "border-primary-300 bg-primary-50 text-primary-700 ring-2 ring-primary-100"
                      : "border-slate-200 text-slate-500 hover:bg-slate-50",
                  )}
                >
                  <opt.icon className="h-4 w-4" />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </Field>

        {online ? (
          <Field
            label="Meeting link"
            required
            hint="Texted to attendees now and in the 3-hour reminder."
          >
            <Input
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              placeholder="https://meet.google.com/…  ·  Zoom  ·  Teams"
              inputMode="url"
            />
          </Field>
        ) : (
          <Field label="Location" hint="Venue or address, texted to attendees.">
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Office, café, client site…"
            />
          </Field>
        )}

        <Field
          label={
            attendees.length
              ? `Assign people · ${attendees.length} selected`
              : "Assign people"
          }
        >
          {members.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
              No teammates to assign yet.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {members.map((m) => {
                const selected = attendees.includes(m.id);
                const name = m.full_name || m.username;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleAttendee(m.id)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left text-sm transition",
                      selected
                        ? "border-primary-300 bg-primary-50 ring-1 ring-primary-100"
                        : "border-slate-200 hover:bg-slate-50",
                    )}
                  >
                    <Avatar name={name} src={m.avatar_url} size="xs" />
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-700">
                      {name}
                    </span>
                    <span
                      className={cn(
                        "grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 transition",
                        selected
                          ? "border-primary-500 bg-primary-500 text-white"
                          : "border-slate-300",
                      )}
                    >
                      {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}
