"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { AtSign, Bell, CheckCheck, DollarSign, UserPlus } from "lucide-react";

import { Dropdown } from "@/components/ui/dropdown";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Notification } from "@/lib/types";

const ICONS = {
  mention: AtSign,
  assignment: UserPlus,
  commission: DollarSign,
  system: Bell,
};

export function NotificationsBell({
  initial,
}: {
  initial: Notification[];
}) {
  const router = useRouter();
  const [items, setItems] = React.useState(initial);
  const unread = items.filter((n) => !n.read).length;

  React.useEffect(() => setItems(initial), [initial]);

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
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">Notifications</p>
        {unread > 0 && (
          <button
            onClick={markAllRead}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
          >
            <CheckCheck className="h-3.5 w-3.5" /> Mark all read
          </button>
        )}
      </div>

      <div className="max-h-96 overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            You&apos;re all caught up 🎉
          </div>
        ) : (
          items.map((n) => {
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
                  <p className="mt-1 text-[11px] text-slate-400">
                    {formatDistanceToNow(new Date(n.created_at), {
                      addSuffix: true,
                    })}
                  </p>
                </div>
              </div>
            );
            return n.link ? (
              <Link key={n.id} href={n.link}>
                {content}
              </Link>
            ) : (
              <div key={n.id}>{content}</div>
            );
          })
        )}
      </div>
    </Dropdown>
  );
}
