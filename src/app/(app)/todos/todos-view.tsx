"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  differenceInCalendarDays,
  format,
  isPast,
  isToday,
  subDays,
} from "date-fns";
import { toast } from "sonner";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  CalendarClock,
  Check,
  CheckSquare,
  ChevronDown,
  FolderKanban,
  KanbanSquare,
  LayoutList,
  ListChecks,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { MentionText } from "@/components/ui/mention-text";
import { PageHeader } from "@/components/ui/page-header";
import { TodoFormModal } from "@/components/todos/todo-form-modal";
import {
  dueMeta,
  SortableTodoCard,
  TodoCardContent,
} from "@/components/todos/todo-card";
import { PRIORITY_META, TODO_STATUS_META } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type {
  MemberLite,
  TodoPriority,
  TodoStatus,
  TodoSubtask,
  TodoWithRelations,
} from "@/lib/types";

import {
  deleteTodo,
  saveTodo,
  setSubtaskDone,
  setTodoStatus,
  updateTodoPositions,
} from "./actions";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";

type ProjectLite = { id: string; name: string };
type ViewMode = "list" | "board";
type SortKey = "smart" | "due" | "newest";
type Bucket = "overdue" | "today" | "week" | "later" | "nodate" | "done";

const PREFS_KEY = "arc:todoPrefs";

const STATUS_TABS: { key: TodoStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: "smart", label: "Priority" },
  { key: "due", label: "Due date" },
  { key: "newest", label: "Newest" },
];

const BOARD_COLUMNS: TodoStatus[] = ["todo", "in_progress", "done"];

const BUCKETS: { key: Bucket; label: string; tone: string }[] = [
  { key: "overdue", label: "Overdue", tone: "text-rose-600" },
  { key: "today", label: "Today", tone: "text-primary-700" },
  { key: "week", label: "This week", tone: "text-slate-700" },
  { key: "later", label: "Later", tone: "text-slate-700" },
  { key: "nodate", label: "No date", tone: "text-slate-500" },
  { key: "done", label: "Completed", tone: "text-emerald-700" },
];

function getBucket(t: TodoWithRelations): Bucket {
  if (t.status === "done") return "done";
  if (!t.due_date) return "nodate";
  const d = new Date(t.due_date);
  if (isToday(d)) return "today";
  if (isPast(d)) return "overdue";
  return differenceInCalendarDays(d, new Date()) <= 6 ? "week" : "later";
}

const selectCls =
  "h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 shadow-sm transition focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100";

