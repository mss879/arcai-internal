"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowUpRight,
  BadgeDollarSign,
  Check,
  CheckCircle2,
  Image as ImageIcon,
  Mail,
  MessageSquare,
  Sparkles,
  Wallet,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import type { ApprovalItem, ApprovalKind } from "@/lib/approvals";
import { cn, formatCurrency } from "@/lib/utils";

import { decideApproval } from "./actions";

/**
 * One queue for everything waiting on a person.
 *
 * Two kinds of row on purpose. Most can be decided here — one tap, and the
 * queue that owns it does the real work. Two cannot: an assistant draft needs
 * the card (and a browser session) to send, and a carousel needs somebody to
 * look at two designs. Those link out rather than showing a button that would
 * do the wrong thing, because a decision made without seeing the thing is not
 * a decision.
 */

const META: Record<
  ApprovalKind,
  { label: string; icon: React.ElementType; tone: string; decidable: boolean }
> = {
  assistant: {
    label: "Arcus",
    icon: Sparkles,
    tone: "text-violet-600",
    decidable: false,
  },
  loan: { label: "Advance", icon: Wallet, tone: "text-amber-600", decidable: true },
  commission: {
    label: "Commission",
    icon: BadgeDollarSign,
    tone: "text-emerald-600",
    decidable: true,
  },
  wa_lesson: {
    label: "Agent lesson",
    icon: MessageSquare,
    tone: "text-green-600",
    decidable: true,
  },
  outreach: { label: "Cold email", icon: Mail, tone: "text-sky-600", decidable: true },
  change_request: {
    label: "Change request",
    icon: CheckCircle2,
    tone: "text-rose-600",
    decidable: true,
  },
  carousel: {
    label: "Design pick",
    icon: ImageIcon,
    tone: "text-fuchsia-600",
    decidable: false,
  },
};

export function ApprovalsView({
  items,
  loanOwners,
}: {
  items: ApprovalItem[];
  /** loan id → the member it belongs to; the loan action needs both. */
  loanOwners: Record<string, string>;
}) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<ApprovalKind | "all">("all");
  const [busy, setBusy] = React.useState<string | null>(null);

  const counts = React.useMemo(() => {
    const map = new Map<ApprovalKind, number>();
    for (const i of items) map.set(i.kind, (map.get(i.kind) ?? 0) + 1);
    return map;
  }, [items]);

  const visible = filter === "all" ? items : items.filter((i) => i.kind === filter);

  async function decide(item: ApprovalItem, decision: "approve" | "decline") {
    setBusy(item.key);
    const res = await decideApproval(item.key, decision, {
      userId: item.kind === "loan" ? loanOwners[item.id] : undefined,
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else toast.error(res.error);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Approvals"
        description="Everything waiting on a decision — from every part of the app, in one queue."
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<Check className="h-6 w-6" />}
          title="Nothing is waiting on you"
          description="Drafts, advances, commissions, agent lessons, cold emails, change requests and design picks all land here."
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setFilter("all")}
              className={cn(
                "rounded-xl px-3 py-1.5 text-sm font-medium transition",
                filter === "all"
                  ? "bg-primary-600 text-white shadow-sm"
                  : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
              )}
            >
              Everything ({items.length})
            </button>
            {([...counts.keys()] as ApprovalKind[]).map((kind) => {
              const Icon = META[kind].icon;
              return (
                <button
                  key={kind}
                  onClick={() => setFilter(kind)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-medium transition",
                    filter === kind
                      ? "bg-slate-900 text-white"
                      : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {META[kind].label} ({counts.get(kind)})
                </button>
              );
            })}
          </div>

          <ul className="space-y-2">
            {visible.map((item) => {
              const meta = META[item.kind];
              const Icon = meta.icon;
              return (
                <li
                  key={item.key}
                  className="flex flex-wrap items-start gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]"
                >
                  <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", meta.tone)} />

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900">
                      {item.title}
                    </p>
                    {item.body && (
                      <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">
                        {item.body}
                      </p>
                    )}
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span>{meta.label}</span>
                      <span>·</span>
                      <span>
                        {formatDistanceToNow(new Date(item.at), { addSuffix: true })}
                      </span>
                      {item.amount != null && (
                        <>
                          <span>·</span>
                          <span className="font-medium text-slate-600">
                            {formatCurrency(item.amount, item.currency ?? "LKR")}
                          </span>
                        </>
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <Link href={item.href}>
                      <Button size="sm" variant="ghost">
                        Open <ArrowUpRight className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                    {meta.decidable && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === item.key}
                          onClick={() => decide(item, "decline")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          loading={busy === item.key}
                          disabled={busy === item.key}
                          onClick={() => decide(item, "approve")}
                        >
                          <Check className="h-3.5 w-3.5" /> Approve
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
