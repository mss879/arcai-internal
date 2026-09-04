"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  AtSign,
  Bell,
  BellOff,
  CheckCheck,
  CheckCircle2,
  DollarSign,
  Inbox,
  Settings2,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

import { Dropdown } from "@/components/ui/dropdown";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { NotificationLite } from "@/lib/types";
import { muteNotificationLink } from "@/app/(app)/profile/actions";

const ICONS: Record<string, React.ElementType> = {
  mention: AtSign,
  assignment: UserPlus,
  commission: DollarSign,
  system: Bell,
  // 0102 — a briefing or a nudge from Arcus.
  assistant: Sparkles,
  // 0115 — a conversation needs you, and something wants a decision.
  inbox: Inbox,
  approval: CheckCircle2,
};

export function NotificationsBell({
  initial,
}: {
  initial: NotificationLite[];
}) {
  const router = useRouter();
  const [items, setItems] = React.useState(initial);
  const [onlyUnread, setOnlyUnread] = React.useState(false);
  const unread = items.filter((n) => !n.read).length;

  React.useEffect(() => setItems(initial), [initial]);

  const visible = onlyUnread ? items.filter((n) => !n.read) : items;

  async function markAllRead() {
    if (unread === 0) return;
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    const supabase = createClient();
    await supabase
      .from("notifications")
      .update({ read: true })
      .eq("read", false);
    router.refresh();
  }

  /**
   * Opening one marks THAT one read.
   *
   * "Mark all read" was the only way to clear the badge, so acting on one
   * notification meant either dismissing everything or leaving the count
   * wrong. Optimistic, and never blocks the navigation.
   */
  async function markRead(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    const supabase = createClient();
    await supabase.from("notifications").update({ read: true }).eq("id", id);
  }

  /** Silence this whole thread — everything that links to the same place. */
  async function mute(link: string) {
    const res = await muteNotificationLink(link);
    if (res.ok) {
      toast.success("Muted. Unmute it in your profile.");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dropdown
      align="right"
      menuClassName="w-80 p-0"
      trigger={
        <button
          aria-label="Notifications"
          className="relative grid h-10 w-10 place-items-center rounded-xl text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
        >
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      }
    >
      <div className="border-b border-slate-100 px-4 py-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-900">Notifications</p>
          <div className="flex items-center gap-3">
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
            <Link
              href="/profile"
              className="text-slate-400 transition-colors hover:text-slate-700"
              aria-label="Notification preferences"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
        <div className="mt-2 flex gap-1.5">
          {(
            [
              [false, "All"],
              [true, `Unread${unread ? ` (${unread})` : ""}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              onClick={() => setOnlyUnread(value)}
              className={cn(
                "rounded-lg px-2 py-0.5 text-[11px] font-medium transition",
                onlyUnread === value
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-h-96 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            You&apos;re all caught up 🎉
          </div>
        ) : (
          visible.map((n) => {
            const Icon = ICONS[n.type] ?? Bell;
            const content = (
              <div
                className={cn(
                  "flex gap-3 px-4 py-3 transition-colors hover:bg-slate-50",
                  !n.read && "bg-primary-50/40",
                )}
              >
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-500">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">
                    {n.title}
                  </p>
                  {n.body && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                      {n.body}
                    </p>
                  )}
                  <p className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                    {formatDistanceToNow(new Date(n.created_at), {
                      addSuffix: true,
                    })}
                    {n.link && (
                      <button
                        onClick={(e) => {
                          // Inside a Link — don't navigate on the mute.
                          e.preventDefault();
                          e.stopPropagation();
                          void mute(n.link!);
                        }}
                        className="inline-flex items-center gap-0.5 opacity-0 transition-opacity hover:text-slate-600 group-hover:opacity-100"
                        aria-label="Mute this thread"
                      >
                        <BellOff className="h-3 w-3" /> Mute
                      </button>
                    )}
                  </p>
                </div>
              </div>
            );
            return n.link ? (
              <Link
                key={n.id}
                href={n.link}
                className="group block"
                onClick={() => void markRead(n.id)}
              >
                {content}
              </Link>
            ) : (
              <div key={n.id} className="group">
                {content}
              </div>
            );
          })
        )}
      </div>
    </Dropdown>
  );
}
