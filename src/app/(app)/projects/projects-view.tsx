"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  ChevronDown,
  FolderKanban,
  MoreVertical,
  Pencil,
  Plus,
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

import { deleteProject } from "./actions";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";

type ProjectCard = Project & {
  client?: Pick<Client, "id" | "name" | "company"> | null;
  payments?: { amount: number; status: string }[];
};

export function ProjectsView({
  projects,
  clients,
}: {
  projects: ProjectCard[];
  clients: Pick<Client, "id" | "name" | "company">[];
}) {
  useRealtimeSyncTables(["projects", "payments"]);

  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Project | null>(null);
  const [toDelete, setToDelete] = React.useState<Project | null>(null);

  const activeProjects = projects.filter((p) => p.status === "active");
  const activeCount = activeProjects.length;

  const getSumByCurrency = (projectList: typeof projects) => {
    const sums: Record<string, number> = {};
    projectList.forEach((p) => {
      const val = Number(p.total_value) || 0;
      const curr = p.currency || "LKR";
      sums[curr] = (sums[curr] || 0) + val;
    });
    return sums;
  };

  const totalSums = getSumByCurrency(projects);

  const formatSums = (sums: Record<string, number>) => {
    const entries = Object.entries(sums);
    if (entries.length === 0) return formatCurrency(0, "LKR");
    return entries
      .map(([curr, val]) => formatCurrency(val, curr))
      .join(" + ");
  };

  // Group projects by the month they were added (newest month first).
  // `projects` already arrives ordered by created_at descending.
  const monthGroups = React.useMemo(() => {
    const groups: { key: string; label: string; projects: ProjectCard[] }[] = [];
    const index = new Map<string, number>();
    for (const p of projects) {
      const date = p.created_at ? new Date(p.created_at) : new Date();
      const key = format(date, "yyyy-MM");
      const label = format(date, "MMMM yyyy");
      let i = index.get(key);
      if (i === undefined) {
        i = groups.length;
        index.set(key, i);
        groups.push({ key, label, projects: [] });
      }
      groups[i].projects.push(p);
    }
    return groups;
  }, [projects]);

  // Most recent month open by default; once a newer month appears it opens at the top.
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const isOpen = (key: string, isFirst: boolean) =>
    collapsed[key] === undefined ? isFirst : !collapsed[key];
  const toggleMonth = (key: string, isFirst: boolean) =>
    setCollapsed((prev) => ({ ...prev, [key]: isOpen(key, isFirst) }));

  const renderCard = (p: ProjectCard) => {
    const totalValue = Number(p.total_value) || 0;
    const deposit = Number(p.deposit_paid) || 0;
    const balance = Math.max(0, totalValue - deposit);
    const pct = totalValue
      ? Math.min(100, Math.round((deposit / totalValue) * 100))
      : 0;
    return (
      <div
        key={p.id}
        className="group relative flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-lift)]"
      >
        <div className="flex items-start justify-between gap-2">
          <Badge className={PROJECT_STATUS_META[p.status].badge}>
            {PROJECT_STATUS_META[p.status].label}
          </Badge>
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
                Deposit paid
              </p>
              <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
                <Wallet className="h-4 w-4 text-emerald-500" />
                {formatCurrency(deposit, p.currency)}
              </span>
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
                {formatCurrency(deposit, p.currency)} of{" "}
                {formatCurrency(totalValue, p.currency)} total
              </p>
            </>
          ) : null}
        </div>
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-semibold text-slate-900">
                      {group.label}
                    </h2>
                    <Badge className="bg-slate-100 text-slate-600">
                      {group.projects.length}
                    </Badge>
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
                    {group.projects.map((p) => renderCard(p))}
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
