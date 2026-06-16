"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarClock,
  Clock,
  Copy,
  ExternalLink,
  MapPin,
  MessageCircle,
  MoreVertical,
  Plus,
  Trash2,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { formatTime12 } from "@/lib/utils";
import type { MeetingLink } from "@/lib/types";

import {
  createMeetingLink,
  deleteMeetingLink,
  toggleMeetingLink,
  type MeetingLinkInput,
} from "./actions";

type LinkRow = MeetingLink & { bookings?: { count: number }[] };

export function MeetingsView({
  links,
  appBaseUrl,
}: {
  links: LinkRow[];
  appBaseUrl: string;
}) {
  const router = useRouter();
  const [creatingLink, setCreatingLink] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<MeetingLink | null>(null);
  const base = appBaseUrl || "";

  const urlFor = (slug: string) =>
    `${base || (typeof window !== "undefined" ? window.location.origin : "")}/book/${slug}`;

  function copy(slug: string) {
    navigator.clipboard.writeText(urlFor(slug));
    toast.success("Link copied");
  }

  async function handleCreateLink() {
    setCreatingLink(true);
    const res = await createMeetingLink({
      title: "Meeting",
      duration_minutes: 60,
      start_hour: 9,
      end_hour: 21,
      advance_days: 14,
    });
    setCreatingLink(false);
    if (res.ok) {
      toast.success("Shareable booking link generated!");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Meetings"
        description="Generate a public booking link, share it on WhatsApp, and clients pick a slot."
        actions={
          <Button onClick={handleCreateLink} loading={creatingLink}>
            <Plus className="h-4 w-4" /> Create link
          </Button>
        }
      />

      {links.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-6 w-6" />}
          title="No booking links yet"
          description="Create a link clients can use to book a time with you."
          action={
            <Button onClick={handleCreateLink} loading={creatingLink}>
              <Plus className="h-4 w-4" /> Create link
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {links.map((l) => {
            const count = l.bookings?.[0]?.count ?? 0;
            const url = urlFor(l.slug);
            const waText = encodeURIComponent(
              `Hi! Book a time with me here: ${url}`,
            );
            return (
              <div
                key={l.id}
                className="flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-slate-900">{l.title}</h3>
                      {l.active ? (
                        <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">
                          Active
                        </Badge>
                      ) : (
                        <Badge>Paused</Badge>
                      )}
                    </div>
                    {l.description && (
                      <p className="mt-1 text-sm text-slate-500">
                        {l.description}
                      </p>
                    )}
                  </div>
                  <Dropdown
                    trigger={
                      <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    }
                  >
                    <DropdownItem
                      onClick={async () => {
                        await toggleMeetingLink(l.id, !l.active);
                        router.refresh();
                      }}
                    >
                      {l.active ? "Pause link" : "Activate link"}
                    </DropdownItem>
                    <DropdownItem
                      destructive
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setToDelete(l)}
                    >
                      Delete
                    </DropdownItem>
                  </Dropdown>
                </div>

                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {l.duration_minutes} min · {formatTime12(`${l.start_hour}:00`)}–
                    {formatTime12(`${l.end_hour}:00`)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CalendarClock className="h-3.5 w-3.5" />
                    {l.advance_days} days ahead
                  </span>
                  {l.location && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" />
                      {l.location}
                    </span>
                  )}
                </div>

                <div className="mt-3 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
                  <span className="truncate text-xs text-slate-500">{url}</span>
                  <button
                    onClick={() => copy(l.slug)}
                    className="ml-auto shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"
                    aria-label="Copy link"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <a
                    href={`https://wa.me/?text=${waText}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                  >
                    <MessageCircle className="h-4 w-4" /> WhatsApp
                  </a>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200"
                  >
                    <ExternalLink className="h-4 w-4" /> Preview
                  </a>
                  <Link
                    href={`/meetings/${l.id}`}
                    className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 hover:text-primary-700"
                  >
                    <Users className="h-4 w-4" /> {count} booking
                    {count === 1 ? "" : "s"}
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}



      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete booking link"
        description={`Delete "${toDelete?.title}" and all its bookings?`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteMeetingLink(toDelete.id);
          if (res.ok) {
            toast.success("Link deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );
}


