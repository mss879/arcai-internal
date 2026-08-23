"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format, isBefore, startOfToday } from "date-fns";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  ChevronDown,
  Download,
  EyeOff,
  FileSpreadsheet,
  FileText,
  FolderKanban,
  History,
  MoreVertical,
  OctagonPause,
  Pencil,
  Plus,
  Receipt,
  Search,
  Smartphone,
  Trash2,
  Wallet,
  X,
} from "lucide-react";

import { AvatarStack } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { ProjectFormModal } from "@/components/projects/project-form-modal";
import {
  DELIVERY_STAGE_META,
  PROJECT_SORTS,
  PROJECT_STATUS_META,
  PROJECT_VIEW_MODES,
  SERVICE_TYPE_LABELS,
  type ProjectSort,
  type ProjectViewMode,
} from "@/lib/constants";
import {
  CalendarView,
  KanbanView,
  TableView,
  type BoardProject,
} from "@/components/projects/board-views";
import {
  MonthCloseCard,
  type MonthCloseFigures,
} from "@/components/projects/month-close-card";
import {
  downloadFile,
  projectsToCsv,
  type ExportRow,
} from "@/lib/project-export";
import {
  SavedViewsBar,
  type SavedViewRow,
} from "@/components/projects/saved-views-bar";
import { ProjectsSectionNav } from "@/components/projects/section-nav";
import {
  commissionEarned,
  daysSince,
  marginIsMeaningful,
  projectHealth,
  projectMargin,
  settledAmount,
  type ProjectHealth,
} from "@/lib/projects";
import { cn, formatCurrency } from "@/lib/utils";
import type { Client, DeliveryStage, Project, ProjectStatus } from "@/lib/types";

import {
  archiveProject,
  deleteProject,
  restoreProject,
  setProjectCarryForward,
} from "./actions";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";

/** Work that hasn't finished — the projects that carry into this month. */
const OPEN_STATUSES = new Set(["planning", "active", "on_hold"]);

/** Where the per-user board preferences live (VIEW-1). */
const PREFS_KEY = "arc:projects:prefs";

export type ProjectCard = Project & {
  client?: Pick<Client, "id" | "name" | "company"> | null;
  payments?: {
    id: string;
    amount: number;
    status: string;
    paid_at: string | null;
    method: string | null;
    notes: string | null;
  }[];
  /** Payments recorded on the Payments page against this project (0083). */
  company_payments?: {
    id: string;
    price_lkr: number;
    is_paid: boolean;
    created_at: string;
    company_name: string;
  }[];
};

type ExpenseRow = { project_id: string; amount: number; billable: boolean };
type TeamRow = {
  project_id: string;
  user_id: string;
  is_owner: boolean;
  profile: { id: string; full_name: string; avatar_url: string | null } | null;
};
type TaskRow = { project_id: string; status: string; due_date: string | null };
type AssetRow = { project_id: string; status: string; required: boolean };
type MilestoneRow = {
  project_id: string;
  status: string;
  due_date: string | null;
  kind: string;
};
type CommissionRow = {
  project_id: string | null;
  amount: number;
  percentage: number | null;
  basis: string;
};

/** Everything the card shows that isn't on the project row itself. */
type Derived = {
  received: number;
  balance: number;
  paidPercent: number;
  profit: number;
  marginPercent: number | null;
  health: ProjectHealth;
  team: TeamRow[];
  daysInStage: number | null;
};

type PlacedProject = {
  project: ProjectCard;
  derived: Derived;
  originKey: string;
  originLabel: string;
  carried: boolean;
  candidate: boolean;
};

type GroupItem = PlacedProject & { echo: boolean };

