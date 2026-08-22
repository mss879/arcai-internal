"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  CalendarClock,
  ChevronDown,
  FileText,
  FolderKanban,
  History,
  MoreVertical,
  Pencil,
  Pin,
  Plus,
  Receipt,
  Trash2,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ProjectFormModal } from "@/components/projects/project-form-modal";
import { PROJECT_STATUS_META } from "@/lib/constants";
import { cn, formatCurrency } from "@/lib/utils";
import type { Client, Project } from "@/lib/types";

import { deleteProject, setProjectCarryForward } from "./actions";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";

/** Work that hasn't finished — the projects that carry into this month. */
const OPEN_STATUSES = new Set(["planning", "active", "on_hold"]);

type ProjectCard = Project & {
  client?: Pick<Client, "id" | "name" | "company"> | null;
  payments?: { amount: number; status: string }[];
  /** Payments recorded on the Payments page against this project (0083). */
  company_payments?: {
    id: string;
    price_lkr: number;
    is_paid: boolean;
    status: string;
  }[];
};

/** Money in against a project: the deposit on the project itself plus every
 * linked payment already marked paid. Shared by the card and the totals so
 * both agree with what the Payments page shows. */
function settledAmount(p: ProjectCard): number {
  const linkedPaid = (p.company_payments ?? [])
    .filter((cp) => cp.is_paid)
    .reduce((sum, cp) => sum + Number(cp.price_lkr), 0);
  return Number(p.deposit_paid ?? 0) + linkedPaid;
}

/**
 * Where a project sits on the board (0087).
 *
 * A project is filed under the month it was created — except while it's still
 * unfinished, when it rides along into the CURRENT month so work in progress
 * is never buried in a collapsed month from six months ago. It keeps a
 * "Continuing from June 2026" tag either way, and drops back to its own month
 * the moment it's completed or cancelled.
 */
type PlacedProject = {
  project: ProjectCard;
  /** The month it was created — always its origin, whatever it's showing under. */
  originKey: string;
  originLabel: string;
  /** Showing under the current month rather than its origin. */
  carried: boolean;
  /** Unfinished and created before this month — i.e. carry-forward applies. */
  candidate: boolean;
};

