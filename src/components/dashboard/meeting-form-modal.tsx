"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, MapPin, Trash2, UserPlus, Video, X } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import {
  DEFAULT_MEETING_REMINDER_HOURS,
  MEETING_REMINDER_OPTIONS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import type {
  MeetingLocationType,
  MemberLite,
  MeetingWithAttendees,
} from "@/lib/types";

import {
  createClientForMeeting,
  deleteMeeting,
  listClientOptions,
  saveMeeting,
  type ClientOption,
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
  const [reminderHours, setReminderHours] = React.useState(
    DEFAULT_MEETING_REMINDER_HOURS,
  );

  const [clients, setClients] = React.useState<ClientOption[]>([]);
  const [clientId, setClientId] = React.useState("");
  // Inline "new client" form, so a first meeting with someone new doesn't
  // mean leaving this modal and losing what's already typed.
  const [newClient, setNewClient] = React.useState<{
    name: string;
    company: string;
    phone: string;
    email: string;
  } | null>(null);
  const [creatingClient, startCreateClient] = React.useTransition();

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
    setReminderHours(meeting?.reminder_hours ?? DEFAULT_MEETING_REMINDER_HOURS);
    setClientId(meeting?.client_id ?? "");
    setNewClient(null);
    void listClientOptions().then(setClients);
  }, [open, meeting, defaultAt]);

  function saveNewClient() {
    if (!newClient?.name.trim()) {
      toast.error("Give the client a name.");
      return;
    }
    startCreateClient(async () => {
      const res = await createClientForMeeting(newClient);
      if (!res.ok || !res.client) {
        toast.error(res.ok ? "Could not create the client." : res.error);
        return;
      }
      setClients((prev) =>
        [...prev, res.client!].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setClientId(res.client.id);
      setNewClient(null);
      toast.success(`${res.client.name} added to Clients`);
    });
  }

  function toggleAttendee(id: string) {
    setAttendees((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function submit() {
    if (newClient) {
      toast.error("Save or cancel the new client first.");
      return;
    }
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
      reminder_hours: reminderHours,
      client_id: clientId || null,
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
      description="Set a time, pick online or in person, and assign your team. They're texted now and again before it starts."
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

        <Field
          label="Remind attendees"
          hint="Everyone assigned gets a text, a push and an in-app alert this far ahead."
        >
          <Select
            value={reminderHours}
            onChange={(e) => setReminderHours(Number(e.target.value))}
          >
            {MEETING_REMINDER_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h} hour{h === 1 ? "" : "s"} before
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Client"
          hint="Who the meeting is with — their name rides along on the invite and the reminder."
        >
          {newClient ? (
            <div className="space-y-2.5 rounded-xl border border-primary-200 bg-primary-50/50 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-primary-700">
                  New client
                </span>
                <button
                  type="button"
                  onClick={() => setNewClient(null)}
                  className="rounded-lg p-1 text-slate-400 hover:bg-white hover:text-slate-600"
                  aria-label="Cancel new client"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Input
                  value={newClient.name}
                  onChange={(e) =>
                    setNewClient({ ...newClient, name: e.target.value })
                  }
                  placeholder="Name *"
                  autoFocus
                />
                <Input
                  value={newClient.company}
                  onChange={(e) =>
                    setNewClient({ ...newClient, company: e.target.value })
                  }
                  placeholder="Business"
                />
                <Input
                  value={newClient.phone}
                  onChange={(e) =>
                    setNewClient({ ...newClient, phone: e.target.value })
                  }
                  placeholder="Phone"
                  inputMode="tel"
                />
                <Input
                  value={newClient.email}
                  onChange={(e) =>
                    setNewClient({ ...newClient, email: e.target.value })
                  }
                  placeholder="Email"
                  inputMode="email"
                />
              </div>
              <Button
                size="sm"
                onClick={saveNewClient}
                loading={creatingClient}
                className="w-full"
              >
                Add client
              </Button>
              <p className="text-[11px] text-slate-500">
                Saved to Clients as a lead — you can fill in the rest there later.
              </p>
            </div>
          ) : (
            <div className="flex gap-2">
              <Select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="flex-1"
              >
                <option value="">No client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.company ? ` — ${c.company}` : ""}
                  </option>
                ))}
              </Select>
              <Button
                variant="outline"
                onClick={() =>
                  setNewClient({ name: "", company: "", phone: "", email: "" })
                }
              >
                <UserPlus className="h-4 w-4" />
                New
              </Button>
            </div>
          )}
        </Field>

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
            hint="Texted to attendees now and again in the reminder."
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