export function TodosView({
  todos,
  members,
  projects = [],
  currentUserId = null,
}: {
  todos: TodoWithRelations[];
  members: MemberLite[];
  projects?: ProjectLite[];
  currentUserId?: string | null;
}) {
  useRealtimeSyncTables(["todos", "todo_subtasks"]);

  const router = useRouter();
  const [tasks, setTasks] = React.useState(todos);
  React.useEffect(() => setTasks(todos), [todos]);

  // --- Persisted preferences --------------------------------------
  const [view, setView] = React.useState<ViewMode>("list");
  const [statusFilter, setStatusFilter] = React.useState<TodoStatus | "all">(
    "all",
  );
  const [sort, setSort] = React.useState<SortKey>("smart");
  const [mine, setMine] = React.useState(false);
  const loadedRef = React.useRef(false);

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.view === "list" || p.view === "board") setView(p.view);
        if (p.statusFilter) setStatusFilter(p.statusFilter);
        if (p.sort) setSort(p.sort);
        if (typeof p.mine === "boolean") setMine(p.mine);
      }
    } catch {
      // ignore malformed prefs
    }
    loadedRef.current = true;
  }, []);

  React.useEffect(() => {
    if (!loadedRef.current) return;
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ view, statusFilter, sort, mine }),
      );
    } catch {
      // storage may be unavailable
    }
  }, [view, statusFilter, sort, mine]);

  // --- Ephemeral filters ------------------------------------------
  const [search, setSearch] = React.useState("");
  const [assigneeF, setAssigneeF] = React.useState("");
  const [priorityF, setPriorityF] = React.useState<TodoPriority | "">("");
  const [projectF, setProjectF] = React.useState("");

  // --- Selection (list bulk actions) ------------------------------
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = React.useState(false);

  // --- Collapsible buckets ----------------------------------------
  const [collapsed, setCollapsed] = React.useState<Partial<Record<Bucket, boolean>>>(
    { done: true },
  );

  // --- Modals -----------------------------------------------------
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<TodoWithRelations | null>(null);
  const [toDelete, setToDelete] = React.useState<TodoWithRelations | null>(null);

  // --- Quick add --------------------------------------------------
  const [quickTitle, setQuickTitle] = React.useState("");
  const [quickPending, startQuick] = React.useTransition();

  // --- Derived: stats (from all tasks) ----------------------------
  const stats = React.useMemo(() => {
    const weekAgo = subDays(new Date(), 7);
    let open = 0,
      overdue = 0,
      today = 0,
      doneWeek = 0;
    for (const t of tasks) {
      if (t.status !== "done") {
        open++;
        if (t.due_date) {
          const d = new Date(t.due_date);
          if (isToday(d)) today++;
          else if (isPast(d)) overdue++;
        }
      } else if (t.completed_at && new Date(t.completed_at) >= weekAgo) {
        doneWeek++;
      }
    }
    return { open, overdue, today, doneWeek };
  }, [tasks]);

  // --- Derived: base filtered set (search + facets, NOT status) ---
  const base = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (q) {
        const hay = `${t.title} ${t.description ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (assigneeF && t.assigned_to !== assigneeF) return false;
      if (priorityF && t.priority !== priorityF) return false;
      if (projectF && t.project_id !== projectF) return false;
      if (mine && t.assigned_to !== currentUserId) return false;
      return true;
    });
  }, [tasks, search, assigneeF, priorityF, projectF, mine, currentUserId]);

  const taskMap = React.useMemo(() => {
    const m: Record<string, TodoWithRelations> = {};
    for (const t of tasks) m[t.id] = t;
    return m;
  }, [tasks]);

  const sortTasks = React.useCallback(
    (arr: TodoWithRelations[]) => {
      const time = (t: TodoWithRelations) =>
        t.due_date ? new Date(t.due_date).getTime() : Infinity;
      return [...arr].sort((a, b) => {
        if (sort === "newest")
          return (
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
        if (sort === "due" && time(a) !== time(b)) return time(a) - time(b);
        const po =
          PRIORITY_META[a.priority].order - PRIORITY_META[b.priority].order;
        if (po !== 0) return po;
        return time(a) - time(b);
      });
    },
    [sort],
  );

  // --- Derived: list groups (buckets) -----------------------------
  const listGroups = React.useMemo(() => {
    const visible = base.filter(
      (t) => statusFilter === "all" || t.status === statusFilter,
    );
    return BUCKETS.map((b) => ({
      ...b,
      tasks: sortTasks(visible.filter((t) => getBucket(t) === b.key)),
    })).filter((g) => g.tasks.length > 0);
  }, [base, statusFilter, sortTasks]);

  // --- Board columns (status -> ordered ids) ----------------------
  const buildCols = React.useCallback(() => {
    const next: Record<string, string[]> = {
      todo: [],
      in_progress: [],
      done: [],
    };
    for (const t of base) if (next[t.status]) next[t.status].push(t.id);
    for (const key of BOARD_COLUMNS) {
      next[key].sort((a, b) => {
        const pa = taskMap[a]?.position ?? 0;
        const pb = taskMap[b]?.position ?? 0;
        if (pa !== pb) return pa - pb;
        return (
          new Date(taskMap[b]?.created_at ?? 0).getTime() -
          new Date(taskMap[a]?.created_at ?? 0).getTime()
        );
      });
    }
    return next;
  }, [base, taskMap]);

  const [cols, setColsState] = React.useState<Record<string, string[]>>(buildCols);
  const colsRef = React.useRef(cols);
  React.useEffect(() => {
    const next = buildCols();
    setColsState(next);
    colsRef.current = next;
  }, [buildCols]);
  const setCols = React.useCallback((next: Record<string, string[]>) => {
    colsRef.current = next;
    setColsState(next);
  }, []);

  const [activeId, setActiveId] = React.useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function findContainer(id: string): string | undefined {
    if (id in colsRef.current) return id;
    return Object.keys(colsRef.current).find((key) =>
      colsRef.current[key].includes(id),
    );
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function onDragOver(e: DragOverEvent) {
    const aId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    const from = findContainer(aId);
    const to = findContainer(overId);
    if (!from || !to || from === to) return;

    const current = colsRef.current;
    const toItems = current[to];
    const newIndex =
      overId in current ? toItems.length : Math.max(0, toItems.indexOf(overId));
    setCols({
      ...current,
      [from]: current[from].filter((id) => id !== aId),
      [to]: [...toItems.slice(0, newIndex), aId, ...toItems.slice(newIndex)],
    });
  }

  async function onDragEnd(e: DragEndEvent) {
    const aId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    setActiveId(null);
    if (!overId) return;

    const from = findContainer(aId);
    const to = findContainer(overId);
    if (!from || !to) return;

    if (from === to) {
      const list = colsRef.current[from];
      const oldIndex = list.indexOf(aId);
      const newIndex =
        overId in colsRef.current ? list.length - 1 : list.indexOf(overId);
      if (oldIndex !== newIndex && newIndex >= 0) {
        setCols({ ...colsRef.current, [from]: arrayMove(list, oldIndex, newIndex) });
      }
    }

    const affected = Array.from(new Set([from, to]));
    // Optimistically reflect the new status locally.
    setTasks((prev) =>
      prev.map((t) => {
        const colKey = affected.find((c) => colsRef.current[c].includes(t.id));
        return colKey && colKey !== t.status
          ? ({ ...t, status: colKey as TodoStatus } as TodoWithRelations)
          : t;
      }),
    );
    const updates = affected.flatMap((status) =>
      colsRef.current[status].map((id, index) => ({
        id,
        status: status as TodoStatus,
        position: index,
      })),
    );
    const res = await updateTodoPositions(updates);
    if (!res.ok) {
      toast.error("Couldn't save changes");
      router.refresh();
    }
  }

  // --- Actions ----------------------------------------------------
  async function toggle(t: TodoWithRelations) {
    const next: TodoStatus = t.status === "done" ? "todo" : "done";
    setTasks((prev) =>
      prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)),
    );
    const res = await setTodoStatus(t.id, next);
    if (!res.ok) {
      toast.error(res.error);
      setTasks(todos);
    } else {
      router.refresh();
    }
  }

  async function handleStatusChange(
    t: TodoWithRelations,
    targetStatus: TodoStatus,
  ) {
    const next: TodoStatus = t.status === targetStatus ? "todo" : targetStatus;
    setTasks((prev) =>
      prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)),
    );
    const res = await setTodoStatus(t.id, next);
    if (!res.ok) {
      toast.error(res.error);
      setTasks(todos);
    } else {
      router.refresh();
    }
  }

  function toggleSubtask(st: TodoSubtask) {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === st.todo_id
          ? {
              ...t,
              subtasks: (t.subtasks ?? []).map((s) =>
                s.id === st.id ? { ...s, is_done: !s.is_done } : s,
              ),
            }
          : t,
      ),
    );
    setSubtaskDone(st.id, !st.is_done).then((res) => {
      if (!res.ok) {
        toast.error(res.error);
        router.refresh();
      }
    });
  }

  function quickAdd() {
    const title = quickTitle.trim();
    if (!title) return;
    startQuick(async () => {
      const res = await saveTodo({ title, project_id: projectF || null });
      if (res.ok) {
        setQuickTitle("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function bulkMarkDone() {
    const ids = [...selected];
    if (!ids.length) return;
    setTasks((prev) =>
      prev.map((t) => (selected.has(t.id) ? { ...t, status: "done" } : t)),
    );
    await Promise.all(ids.map((id) => setTodoStatus(id, "done")));
    setSelected(new Set());
    setSelectMode(false);
    toast.success(`${ids.length} marked done`);
    router.refresh();
  }

  async function bulkDeleteConfirmed() {
    const ids = [...selected];
    await Promise.all(ids.map((id) => deleteTodo(id)));
    setSelected(new Set());
    setSelectMode(false);
    setBulkDeleting(false);
    toast.success(`${ids.length} deleted`);
    router.refresh();
  }

  function toggleCollapse(key: Bucket) {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const hasFilters =
    !!search || !!assigneeF || !!priorityF || !!projectF || mine;
  const activeTask = activeId ? taskMap[activeId] : null;

  // --- Render -----------------------------------------------------
  return (
    <div className="space-y-5">
      <PageHeader
        title="To-Dos"
        description="Shared tasks with priority, @mentions and calendar due dates."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New task
          </Button>
        }
      />

      {/* Stats */}
      {tasks.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Open" value={stats.open} />
          <StatCard
            label="Overdue"
            value={stats.overdue}
            tone={stats.overdue ? "rose" : "slate"}
          />
          <StatCard label="Due today" value={stats.today} tone="primary" />
          <StatCard label="Done this week" value={stats.doneWeek} tone="emerald" />
        </div>
      )}

      {/* Toolbar */}
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks…"
              className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-primary-400 focus:outline-none focus:ring-4 focus:ring-primary-100"
            />
          </div>
          <div className="inline-flex shrink-0 rounded-xl border border-slate-200 bg-white p-1">
            <ViewButton
              active={view === "list"}
              onClick={() => setView("list")}
              icon={<LayoutList className="h-4 w-4" />}
              label="List"
            />
            <ViewButton
              active={view === "board"}
              onClick={() => setView("board")}
              icon={<KanbanSquare className="h-4 w-4" />}
              label="Board"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {view === "list" && (
            <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
              {STATUS_TABS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                    statusFilter === f.key
                      ? "bg-primary-600 text-white shadow-sm"
                      : "text-slate-500 hover:text-slate-800",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          <button
            onClick={() => setMine((v) => !v)}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition",
              mine
                ? "border-primary-300 bg-primary-50 text-primary-700"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            <Avatar name="Me" size="xs" /> Assigned to me
          </button>

          <select
            value={assigneeF}
            onChange={(e) => setAssigneeF(e.target.value)}
            className={selectCls}
          >
            <option value="">Anyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name || m.username}
              </option>
            ))}
          </select>

          <select
            value={priorityF}
            onChange={(e) => setPriorityF(e.target.value as TodoPriority | "")}
            className={selectCls}
          >
            <option value="">Any priority</option>
            {(["urgent", "high", "medium", "low"] as TodoPriority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_META[p].label}
              </option>
            ))}
          </select>

          {projects.length > 0 && (
            <select
              value={projectF}
              onChange={(e) => setProjectF(e.target.value)}
              className={selectCls}
            >
              <option value="">Any project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          {view === "list" && (
            <>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className={selectCls}
                title="Sort within each group"
              >
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    Sort: {s.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  setSelectMode((v) => !v);
                  setSelected(new Set());
                }}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition",
                  selectMode
                    ? "border-primary-300 bg-primary-50 text-primary-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                )}
              >
                <CheckSquare className="h-3.5 w-3.5" /> Select
              </button>
            </>
          )}

          {hasFilters && (
            <button
              onClick={() => {
                setSearch("");
                setAssigneeF("");
                setPriorityF("");
                setProjectF("");
                setMine(false);
              }}
              className="inline-flex h-9 items-center rounded-lg px-2.5 text-xs font-medium text-slate-400 hover:text-slate-700"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Quick add */}
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
        <Plus className="h-4 w-4 shrink-0 text-slate-400" />
        <input
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") quickAdd();
          }}
          placeholder="Add a task and press Enter…"
          className="flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
        />
        {quickTitle.trim() && (
          <Button size="sm" onClick={quickAdd} loading={quickPending}>
            Add
          </Button>
        )}
      </div>

      {/* Bulk action bar */}
      {selectMode && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary-200 bg-primary-50 px-3 py-2 text-sm">
          <span className="font-semibold text-primary-700">
            {selected.size} selected
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={bulkMarkDone}>
              <Check className="h-4 w-4" /> Mark done
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBulkDeleting(true)}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </div>
        </div>
      )}

      {/* Empty / content */}
      {tasks.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="h-6 w-6" />}
          title="Nothing here yet"
          description="Create a task and assign it to a teammate."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New task
            </Button>
          }
        />
      ) : view === "board" ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
        >
          <div className="flex gap-4 overflow-x-auto pb-4">
            {BOARD_COLUMNS.map((status) => {
              const ids = cols[status] ?? [];
              return (
                <BoardColumn key={status} status={status} ids={ids}>
                  {ids.map((id) =>
                    taskMap[id] ? (
                      <SortableTodoCard
                        key={id}
                        todo={taskMap[id]}
                        onClick={() => setEditing(taskMap[id])}
                      />
                    ) : null,
                  )}
                </BoardColumn>
              );
            })}
          </div>
          <DragOverlay>
            {activeTask ? <TodoCardContent todo={activeTask} dragging /> : null}
          </DragOverlay>
        </DndContext>
      ) : listGroups.length === 0 ? (
        <EmptyState
          icon={<Search className="h-6 w-6" />}
          title="No matching tasks"
          description="Try a different search or clear your filters."
        />
      ) : (
        <div className="space-y-4">
          {listGroups.map((group) => {
            const isCollapsed = !!collapsed[group.key];
            return (
              <div key={group.key}>
                <button
                  onClick={() => toggleCollapse(group.key)}
                  className="mb-2 flex w-full items-center gap-2 text-left"
                >
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 text-slate-400 transition-transform",
                      isCollapsed && "-rotate-90",
                    )}
                  />
                  <span className={cn("text-sm font-bold", group.tone)}>
                    {group.label}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">
                    {group.tasks.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="space-y-2.5">
                    <AnimatePresence initial={false}>
                      {group.tasks.map((t) => (
                        <TodoRow
                          key={t.id}
                          t={t}
                          selectMode={selectMode}
                          selected={selected.has(t.id)}
                          onSelect={() => toggleSelect(t.id)}
                          onToggle={() => toggle(t)}
                          onStatus={(s) => handleStatusChange(t, s)}
                          onToggleSubtask={toggleSubtask}
                          onEdit={() => setEditing(t)}
                          onDelete={() => setToDelete(t)}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <TodoFormModal
        open={creating || !!editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        members={members}
        projects={projects}
        todo={editing}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete task"
        description={`Delete "${toDelete?.title}"?`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteTodo(toDelete.id);
          if (res.ok) {
            toast.success("Task deleted");
            router.refresh();
          } else {
            toast.error(res.error);
          }
        }}
      />

      <ConfirmDialog
        open={bulkDeleting}
        onClose={() => setBulkDeleting(false)}
        title="Delete tasks"
        description={`Delete ${selected.size} selected task(s)? This can't be undone.`}
        onConfirm={bulkDeleteConfirmed}
      />
    </div>
  );
}