export function ProjectsView({
  projects,
  clients,
}: {
  projects: ProjectCard[];
  clients: Pick<Client, "id" | "name" | "company">[];
}) {
  // company_payments too: ticking a payment paid on /payments must move the
  // balance here without a manual refresh.
  useRealtimeSyncTables(["projects", "payments", "company_payments"]);

  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Project | null>(null);
  const [toDelete, setToDelete] = React.useState<Project | null>(null);

  const activeProjects = projects.filter((p) => p.status === "active");
  const activeCount = activeProjects.length;

  const getSumByCurrency = React.useCallback((projectList: typeof projects) => {
    const sums: Record<string, number> = {};
    projectList.forEach((p) => {
      const val = Number(p.total_value) || 0;
      const curr = p.currency || "LKR";
      sums[curr] = (sums[curr] || 0) + val;
    });
    return sums;
  }, []);

  const totalSums = React.useMemo(() => getSumByCurrency(projects), [projects, getSumByCurrency]);

  const currentMonthKey = format(new Date(), "yyyy-MM");
  const currentMonthProjects = React.useMemo(() => {
    return projects.filter((p) => {
      const date = p.created_at ? new Date(p.created_at) : new Date();
      return format(date, "yyyy-MM") === currentMonthKey;
    });
  }, [projects, currentMonthKey]);

  const currentMonthSums = React.useMemo(
    () => getSumByCurrency(currentMonthProjects),
    [currentMonthProjects, getSumByCurrency]
  );

  const formatSums = (sums: Record<string, number>) => {
    const entries = Object.entries(sums);
    if (entries.length === 0) return formatCurrency(0, "LKR");
    return entries
      .map(([curr, val]) => formatCurrency(val, curr))
      .join(" + ");
  };

  const currentMonthLabel = format(new Date(), "MMMM yyyy");

  // Work out where each project belongs before grouping: its origin month,
  // and whether it's carrying forward into this one.
  const placed = React.useMemo<PlacedProject[]>(
    () =>
      projects.map((p) => {
        const date = p.created_at ? new Date(p.created_at) : new Date();
        const originKey = format(date, "yyyy-MM");
        const open = OPEN_STATUSES.has(p.status);
        const candidate = open && originKey < currentMonthKey;
        return {
          project: p,
          originKey,
          originLabel: format(date, "MMMM yyyy"),
          // Default is to carry: a project saved before 0087 has no column
          // value yet and should still surface where the team is working.
          carried: candidate && p.carry_forward !== false,
          candidate,
        };
      }),
    [projects, currentMonthKey],
  );

  // Group by the month each project shows under, newest month first.
  // `projects` already arrives ordered by created_at descending, so carried
  // projects settle below this month's own at the bottom of the group.
  const monthGroups = React.useMemo(() => {
    const map = new Map<string, PlacedProject[]>();
    for (const item of placed) {
      const key = item.carried ? currentMonthKey : item.originKey;
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([key, items]) => ({
        key,
        label: format(new Date(`${key}-01T00:00:00`), "MMMM yyyy"),
        items,
        carriedCount: items.filter((i) => i.carried).length,
      }));
  }, [placed, currentMonthKey]);

  const toggleCarryForward = async (item: PlacedProject) => {
    const next = !item.carried;
    const res = await setProjectCarryForward(item.project.id, next);
    if (res.ok) {
      toast.success(
        next
          ? `Moved into ${currentMonthLabel}`
          : `Pinned to ${item.originLabel}`,
      );
      router.refresh();
    } else {
      toast.error(res.error);
    }
  };

  // Most recent month open by default; once a newer month appears it opens at the top.
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const isOpen = (key: string, isFirst: boolean) =>
    collapsed[key] === undefined ? isFirst : !collapsed[key];
  const toggleMonth = (key: string, isFirst: boolean) =>
    setCollapsed((prev) => ({ ...prev, [key]: isOpen(key, isFirst) }));

  const renderCard = (item: PlacedProject) => {
    const p = item.project;
    const totalValue = Number(p.total_value) || 0;
    const deposit = Number(p.deposit_paid) || 0;
    // Received = the deposit plus every linked payment marked paid, so the
    // balance moves the moment the team ticks a payment off on /payments.
    const received = settledAmount(p);
    const linkedPaidCount = (p.company_payments ?? []).filter(
      (cp) => cp.is_paid,
    ).length;
    const balance = Math.max(0, totalValue - received);
    const pct = totalValue
      ? Math.min(100, Math.round((received / totalValue) * 100))
      : 0;
    return (
      <div
        key={p.id}
        className="group relative flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-lift)]"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge className={PROJECT_STATUS_META[p.status].badge}>
              {PROJECT_STATUS_META[p.status].label}
            </Badge>
            {/* Where the work actually started — the whole point of letting
             * an unfinished project ride into this month. */}
            {item.carried && (
              <Badge
                className="bg-amber-50 text-amber-700 ring-amber-200"
                title={`Started in ${item.originLabel} and still open, so it follows you into ${currentMonthLabel}.`}
              >
                <History className="h-3 w-3" />
                Continuing from {item.originLabel}
              </Badge>
            )}
            {item.candidate && !item.carried && (
              <Badge
                className="bg-slate-100 text-slate-500 ring-slate-200"
                title={`Pinned here — it won't follow you into ${currentMonthLabel}.`}
              >
                <Pin className="h-3 w-3" />
                Pinned
              </Badge>
            )}
          </div>
          <Dropdown
            trigger={
              <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
                <MoreVertical className="h-4 w-4" />
              </button>
            }
          >
            <DropdownItem
              icon={<Pencil className="h-4 w-4" />}
              onClick={() => setEditing(p)}
            >
              Edit
            </DropdownItem>
            {item.candidate && (
              <DropdownItem
                icon={
                  item.carried ? (
                    <Pin className="h-4 w-4" />
                  ) : (
                    <CalendarClock className="h-4 w-4" />
                  )
                }
                onClick={() => toggleCarryForward(item)}
              >
                {item.carried
                  ? `Pin to ${item.originLabel}`
                  : `Move into ${currentMonthLabel}`}
              </DropdownItem>
            )}
            <DropdownItem
              destructive
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => setToDelete(p)}
            >
              Delete
            </DropdownItem>
          </Dropdown>
        </div>

        <Link href={`/projects/${p.id}`} className="mt-3 flex-1">
          <h3 className="text-base font-semibold text-slate-900 group-hover:text-primary-700">
            {p.name}
          </h3>
          {p.client && (
            <p className="mt-0.5 text-sm text-slate-400">{p.client.name}</p>
          )}
          {p.description && (
            <p className="mt-2 line-clamp-2 text-sm text-slate-500">
              {p.description}
            </p>
          )}
        </Link>

        <div className="mt-4">
          <div className="flex items-end justify-between gap-2 text-sm">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Received
              </p>
              <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
                <Wallet className="h-4 w-4 text-emerald-500" />
                {formatCurrency(received, p.currency)}
              </span>
              {linkedPaidCount > 0 && (
                <p className="text-[11px] text-slate-400">
                  {formatCurrency(deposit, p.currency)} deposit +{" "}
                  {linkedPaidCount} payment{linkedPaidCount === 1 ? "" : "s"}
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Balance due
              </p>
              <span
                className={cn(
                  "font-semibold",
                  balance > 0 ? "text-amber-600" : "text-emerald-600",
                )}
              >
                {formatCurrency(balance, p.currency)}
              </span>
            </div>
          </div>
          {totalValue ? (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    pct >= 100 ? "bg-emerald-500" : "bg-primary-500",
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-slate-400">
                {formatCurrency(received, p.currency)} of{" "}
                {formatCurrency(totalValue, p.currency)} total
              </p>
            </>
          ) : null}
        </div>

        {(p.proposal_url || p.invoice_url) && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            {p.proposal_url && (
              <a
                href={p.proposal_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-white hover:text-primary-700"
              >
                <FileText className="h-3.5 w-3.5" /> Proposal
              </a>
            )}
            {p.invoice_url && (
              <a
                href={p.invoice_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-white hover:text-primary-700"
              >
                <Receipt className="h-3.5 w-3.5" /> Invoice
              </a>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Plan projects, track payments and allocate commissions."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New project
          </Button>
        }
      />

      {projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="animate-continuous-float" style={{ animationDelay: "0ms" }}>
            <div className="group rounded-2xl border border-white/30 bg-gradient-to-br from-white/60 to-white/25 p-5 shadow-sm backdrop-blur-xl transition-all duration-300 ease-out hover:-translate-y-1 hover:scale-[1.01] hover:from-white/75 hover:to-white/40 hover:border-primary-400 hover:shadow-md">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Active Projects
              </p>
              <p className="mt-2 text-3xl font-extrabold text-slate-800 tracking-tight">
                {activeCount}
              </p>
            </div>
          </div>

          <div className="animate-continuous-float" style={{ animationDelay: "150ms" }}>
            <div className="group rounded-2xl border border-white/30 bg-gradient-to-br from-white/60 to-white/25 p-5 shadow-sm backdrop-blur-xl transition-all duration-300 ease-out hover:-translate-y-1 hover:scale-[1.01] hover:from-white/75 hover:to-white/40 hover:border-emerald-400 hover:shadow-md">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Total Value
              </p>
              <p className="mt-2 text-3xl font-extrabold text-slate-800 tracking-tight">
                {formatSums(totalSums)}
              </p>
            </div>
          </div>

          <div className="animate-continuous-float" style={{ animationDelay: "300ms" }}>
            <div className="group rounded-2xl border border-white/30 bg-gradient-to-br from-white/60 to-white/25 p-5 shadow-sm backdrop-blur-xl transition-all duration-300 ease-out hover:-translate-y-1 hover:scale-[1.01] hover:from-white/75 hover:to-white/40 hover:border-indigo-400 hover:shadow-md">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                This Month&apos;s Value
              </p>
              <p className="mt-2 text-3xl font-extrabold text-slate-800 tracking-tight">
                {formatSums(currentMonthSums)}
              </p>
              {/* Deliberately NOT the sum of the month's group: that group also
               * holds older projects still running, and counting them again
               * every month would inflate what was actually booked. */}
              <p className="mt-1 text-[11px] text-slate-400">
                Projects started in {currentMonthLabel}
              </p>
            </div>
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="h-6 w-6" />}
          title="No projects yet"
          description="Create your first project to start tracking work and payments."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New project
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {monthGroups.map((group, gi) => {
            const open = isOpen(group.key, gi === 0);
            return (
              <div
                key={group.key}
                className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white/60 shadow-[var(--shadow-card)] backdrop-blur-sm"
              >
                <button
                  type="button"
                  onClick={() => toggleMonth(group.key, gi === 0)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition hover:bg-slate-50"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-base font-semibold text-slate-900">
                      {group.label}
                    </h2>
                    <Badge className="bg-slate-100 text-slate-600">
                      {group.items.length}
                    </Badge>
                    {group.carriedCount > 0 && (
                      <span className="text-xs text-slate-400">
                        incl. {group.carriedCount} continuing from earlier
                      </span>
                    )}
                  </div>
                  <ChevronDown
                    className={cn(
                      "h-5 w-5 shrink-0 text-slate-400 transition-transform duration-200",
                      open && "rotate-180",
                    )}
                  />
                </button>
                {open && (
                  <div className="grid grid-cols-1 gap-4 border-t border-slate-200/60 p-5 sm:grid-cols-2 xl:grid-cols-3">
                    {group.items.map((item) => renderCard(item))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ProjectFormModal
        open={creating || !!editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        project={editing}
        clients={clients}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete project"
        description={`Delete "${toDelete?.name}" and all its payments?`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteProject(toDelete.id);
          if (res.ok) {
            toast.success("Project deleted");
            router.refresh();
          } else {
            toast.error(res.error);
          }
        }}
      />
    </div>
  );
}
