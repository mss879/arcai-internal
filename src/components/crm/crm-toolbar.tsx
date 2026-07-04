"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bookmark,
  Building2,
  CalendarCheck,
  Columns3,
  Filter,
  ListChecks,
  MoreHorizontal,
  Search,
  Settings2,
  Table2,
  Trash2,
  TrendingUp,
  Upload,
  Users2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import type {
  CrmSegment,
  CrmTask,
  LeadWithAssignee,
  MemberLite,
} from "@/lib/types";
import { LEAD_SOURCES } from "@/components/crm/lead-form-modal";
import { daysInactive } from "@/components/crm/lead-card";

import {
  deleteSegment,
  saveSegment,
  toggleCrmTask,
  type SegmentFilters,
} from "@/app/(app)/crm/actions";

export type ViewMode = "board" | "table" | "forecast";

export type LeadFilters = {
  q: string;
  tag: string;
  assigned_to: string;
  source: string;
  score: string;
  status: string;
  stale: boolean;
};

export const EMPTY_FILTERS: LeadFilters = {
  q: "",
  tag: "",
  assigned_to: "",
  source: "",
  score: "",
  status: "",
  stale: false,
};

export function applyFilters(
  leads: LeadWithAssignee[],
  filters: LeadFilters,
  staleAfterDays: number,
): LeadWithAssignee[] {
  const q = filters.q.trim().toLowerCase();
  return leads.filter((lead) => {
    if (q) {
      const haystack = [
        lead.title,
        lead.company,
        lead.contact_name,
        lead.contact_email,
        lead.contact_phone,
        lead.notes,
        ...(lead.tags ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filters.tag && !(lead.tags ?? []).includes(filters.tag)) return false;
    if (filters.assigned_to && lead.assigned_to !== filters.assigned_to) return false;
    if (filters.source && lead.source !== filters.source) return false;
    if (filters.score && lead.score !== filters.score) return false;
    if (filters.status && lead.status !== filters.status) return false;
    if (filters.stale && !(lead.status === "open" && daysInactive(lead) >= staleAfterDays))
      return false;
    return true;
  });
}

export function filtersActive(f: LeadFilters): boolean {
  return Boolean(
    f.q || f.tag || f.assigned_to || f.source || f.score || f.status || f.stale,
  );
}

export function CrmToolbar({
  filters,
  onFilters,
  view,
  onView,
  segments,
  allTags,
  members,
  tasks,
  currentUserId,
  matchCount,
}: {
  filters: LeadFilters;
  onFilters: (f: LeadFilters) => void;
  view: ViewMode;
  onView: (v: ViewMode) => void;
  segments: CrmSegment[];
  allTags: string[];
  members: MemberLite[];
  tasks: CrmTask[];
  currentUserId?: string;
  matchCount: number;
}) {
  const router = useRouter();
  const [showFilters, setShowFilters] = React.useState(false);
  const [tasksOpen, setTasksOpen] = React.useState(false);
  const [savingSegment, setSavingSegment] = React.useState(false);

  const set = (patch: Partial<LeadFilters>) => onFilters({ ...filters, ...patch });

  const overdueTasks = tasks.filter(
    (t) => t.due_at && new Date(t.due_at).getTime() < Date.now(),
  ).length;

  function applySegment(segment: CrmSegment) {
    const f = segment.filters as SegmentFilters;
    onFilters({
      ...EMPTY_FILTERS,
      q: f.q ?? "",
      tag: f.tag ?? "",
      assigned_to: f.assigned_to ?? "",
      source: f.source ?? "",
      score: f.score ?? "",
      status: f.status ?? "",
      stale: Boolean(f.no_activity_days),
    });
    setShowFilters(true);
  }

  async function handleSaveSegment() {
    const name = window.prompt("Name this segment (e.g. FB leads, no reply 7d):");
    if (!name?.trim()) return;
    setSavingSegment(true);
    const res = await saveSegment(name, {
      q: filters.q || undefined,
      tag: filters.tag || undefined,
      assigned_to: filters.assigned_to || undefined,
      source: filters.source || undefined,
      score: filters.score || undefined,
      status: filters.status || undefined,
      no_activity_days: filters.stale ? 7 : undefined,
    });
    setSavingSegment(false);
    if (res.ok) toast.success("Segment saved — it stays in sync automatically.");
    else toast.error(res.error);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
          <Input
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search leads…"
            className="w-56 pl-9"
          />
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowFilters((v) => !v)}
          className={cn(filtersActive(filters) && "border-primary-300 text-primary-600")}
        >
          <Filter className="h-4 w-4" />
          Filters
          {filtersActive(filters) && (
            <span className="rounded-full bg-primary-100 px-1.5 text-[11px] font-bold text-primary-600">
              {matchCount}
            </span>
          )}
        </Button>

        {/* Segments */}
        {segments.length > 0 && (
          <Select
            value=""
            onChange={(e) => {
              const seg = segments.find((s) => s.id === e.target.value);
              if (seg) applySegment(seg);
            }}
            className="w-44"
          >
            <option value="">Smart segments…</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
        {filtersActive(filters) && (
          <>
            <Button variant="ghost" size="sm" onClick={handleSaveSegment} loading={savingSegment}>
              <Bookmark className="h-4 w-4" />
              Save segment
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onFilters(EMPTY_FILTERS)}>
              <X className="h-4 w-4" />
              Clear
            </Button>
          </>
        )}

        <span className="ml-auto" />

        {/* Tasks */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTasksOpen(true)}
          className={cn(overdueTasks > 0 && "border-rose-200 text-rose-600")}
        >
          <CalendarCheck className="h-4 w-4" />
          My day
          {tasks.length > 0 && (
            <span
              className={cn(
                "rounded-full px-1.5 text-[11px] font-bold",
                overdueTasks > 0 ? "bg-rose-100 text-rose-600" : "bg-slate-100 text-slate-500",
              )}
            >
              {tasks.length}
            </span>
          )}
        </Button>

        {/* View switch */}
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm">
          <ViewButton active={view === "board"} onClick={() => onView("board")} label="Board">
            <Columns3 className="h-4 w-4" />
          </ViewButton>
          <ViewButton active={view === "table"} onClick={() => onView("table")} label="Table">
            <Table2 className="h-4 w-4" />
          </ViewButton>
          <ViewButton
            active={view === "forecast"}
            onClick={() => onView("forecast")}
            label="Forecast"
          >
            <TrendingUp className="h-4 w-4" />
          </ViewButton>
        </div>

        {/* More */}
        <Dropdown
          trigger={
            <button className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:text-slate-800">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          }
        >
          <DropdownItem
            icon={<Upload className="h-4 w-4" />}
            onClick={() => router.push("/crm/import")}
          >
            Import CSV
          </DropdownItem>
          <DropdownItem
            icon={<Building2 className="h-4 w-4" />}
            onClick={() => router.push("/crm/companies")}
          >
            Companies
          </DropdownItem>
          <DropdownItem
            icon={<Users2 className="h-4 w-4" />}
            onClick={() => router.push("/crm/duplicates")}
          >
            Find duplicates
          </DropdownItem>
          <DropdownItem
            icon={<Settings2 className="h-4 w-4" />}
            onClick={() => router.push("/crm/settings")}
          >
            Fields & settings
          </DropdownItem>
          <DropdownItem
            icon={<Trash2 className="h-4 w-4" />}
            onClick={() => router.push("/crm/trash")}
          >
            Trash
          </DropdownItem>
        </Dropdown>
      </div>

      {showFilters && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200/70 bg-white p-2.5 shadow-sm">
          <Select value={filters.tag} onChange={(e) => set({ tag: e.target.value })} className="w-36">
            <option value="">Any tag</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Select
            value={filters.assigned_to}
            onChange={(e) => set({ assigned_to: e.target.value })}
            className="w-40"
          >
            <option value="">Any assignee</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name || m.username}
              </option>
            ))}
          </Select>
          <Select
            value={filters.source}
            onChange={(e) => set({ source: e.target.value })}
            className="w-36"
          >
            <option value="">Any source</option>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select
            value={filters.score}
            onChange={(e) => set({ score: e.target.value })}
            className="w-32"
          >
            <option value="">Any score</option>
            <option value="hot">🔥 Hot</option>
            <option value="warm">🌤 Warm</option>
            <option value="cold">🧊 Cold</option>
          </Select>
          <Select
            value={filters.status}
            onChange={(e) => set({ status: e.target.value })}
            className="w-32"
          >
            <option value="">Any status</option>
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </Select>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600">
            <input
              type="checkbox"
              checked={filters.stale}
              onChange={(e) => set({ stale: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-primary-600"
            />
            Stale only
          </label>
        </div>
      )}

      <TasksModal
        open={tasksOpen}
        onClose={() => setTasksOpen(false)}
        tasks={tasks}
        members={members}
        currentUserId={currentUserId}
      />
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-xs font-semibold transition-colors",
        active ? "bg-primary-600 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100",
      )}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

// ---- "My day" tasks modal --------------------------------------------------

function TasksModal({
  open,
  onClose,
  tasks,
  members,
  currentUserId,
}: {
  open: boolean;
  onClose: () => void;
  tasks: CrmTask[];
  members: MemberLite[];
  currentUserId?: string;
}) {
  const [mineOnly, setMineOnly] = React.useState(true);
  const memberName = new Map(members.map((m) => [m.id, m.full_name || m.username]));

  const visible = tasks
    .filter((t) => !mineOnly || !currentUserId || !t.assigned_to || t.assigned_to === currentUserId)
    .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));

  async function handleToggle(task: CrmTask) {
    const res = await toggleCrmTask(task.id, task.status !== "done");
    if (!res.ok) toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Follow-ups — my day"
      description="Open CRM tasks, overdue first. Tasks are created from lead pages and by automations."
      size="lg"
    >
      <div className="space-y-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(e) => setMineOnly(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-primary-600"
          />
          Only mine / unassigned
        </label>

        {visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
            <ListChecks className="mx-auto mb-2 h-5 w-5" />
            All clear — no open follow-ups.
          </p>
        ) : (
          <div className="max-h-96 space-y-1.5 overflow-y-auto">
            {visible.map((task) => {
              const overdue = task.due_at && new Date(task.due_at).getTime() < Date.now();
              return (
                <div
                  key={task.id}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-3 py-2.5",
                    overdue ? "border-rose-200 bg-rose-50/50" : "border-slate-100 bg-white",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => handleToggle(task)}
                    className="h-4 w-4 rounded border-slate-300 text-primary-600"
                    aria-label="Mark done"
                  />
                  <div className="min-w-0 flex-1">
                    {task.lead_id ? (
                      <Link
                        href={`/crm/lead/${task.lead_id}`}
                        className="block truncate text-sm font-medium text-slate-800 hover:text-primary-600"
                        onClick={onClose}
                      >
                        {task.title}
                      </Link>
                    ) : (
                      <p className="truncate text-sm font-medium text-slate-800">{task.title}</p>
                    )}
                    <p className="text-xs text-slate-400">
                      {task.due_at
                        ? `Due ${new Date(task.due_at).toLocaleDateString()}${overdue ? " — overdue" : ""}`
                        : "No due date"}
                      {task.assigned_to && ` · ${memberName.get(task.assigned_to) ?? "member"}`}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

// Re-exported for the board so segment deletion can live in settings later.
export { deleteSegment };