// ---------------------------------------------------------------
function StatCard({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: number;
  tone?: "slate" | "rose" | "primary" | "emerald";
}) {
  const toneCls = {
    slate: "text-slate-800",
    rose: "text-rose-600",
    primary: "text-primary-700",
    emerald: "text-emerald-600",
  }[tone];
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p className={cn("mt-1 text-2xl font-extrabold tracking-tight", toneCls)}>
        {value}
      </p>
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
        active
          ? "bg-primary-600 text-white shadow-sm"
          : "text-slate-500 hover:text-slate-800",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function BoardColumn({
  status,
  ids,
  children,
}: {
  status: TodoStatus;
  ids: string[];
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = TODO_STATUS_META[status];
  return (
    <div className="flex w-80 shrink-0 flex-col">
      <div className="mb-3 flex items-center gap-2 px-1">
        <span className="text-[13px] font-bold text-slate-800">{meta.label}</span>
        <span className="rounded-lg bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
          {ids.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[140px] flex-1 flex-col gap-3 rounded-2xl border p-3 transition-all duration-300",
          isOver
            ? "border-primary-400 bg-primary-50/30 ring-4 ring-primary-100/20"
            : "border-slate-200/70 bg-slate-50/40",
        )}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-3">{children}</div>
        </SortableContext>
        {ids.length === 0 && (
          <p className="py-6 text-center text-xs text-slate-400">No tasks</p>
        )}
      </div>
    </div>
  );
}

function TodoRow({
  t,
  selectMode,
  selected,
  onSelect,
  onToggle,
  onStatus,
  onToggleSubtask,
  onEdit,
  onDelete,
}: {
  t: TodoWithRelations;
  selectMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onStatus: (s: TodoStatus) => void;
  onToggleSubtask: (st: TodoSubtask) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const done = t.status === "done";
  const due = t.due_date ? dueMeta(t.due_date) : null;
  const subtasks = (t.subtasks ?? [])
    .slice()
    .sort((a, b) => a.position - b.position);
  const subDone = subtasks.filter((s) => s.is_done).length;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.18 }}
      className={cn(
        "group flex items-start gap-3 rounded-2xl border p-4 shadow-[var(--shadow-soft)] transition-all duration-200",
        selected
          ? "border-primary-300 bg-primary-50/40"
          : done
            ? "border-slate-200 bg-slate-50/50 opacity-70"
            : "border-slate-200/80 bg-white",
      )}
    >
      {selectMode ? (
        <button
          onClick={onSelect}
          className={cn(
            "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 transition",
            selected
              ? "border-primary-500 bg-primary-500 text-white"
              : "border-slate-300 hover:border-primary-400",
          )}
          aria-label="Select task"
        >
          {selected && <Check className="h-3 w-3" strokeWidth={3} />}
        </button>
      ) : (
        <button
          disabled={done}
          onClick={onToggle}
          className={cn(
            "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 transition",
            done
              ? "cursor-not-allowed border-emerald-500 bg-emerald-500 text-white"
              : "border-slate-300 hover:border-primary-400",
          )}
          aria-label="Toggle complete"
        >
          {done && <Check className="h-3 w-3" strokeWidth={3} />}
        </button>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn("h-2 w-2 rounded-full", PRIORITY_META[t.priority].dot)}
            title={`${PRIORITY_META[t.priority].label} priority`}
          />
          <p
            className={cn(
              "font-medium text-slate-900",
              done && "text-slate-400 line-through",
            )}
          >
            {t.title}
          </p>
          {t.status === "in_progress" && (
            <Badge className={TODO_STATUS_META.in_progress.badge}>
              In progress
            </Badge>
          )}
          {t.project && (
            <span className="inline-flex items-center gap-1 rounded-lg bg-primary-50 px-2 py-0.5 text-[10px] font-semibold text-primary-600">
              <FolderKanban className="h-3 w-3" />
              {t.project.name}
            </span>
          )}
        </div>

        {t.description && (
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-slate-500">
            <MentionText text={t.description} />
          </p>
        )}

        {subtasks.length > 0 && (
          <div className="mt-2 space-y-1">
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${(subDone / subtasks.length) * 100}%` }}
                />
              </div>
              <span className="text-[11px] font-medium text-slate-400">
                {subDone}/{subtasks.length}
              </span>
            </div>
            {subtasks.map((s) => (
              <button
                key={s.id}
                onClick={() => onToggleSubtask(s)}
                className="flex items-center gap-2 text-left text-xs text-slate-500"
              >
                <span
                  className={cn(
                    "grid h-3.5 w-3.5 shrink-0 place-items-center rounded border transition",
                    s.is_done
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : "border-slate-300 hover:border-primary-400",
                  )}
                >
                  {s.is_done && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                </span>
                <span className={cn(s.is_done && "text-slate-400 line-through")}>
                  {s.title}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-400">
          {due && (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                due.overdue && !done && "font-medium text-rose-500",
              )}
            >
              <CalendarClock className="h-3.5 w-3.5" />
              {t.due_date && format(new Date(t.due_date), "MMM d, p")}
              {due.overdue && !done && " · overdue"}
            </span>
          )}
          {t.assignee && (
            <span className="inline-flex items-center gap-1.5">
              <Avatar
                name={t.assignee.full_name}
                src={t.assignee.avatar_url}
                size="xs"
              />
              {t.assignee.full_name || t.assignee.username}
            </span>
          )}
        </div>
      </div>

      {/* Status buttons */}
      <div className="flex shrink-0 items-center gap-1.5 self-center">
        <button
          disabled={done}
          onClick={() => onStatus("in_progress")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-sm transition duration-200 active:scale-95",
            t.status === "in_progress"
              ? "border-primary-600 bg-primary-600 text-white hover:border-primary-700 hover:bg-primary-700"
              : done
                ? "cursor-not-allowed border-slate-200/60 bg-slate-100/50 text-slate-400"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50",
          )}
          title={done ? "Completed task cannot be changed" : "Set In Progress"}
        >
          {t.status === "in_progress" ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          ) : (
            <Play className="h-3 w-3 fill-current" />
          )}
          <span className="hidden sm:inline">In progress</span>
        </button>

        <button
          disabled={done}
          onClick={() => onStatus("done")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-sm transition duration-200 active:scale-95",
            done
              ? "cursor-not-allowed border-slate-300 bg-slate-200 text-slate-600"
              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50",
          )}
          title={done ? "Completed task" : "Set Done"}
        >
          <Check className="h-3 w-3" strokeWidth={3} />
          <span className="hidden sm:inline">Done</span>
        </button>
      </div>

      <Dropdown
        trigger={
          <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100">
            <MoreVertical className="h-4 w-4" />
          </button>
        }
      >
        <DropdownItem icon={<Pencil className="h-4 w-4" />} onClick={onEdit}>
          Edit
        </DropdownItem>
        <DropdownItem
          destructive
          icon={<Trash2 className="h-4 w-4" />}
          onClick={onDelete}
        >
          Delete
        </DropdownItem>
      </Dropdown>
    </motion.div>
  );
}