export function ProjectsView({
  projects,
  clients,
  expenses,
  team,
  tasks,
  assets,
  milestones,
  commissions,
  savedViews,
  isAdmin,
  showArchived,
}: {
  projects: ProjectCard[];
  clients: Pick<Client, "id" | "name" | "company">[];
  expenses: ExpenseRow[];
  team: TeamRow[];
  tasks: TaskRow[];
  assets: AssetRow[];
  milestones: MilestoneRow[];
  commissions: CommissionRow[];
  savedViews: SavedViewRow[];
  isAdmin: boolean;
  showArchived: boolean;
}) {
  useRealtimeSyncTables(["projects", "payments", "company_payments"]);

  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Project | null>(null);
  const [toDelete, setToDelete] = React.useState<Project | null>(null);
  const [toArchive, setToArchive] = React.useState<Project | null>(null);

  // ---- Filters (LOOP-7) --------------------------------------------------
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<ProjectStatus | "">("");
  const [stage, setStage] = React.useState<DeliveryStage | "">("");
  const [clientId, setClientId] = React.useState("");
  const [service, setService] = React.useState("");
  const [owing, setOwing] = React.useState(false);
  const [sort, setSort] = React.useState<ProjectSort>("recent");

  // ---- View mode (VIEW-1) -------------------------------------------------
  // Remembered per user in localStorage rather than a column: it is a device
  // preference, not workspace data, and it must not cost a round-trip on
  // every board load. Same pattern the todos board already uses.
  const [mode, setMode] = React.useState<ProjectViewMode>("board");
  const prefsLoaded = React.useRef(false);

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { mode?: string; sort?: string };
        if (PROJECT_VIEW_MODES.some((m) => m.value === p.mode))
          setMode(p.mode as ProjectViewMode);
        if (PROJECT_SORTS.some((sOpt) => sOpt.value === p.sort))
          setSort(p.sort as ProjectSort);
      }
    } catch {
      // storage may be unavailable
    }
    prefsLoaded.current = true;
  }, []);

  React.useEffect(() => {
    if (!prefsLoaded.current) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ mode, sort }));
    } catch {
      // storage may be unavailable
    }
  }, [mode, sort]);

  const filtersOn =
    query.trim() !== "" ||
    status !== "" ||
    stage !== "" ||
    clientId !== "" ||
    service !== "" ||
    owing;

  function clearFilters() {
    setQuery("");
    setStatus("");
    setStage("");
    setClientId("");
    setService("");
    setOwing(false);
  }

  /**
   * Applying a view sets every field, including the ones it left empty — a
   * saved view is a complete description of the board, not a patch over
   * whatever happened to be set already.
   */
  function applyView(view: SavedViewRow) {
    const f = view.filters ?? {};
    setQuery(f.query ?? "");
    setStatus((f.status as ProjectStatus) ?? "");
    setStage((f.stage as DeliveryStage) ?? "");
    setClientId(f.client_id ?? "");
    setService(f.service ?? "");
    setOwing(!!f.owing);
    if (PROJECT_SORTS.some((s2) => s2.value === f.sort))
      setSort(f.sort as ProjectSort);
    if (PROJECT_VIEW_MODES.some((m) => m.value === f.mode))
      setMode(f.mode as ProjectViewMode);
  }

  /** The board's filter state, in the shape a saved view stores. */
  const currentFilters = React.useMemo(
    () => ({
      query: query.trim() || undefined,
      status: status || undefined,
      stage: stage || undefined,
      client_id: clientId || undefined,
      service: service || undefined,
      owing: owing || undefined,
      sort: sort !== "recent" ? sort : undefined,
      mode: mode !== "board" ? mode : undefined,
    }),
    [query, status, stage, clientId, service, owing, sort, mode],
  );

  /**
   * Which saved view the board is showing — DERIVED, not tracked. Storing it
   * would mean remembering to clear it every time any one of eight filters
   * changed; comparing instead means nudging a dropdown deselects the pill on
   * its own, and re-creating the same filters by hand re-selects it.
   */
  const activeViewId = React.useMemo(() => {
    const keys = [
      "query",
      "status",
      "stage",
      "client_id",
      "service",
      "owing",
      "sort",
      "mode",
    ] as const;
    const match = savedViews.find((v) =>
      keys.every(
        (k) =>
          (v.filters?.[k] ?? undefined) ===
          (currentFilters[k] ?? undefined),
      ),
    );
    return match?.id ?? null;
  }, [savedViews, currentFilters]);

  // ---- Per-project derived numbers ---------------------------------------
  const byProject = React.useCallback(
    function group<T extends { project_id: string | null }>(rows: T[]) {
      const map = new Map<string, T[]>();
      for (const row of rows) {
        if (!row.project_id) continue;
        const list = map.get(row.project_id);
        if (list) list.push(row);
        else map.set(row.project_id, [row]);
      }
      return map;
    },
    [],
  );

  const derivedById = React.useMemo(() => {
    const expensesBy = byProject(expenses);
    const teamBy = byProject(team);
    const tasksBy = byProject(tasks);
    const assetsBy = byProject(assets);
    const milestonesBy = byProject(milestones);
    const commissionsBy = byProject(commissions);
    // startOfToday() rather than Date.now(): react-hooks/purity forbids the
    // impure global during render, and a task due later today isn't overdue.
    const now = startOfToday().getTime();

    const map = new Map<string, Derived>();
    for (const p of projects) {
      const received = settledAmount(p);
      const totalValue = Number(p.total_value) || 0;
      const balance = Math.max(0, totalValue - received);
      const projectExpenses = expensesBy.get(p.id) ?? [];

      const margin = projectMargin({
        totalValue,
        expenses: projectExpenses,
        commissions: (commissionsBy.get(p.id) ?? []).map((c) => ({
          amount: commissionEarned(c, received),
        })),
      });
      // Null unless something has actually been spent — see
      // marginIsMeaningful(). "100% margin" is an empty cost sheet, not a win.
      const shownMargin = marginIsMeaningful(margin) ? margin.percent : null;

      const projectTasks = tasksBy.get(p.id) ?? [];
      const projectMilestones = milestonesBy.get(p.id) ?? [];
      const delivered =
        p.delivery_stage === "delivered" || p.delivery_stage === "aftercare";

      map.set(p.id, {
        received,
        balance,
        paidPercent: totalValue
          ? Math.min(100, Math.round((received / totalValue) * 100))
          : 0,
        profit: margin.profit,
        marginPercent: shownMargin,
        team: teamBy.get(p.id) ?? [],
        daysInStage: p.delivery_stage
          ? daysSince(p.delivery_stage_changed_at)
          : null,
        health: projectHealth({
          status: p.status,
          deliveryStage: p.delivery_stage,
          stageChangedAt: p.delivery_stage_changed_at,
          updatedAt: p.updated_at,
          dueDate: p.due_date,
          blockedSince: p.blocked_since,
          assetsOutstanding: (assetsBy.get(p.id) ?? []).filter(
            (a) => a.status === "pending" && a.required,
          ).length,
          overdueTasks: projectTasks.filter(
            (t) =>
              t.status !== "done" &&
              t.due_date &&
              new Date(t.due_date).getTime() < now,
          ).length,
          overdueMilestones: projectMilestones.filter(
            (m) =>
              m.status !== "done" &&
              m.due_date &&
              new Date(`${m.due_date}T23:59:59`).getTime() < now,
          ).length,
          balance,
          daysSinceDelivered: delivered
            ? daysSince(p.delivery_stage_changed_at)
            : null,
          budget: Number(p.expense_cap ?? p.budget ?? 0) || null,
          spend: margin.expenses,
        }),
      });
    }
    return map;
  }, [projects, expenses, team, tasks, assets, milestones, commissions, byProject]);

  const derive = React.useCallback(
    (p: ProjectCard): Derived =>
      derivedById.get(p.id) ?? {
        received: 0,
        balance: 0,
        paidPercent: 0,
        profit: 0,
        marginPercent: null,
        health: { score: 100, tone: "good", reasons: [] },
        team: [],
        daysInStage: null,
      },
    [derivedById],
  );

  // ---- Filtering + sorting ------------------------------------------------
  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = projects.filter((p) => {
      if (status && p.status !== status) return false;
      if (stage && p.delivery_stage !== stage) return false;
      if (clientId && p.client_id !== clientId) return false;
      if (service && p.service_type !== service) return false;
      if (owing && derive(p).balance <= 0) return false;
      if (!q) return true;
      return [p.name, p.description, p.client?.name, p.client?.company]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q));
    });

    // Sorting only applies inside each month group; "recent" keeps the
    // server's created_at ordering, which the grouping relies on.
    if (sort === "recent") return filtered;
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "due":
          if (!a.due_date && !b.due_date) return 0;
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return a.due_date.localeCompare(b.due_date);
        case "value":
          return (Number(b.total_value) || 0) - (Number(a.total_value) || 0);
        case "balance":
          return derive(b).balance - derive(a).balance;
        case "health":
          return derive(a).health.score - derive(b).health.score;
        case "name":
          return a.name.localeCompare(b.name);
        default:
          return 0;
      }
    });
  }, [projects, query, status, stage, clientId, service, owing, sort, derive]);

  // ---- Headline numbers ---------------------------------------------------
  const activeCount = projects.filter((p) => p.status === "active").length;

  const getSumByCurrency = React.useCallback((list: ProjectCard[]) => {
    const sums: Record<string, number> = {};
    list.forEach((p) => {
      const val = Number(p.total_value) || 0;
      const curr = p.currency || "LKR";
      sums[curr] = (sums[curr] || 0) + val;
    });
    return sums;
  }, []);

  const totalSums = React.useMemo(
    () => getSumByCurrency(projects),
    [projects, getSumByCurrency],
  );

  const currentMonthKey = format(new Date(), "yyyy-MM");
  const currentMonthProjects = React.useMemo(
    () =>
      projects.filter((p) => {
        const date = p.created_at ? new Date(p.created_at) : new Date();
        return format(date, "yyyy-MM") === currentMonthKey;
      }),
    [projects, currentMonthKey],
  );
  const currentMonthSums = React.useMemo(
    () => getSumByCurrency(currentMonthProjects),
    [currentMonthProjects, getSumByCurrency],
  );

  /**
   * MON-12 — billable value sitting in work that hasn't moved in a fortnight.
   * Framing stalled projects as money is what actually gets them chased.
   */
  const stuckMoney = React.useMemo(() => {
    let total = 0;
    let count = 0;
    for (const p of projects) {
      if (!OPEN_STATUSES.has(p.status)) continue;
      const idle = daysSince(p.delivery_stage_changed_at ?? p.updated_at);
      if (idle === null || idle < 14) continue;
      const { balance } = derive(p);
      if (balance <= 0) continue;
      total += balance;
      count++;
    }
    return { total, count };
  }, [projects, derive]);

  /**
   * The filtered board, flattened for the kanban / table / calendar layouts
   * (VIEW-1). Built from the same `derive()` the cards use, so no layout can
   * ever show a different number for the same project.
   */
  const boardProjects = React.useMemo<BoardProject[]>(() => {
    const today = startOfToday();
    return visible.map((p) => {
      const d = derive(p);
      return {
        id: p.id,
        name: p.name,
        clientName: p.client?.name ?? null,
        status: p.status,
        stage: p.delivery_stage,
        serviceType: p.service_type,
        currency: p.currency || "LKR",
        totalValue: Number(p.total_value) || 0,
        received: d.received,
        balance: d.balance,
        marginPercent: d.marginPercent,
        health: d.health,
        dueDate: p.due_date,
        daysInStage: d.daysInStage,
        team: d.team
          .map((t) => t.profile)
          .filter((x): x is NonNullable<typeof x> => !!x),
        blocked: !!p.blocked_reason,
        overdue: Boolean(
          OPEN_STATUSES.has(p.status) &&
            p.due_date &&
            isBefore(new Date(p.due_date), today),
        ),
      };
    });
  }, [visible, derive]);

  const formatSums = (sums: Record<string, number>) => {
    const entries = Object.entries(sums);
    if (entries.length === 0) return formatCurrency(0, "LKR");
    return entries.map(([curr, val]) => formatCurrency(val, curr)).join(" + ");
  };

  const currentMonthLabel = format(new Date(), "MMMM yyyy");

  // ---- Export (VIEW-5) ----------------------------------------------------
  const [exporting, setExporting] = React.useState(false);

  /** A sentence describing what is on screen, printed on the PDF. */
  const filterSummary = React.useMemo(() => {
    const parts: string[] = [];
    if (query.trim()) parts.push(`matching "${query.trim()}"`);
    if (status) parts.push(PROJECT_STATUS_META[status].label);
    if (stage) parts.push(DELIVERY_STAGE_META[stage].label);
    if (clientId)
      parts.push(clients.find((c) => c.id === clientId)?.name ?? "one client");
    if (service)
      parts.push(
        SERVICE_TYPE_LABELS[service as keyof typeof SERVICE_TYPE_LABELS] ?? service,
      );
    if (owing) parts.push("with a balance due");
    return parts.length ? parts.join(" · ") : "All projects";
  }, [query, status, stage, clientId, service, owing, clients]);

  const exportRows = React.useCallback(
    (): ExportRow[] =>
      boardProjects.map((p) => ({
        name: p.name,
        client: p.clientName ?? "",
        status: PROJECT_STATUS_META[p.status].label,
        stage: p.stage ? DELIVERY_STAGE_META[p.stage].label : "",
        serviceType: p.serviceType
          ? (SERVICE_TYPE_LABELS[
              p.serviceType as keyof typeof SERVICE_TYPE_LABELS
            ] ?? p.serviceType)
          : "",
        currency: p.currency,
        totalValue: p.totalValue,
        received: p.received,
        balance: p.balance,
        // Members never see margin, so it never leaves in their export either.
        marginPercent: isAdmin ? p.marginPercent : null,
        dueDate: p.dueDate,
        team: p.team.map((m) => m.full_name).join(", "),
      })),
    [boardProjects, isAdmin],
  );

  function handleExportCsv() {
    const rows = exportRows();
    if (rows.length === 0) {
      toast.error("Nothing to export — no projects match the filters.");
      return;
    }
    downloadFile(
      `arc-ai-projects-${format(new Date(), "yyyy-MM-dd")}.csv`,
      projectsToCsv(rows, { includeMargin: isAdmin }),
      "text/csv;charset=utf-8",
    );
    toast.success(`Exported ${rows.length} project${rows.length === 1 ? "" : "s"}.`);
  }

  async function handleExportPdf() {
    const rows = exportRows();
    if (rows.length === 0) {
      toast.error("Nothing to export — no projects match the filters.");
      return;
    }
    setExporting(true);
    try {
      const res = await fetch("/api/projects/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, filterSummary }),
      });
      if (!res.ok) throw new Error(`Report failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ARC-AI-Projects-${format(new Date(), "yyyy-MM-dd")}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success("Report downloaded.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the report.");
    } finally {
      setExporting(false);
    }
  }

  // ---- Month grouping (0087) ---------------------------------------------
  const placed = React.useMemo<PlacedProject[]>(
    () =>
      visible.map((p) => {
        const date = p.created_at ? new Date(p.created_at) : new Date();
        const originKey = format(date, "yyyy-MM");
        const open = OPEN_STATUSES.has(p.status);
        const candidate = open && originKey < currentMonthKey;
        return {
          project: p,
          derived: derive(p),
          originKey,
          originLabel: format(date, "MMMM yyyy"),
          carried: candidate && p.carry_forward !== false,
          candidate,
        };
      }),
    [visible, currentMonthKey, derive],
  );

  const monthGroups = React.useMemo(() => {
    const map = new Map<string, GroupItem[]>();
    const push = (key: string, item: GroupItem) => {
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    };
    for (const item of placed) {
      push(item.originKey, { ...item, echo: false });
      if (item.carried) push(currentMonthKey, { ...item, echo: true });
    }
    return [...map.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([key, items]) => ({
        key,
        label: format(new Date(`${key}-01T00:00:00`), "MMMM yyyy"),
        items,
        carriedCount: items.filter((i) => i.echo).length,
      }));
  }, [placed, currentMonthKey]);

  /**
   * VIEW-4 — the six numbers that close a month, per month group.
   *
   * Deliberately computed over the month a project was BOOKED (its own group,
   * echoes excluded), because "how did March go" is a question about the work
   * March brought in, not about what happens to be on screen under March.
   */
  const closeByMonth = React.useMemo(() => {
    const map = new Map<string, MonthCloseFigures>();
    for (const item of placed) {
      const p = item.project;
      const d = item.derived;
      const value = Number(p.total_value) || 0;
      const delivered =
        p.delivery_stage === "delivered" || p.delivery_stage === "aftercare";

      const prev =
        map.get(item.originKey) ??
        ({
          bookedCount: 0,
          bookedValue: 0,
          deliveredCount: 0,
          deliveredValue: 0,
          collected: 0,
          owed: 0,
          carriedCount: 0,
          marginPercent: null,
          profit: 0,
          currency: p.currency || "LKR",
        } satisfies MonthCloseFigures);

      map.set(item.originKey, {
        ...prev,
        bookedCount: prev.bookedCount + 1,
        bookedValue: prev.bookedValue + value,
        deliveredCount: prev.deliveredCount + (delivered ? 1 : 0),
        deliveredValue: prev.deliveredValue + (delivered ? value : 0),
        collected: prev.collected + d.received,
        owed: prev.owed + d.balance,
        carriedCount: prev.carriedCount + (item.carried ? 1 : 0),
        profit: prev.profit + d.profit,
      });
    }

    // Margin is a ratio, so it is worked out once per month at the end rather
    // than accumulated — and stays null when nothing has been spent, for the
    // same reason a single project's does (marginIsMeaningful).
    for (const [key, fig] of map) {
      const anyMargin = placed.some(
        (i) => i.originKey === key && i.derived.marginPercent !== null,
      );
      map.set(key, {
        ...fig,
        marginPercent:
          anyMargin && fig.bookedValue > 0
            ? Math.round((fig.profit / fig.bookedValue) * 100)
            : null,
      });
    }
    return map;
  }, [placed]);

  const toggleCarryForward = async (item: PlacedProject) => {
    const next = !item.carried;
    const res = await setProjectCarryForward(item.project.id, next);
    if (res.ok) {
      toast.success(
        next
          ? `Now also showing under ${currentMonthLabel}`
          : `Only showing under ${item.originLabel}`,
      );
      router.refresh();
    } else {
      toast.error(res.error);
    }
  };

  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const isOpen = (key: string, isFirst: boolean) =>
    collapsed[key] === undefined ? isFirst : !collapsed[key];
  const toggleMonth = (key: string, isFirst: boolean) =>
    setCollapsed((prev) => ({ ...prev, [key]: isOpen(key, isFirst) }));

  // ---- Card ---------------------------------------------------------------
  const renderCard = (item: GroupItem, groupKey: string) => {
    const p = item.project;
    const d = item.derived;
    const totalValue = Number(p.total_value) || 0;
    const overdue =
      OPEN_STATUSES.has(p.status) &&
      p.due_date &&
      isBefore(new Date(p.due_date), startOfToday());

    return (
      <div
        key={`${groupKey}:${p.id}`}
        className={cn(
          "group relative flex flex-col rounded-2xl border p-5 shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-lift)]",
          item.echo
            ? "border-amber-200/70 bg-amber-50/40"
            : "border-slate-200/80 bg-white",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge className={PROJECT_STATUS_META[p.status].badge}>
              {PROJECT_STATUS_META[p.status].label}
            </Badge>
            {p.delivery_stage && (
              <Badge className={DELIVERY_STAGE_META[p.delivery_stage].badge}>
                {DELIVERY_STAGE_META[p.delivery_stage].label}
                {d.daysInStage !== null && d.daysInStage > 0 && (
                  <span className="opacity-70"> · {d.daysInStage}d</span>
                )}
              </Badge>
            )}
            {p.blocked_reason && (
              <Badge
                className="bg-amber-100/80 text-amber-800 ring-amber-300/70"
                title={p.blocked_reason}
              >
                <OctagonPause className="h-3 w-3" />
                Blocked
              </Badge>
            )}
            {item.echo && (
              <Badge
                className="bg-amber-100/80 text-amber-800 ring-amber-300/70"
                title={`Still open, so it also shows here. Its own card is still under ${item.originLabel}.`}
              >
                <History className="h-3 w-3" />
                From {item.originLabel}
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
            {showArchived ? (
              <DropdownItem
                icon={<ArchiveRestore className="h-4 w-4" />}
                onClick={async () => {
                  const res = await restoreProject(p.id);
                  if (res.ok) {
                    toast.success("Project restored");
                    router.refresh();
                  } else toast.error(res.error);
                }}
              >
                Restore
              </DropdownItem>
            ) : (
              <>
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
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <CalendarClock className="h-4 w-4" />
                      )
                    }
                    onClick={() => toggleCarryForward(item)}
                  >
                    {item.carried
                      ? `Stop showing under ${currentMonthLabel}`
                      : `Also show under ${currentMonthLabel}`}
                  </DropdownItem>
                )}
                <DropdownItem
                  icon={<Archive className="h-4 w-4" />}
                  onClick={() => setToArchive(p)}
                >
                  Archive
                </DropdownItem>
              </>
            )}
            <DropdownItem
              destructive
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => setToDelete(p)}
            >
              Delete forever
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

        {/* What's wrong with it, in words — the risk radar's own sentence
            when last night's pass wrote one (AI-4), otherwise the health
            engine's terser reason (PLAN-8). */}
        {(p.risk_note || d.health.reasons.length > 0) && (
          <p
            className={cn(
              "mt-3 inline-flex items-start gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium",
              d.health.tone === "risk"
                ? "bg-rose-50 text-rose-700"
                : "bg-amber-50 text-amber-700",
            )}
            title={d.health.reasons.join(" · ") || undefined}
          >
            <span
              className={cn(
                "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                d.health.tone === "risk" ? "bg-rose-500" : "bg-amber-500",
              )}
            />
            {p.risk_note ?? d.health.reasons[0]}
            {!p.risk_note && d.health.reasons.length > 1
              ? ` +${d.health.reasons.length - 1} more`
              : ""}
          </p>
        )}

        <div className="mt-4">
          <div className="flex items-end justify-between gap-2 text-sm">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Received
              </p>
              <span className="inline-flex items-center gap-1.5 font-semibold tabular-nums text-slate-900">
                <Wallet className="h-4 w-4 text-emerald-500" />
                {formatCurrency(d.received, p.currency)}
              </span>
            </div>
            <div className="text-right">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Balance due
              </p>
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  d.balance > 0 ? "text-amber-600" : "text-emerald-600",
                )}
              >
                {formatCurrency(d.balance, p.currency)}
              </span>
            </div>
          </div>
          {totalValue ? (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    d.paidPercent >= 100 ? "bg-emerald-500" : "bg-primary-500",
                  )}
                  style={{ width: `${d.paidPercent}%` }}
                />
              </div>
              <p className="mt-1.5 flex items-center justify-between text-xs text-slate-400">
                <span>
                  {formatCurrency(d.received, p.currency)} of{" "}
                  {formatCurrency(totalValue, p.currency)}
                </span>
                {isAdmin && d.marginPercent !== null && (
                  <span
                    className={cn(
                      "font-semibold",
                      d.marginPercent < 0
                        ? "text-rose-600"
                        : d.marginPercent < 25
                          ? "text-amber-600"
                          : "text-emerald-600",
                    )}
                    title={`Profit ${formatCurrency(d.profit, p.currency)}`}
                  >
                    {d.marginPercent}% margin
                  </span>
                )}
              </p>
            </>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
          <div className="flex items-center gap-2">
            {d.team.length > 0 && (
              <AvatarStack
                people={d.team
                  .map((t) => t.profile)
                  .filter(Boolean)
                  .map((p) => ({
                    id: p!.id,
                    full_name: p!.full_name,
                    avatar_url: p!.avatar_url,
                  }))}
                size="xs"
              />
            )}
            {overdue && p.due_date && (
              <span className="text-[11px] font-semibold text-rose-500">
                Due {format(new Date(p.due_date), "d MMM")}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {p.proposal_url && (
              <a
                href={p.proposal_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-white hover:text-primary-700"
              >
                <FileText className="h-3 w-3" /> Proposal
              </a>
            )}
            {p.invoice_url && (
              <a
                href={p.invoice_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-white hover:text-primary-700"
              >
                <Receipt className="h-3 w-3" /> Invoice
              </a>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={showArchived ? "Archived projects" : "Projects"}
        description={
          showArchived
            ? "Hidden from every board, but nothing has been deleted."
            : "Plan projects, track payments and allocate commissions."
        }
        actions={
          showArchived ? (
            <Link href="/projects">
              <Button variant="outline">Back to the board</Button>
            </Link>
          ) : (
            <div className="flex flex-wrap gap-2">
              {/* BIG-5 — the phone-shaped view, offered only where it wins.
                  Insights, Reports and Templates live in the section nav
                  below the header rather than as more buttons up here. */}
              <Link href="/projects/go" className="sm:hidden">
                <Button variant="outline">
                  <Smartphone className="h-4 w-4" /> On the go
                </Button>
              </Link>
              <Dropdown
                trigger={
                  <Button variant="outline" loading={exporting}>
                    <Download className="h-4 w-4" /> Export
                  </Button>
                }
              >
                <DropdownItem onClick={handleExportCsv}>
                  <FileSpreadsheet className="h-4 w-4" /> CSV for the accountant
                </DropdownItem>
                <DropdownItem onClick={handleExportPdf}>
                  <FileText className="h-4 w-4" /> Branded PDF report
                </DropdownItem>
              </Dropdown>
              <Link href="/projects?archived=1">
                <Button variant="outline">
                  <Archive className="h-4 w-4" /> Archive
                </Button>
              </Link>
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New project
              </Button>
            </div>
          )
        }
      />

      {projects.length > 0 && !showArchived && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label="Active projects" value={String(activeCount)} delay={0} />
          <StatTile label="Total value" value={formatSums(totalSums)} delay={150} />
          <StatTile
            label={`Started in ${currentMonthLabel}`}
            value={formatSums(currentMonthSums)}
            delay={300}
          />
          <StatTile
            label="Cash stuck"
            value={formatCurrency(stuckMoney.total, "LKR")}
            hint={
              stuckMoney.count > 0
                ? `${stuckMoney.count} project${stuckMoney.count === 1 ? "" : "s"} idle 14+ days`
                : "Nothing sitting still"
            }
            tone={stuckMoney.total > 0 ? "amber" : undefined}
            delay={450}
          />
        </div>
      )}

      {/* One nav for the whole section — Board · Insights · Reports · Templates */}
      {!showArchived && <ProjectsSectionNav />}

      {/* How the board itself is laid out (VIEW-1) */}
      {projects.length > 0 && !showArchived && (
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <div className="inline-flex min-w-max items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
            {PROJECT_VIEW_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMode(m.value)}
                title={m.hint}
                aria-pressed={mode === m.value}
                className={cn(
                  "rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors",
                  mode === m.value
                    ? "bg-primary-600 text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100",
                )}
              >
                {m.label}
              </button>
            ))}
            {/* PLAN-6 already draws the timeline on the reports page; drawing
                it a second time here would be two implementations of one
                chart, so the switcher links to the one that exists. */}
            <Link
              href="/projects/reports?tab=timeline"
              className="rounded-lg px-3.5 py-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100"
              title="Start and due dates drawn across every project"
            >
              Timeline ↗
            </Link>
          </div>
        </div>
      )}

      {/* Saved views (VIEW-2) */}
      {projects.length > 0 && !showArchived && (
        <SavedViewsBar
          views={savedViews}
          current={currentFilters}
          activeId={activeViewId}
          canSave={filtersOn || sort !== "recent" || mode !== "board"}
          onApply={applyView}
          onClear={clearFilters}
        />
      )}

      {/* Filters (LOOP-7) */}
      {projects.length > 0 && (
        <div className="rounded-2xl border border-slate-200/80 bg-white/70 p-3 shadow-[var(--shadow-card)] backdrop-blur-sm">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects and clients"
                className="pl-9"
              />
            </div>

            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as ProjectStatus | "")}
              className="w-auto"
            >
              <option value="">Any status</option>
              {(Object.keys(PROJECT_STATUS_META) as ProjectStatus[]).map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_META[s].label}
                </option>
              ))}
            </Select>

            <Select
              value={stage}
              onChange={(e) => setStage(e.target.value as DeliveryStage | "")}
              className="w-auto"
            >
              <option value="">Any stage</option>
              {(Object.keys(DELIVERY_STAGE_META) as DeliveryStage[]).map((s) => (
                <option key={s} value={s}>
                  {DELIVERY_STAGE_META[s].label}
                </option>
              ))}
            </Select>

            <Select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-auto"
            >
              <option value="">Any client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>

            <Select
              value={service}
              onChange={(e) => setService(e.target.value)}
              className="w-auto"
            >
              <option value="">Any service</option>
              {Object.entries(SERVICE_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>

            <button
              type="button"
              onClick={() => setOwing((v) => !v)}
              className={cn(
                "h-10 rounded-xl px-3 text-sm font-medium transition",
                owing
                  ? "bg-amber-500 text-white shadow-sm"
                  : "bg-slate-50 text-slate-600 hover:bg-slate-100",
              )}
            >
              Owes money
            </button>

            <Select
              value={sort}
              onChange={(e) => setSort(e.target.value as ProjectSort)}
              className="w-auto"
            >
              {PROJECT_SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>

            {filtersOn && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="h-4 w-4" /> Clear
              </Button>
            )}
          </div>

          {filtersOn && (
            <p className="mt-2 px-1 text-xs text-slate-400">
              {visible.length} of {projects.length} project
              {projects.length === 1 ? "" : "s"} match.
            </p>
          )}
        </div>
      )}

      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="h-6 w-6" />}
          title={showArchived ? "Nothing archived" : "No projects yet"}
          description={
            showArchived
              ? "Archived projects will show up here, with everything they carry."
              : "Create your first project to start tracking work and payments."
          }
          action={
            showArchived ? undefined : (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New project
              </Button>
            )
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Search className="h-6 w-6" />}
          title="Nothing matches"
          description="Try a different search or clear the filters."
          action={<Button onClick={clearFilters}>Clear filters</Button>}
        />
      ) : mode === "kanban" ? (
        <KanbanView projects={boardProjects} />
      ) : mode === "table" ? (
        <TableView projects={boardProjects} showMargin={isAdmin} />
      ) : mode === "calendar" ? (
        <CalendarView projects={boardProjects} />
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
                        + {group.carriedCount} carried over from earlier months
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
                  <>
                    {/* VIEW-4 — how the month actually closed. Only on groups
                        that booked something: an echo-only month has nothing
                        of its own to close. */}
                    {closeByMonth.has(group.key) && (
                      <div className="border-t border-slate-200/60 px-5 pt-4">
                        <MonthCloseCard
                          figures={closeByMonth.get(group.key)!}
                          showMargin={isAdmin}
                        />
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-4 border-t border-slate-200/60 p-5 sm:grid-cols-2 xl:grid-cols-3">
                      {group.items.map((item) => renderCard(item, group.key))}
                    </div>
                  </>
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
        open={!!toArchive}
        onClose={() => setToArchive(null)}
        title="Archive project"
        description={`"${toArchive?.name}" comes off every board. Its payments, expenses, commissions and history all stay — you can restore it any time.`}
        onConfirm={async () => {
          if (!toArchive) return;
          const res = await archiveProject(toArchive.id);
          if (res.ok) {
            toast.success("Project archived");
            router.refresh();
          } else toast.error(res.error);
        }}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete forever"
        description={`This permanently destroys "${toDelete?.name}" along with its payments, expenses, asset requests and delivery history. Archive it instead unless it was created by mistake.`}
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

function StatTile({
  label,
  value,
  hint,
  tone,
  delay,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "amber";
  delay: number;
}) {
  return (
    <div className="animate-continuous-float" style={{ animationDelay: `${delay}ms` }}>
      <div
        className={cn(
          "group rounded-2xl border border-white/30 bg-gradient-to-br from-white/60 to-white/25 p-5 shadow-sm backdrop-blur-xl transition-all duration-300 ease-out hover:-translate-y-1 hover:scale-[1.01] hover:from-white/75 hover:to-white/40 hover:shadow-md",
          tone === "amber" ? "hover:border-amber-400" : "hover:border-primary-400",
        )}
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          {label}
        </p>
        <p
          className={cn(
            "mt-2 text-2xl font-extrabold tracking-tight tabular-nums",
            tone === "amber" ? "text-amber-600" : "text-slate-800",
          )}
        >
          {value}
        </p>
        {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
      </div>
    </div>
  );
}
