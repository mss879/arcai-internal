"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

import { useArcusRealtime } from "@/components/assistant/use-arcus-realtime";
import { cn } from "@/lib/utils";

import { getApprovalsCount } from "@/app/(app)/approvals/actions";

/**
 * How many things are waiting on a decision, on every page (0119).
 *
 * The count comes from approvals_count() — one round-trip across all seven
 * queues — and refreshes when something new lands from outside (an assistant
 * approval, a client's change request), when the tab comes back into focus,
 * and on a slow heartbeat. Everything else that raises an approval happens on
 * a page the person is already looking at.
 */

const HEARTBEAT_MS = 90_000;

export function ApprovalsBadge({ initial }: { initial: number }) {
  const [count, setCount] = React.useState(initial);
  const pathname = usePathname();

  const refresh = React.useCallback(async () => {
    try {
      setCount(await getApprovalsCount());
    } catch {
      // Keep the last number; a stale badge beats a missing one.
    }
  }, []);

  React.useEffect(() => {
    setCount(initial);
  }, [initial]);

  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => void refresh(), HEARTBEAT_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [refresh]);

  useArcusRealtime("assistant_approvals", refresh);
  useArcusRealtime("project_change_requests", refresh);

  const active = pathname === "/approvals";

  return (
    <Link
      href="/approvals"
      aria-label={count > 0 ? `${count} waiting for a decision` : "Approvals"}
      title="Approvals"
      className={cn(
        "relative grid h-10 w-10 place-items-center rounded-xl transition hover:bg-slate-100",
        active ? "text-primary-600" : "text-slate-500 hover:text-slate-900",
      )}
    >
      <CheckCircle2 className="h-5 w-5" />
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
