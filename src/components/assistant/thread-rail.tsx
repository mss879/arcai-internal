"use client";

/**
 * The Studio's left rail — history on top, the whole app underneath.
 *
 * Two jobs, both about not losing your place. The upper half is conversation
 * history: everything Arc has been asked, searchable across message bodies
 * (not just titles), grouped by day so "the one from yesterday" is findable
 * without reading every row. The lower half is "Jump to" — every area of the
 * app from the real nav, seeding a prompt rather than navigating, so asking
 * about Invoices never means leaving the conversation to go and look.
 *
 * It collapses to a 56px icon rail when the canvas needs the width, and
 * becomes an overlay drawer when the panel is too narrow for three columns.
 */

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Check,
  EllipsisVertical,
  MessageSquarePlus,
  PanelLeftClose,
  PanelRight,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { NAV, type NavItem } from "@/components/layout/nav";
import type { ThreadSummary } from "@/lib/assistant-threads";

export type ThreadRailProps = {
  /** Newest first. */
  threads: ThreadSummary[];
  activeThreadId: string;
  /** Full-body search; the rail owns the query input, the hook owns the data. */
  onSearch: (query: string) => ThreadSummary[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** Fills the composer and focuses it. Never sends. */
  onSeed: (text: string) => void;
  /** Rail is an overlay drawer below 1280px of panel width. */
  overlay: boolean;
  /** Overlay backdrop, and called after a selection in overlay mode. */
  onDismiss: () => void;
  /**
   * Members never see admin-only areas in the nav, so they should not see
   * them here either. The routes gate themselves server-side regardless.
   * Defaults to `true` (show everything), matching an admin session.
   */
  isAdmin?: boolean;
  /** Controlled icon-rail state. Omit to let the rail manage its own. */
  collapsed?: boolean;
  onToggleCollapsed?: (collapsed: boolean) => void;
  className?: string;
};

const DAY_MS = 86_400_000;

/** Midnight this morning, in local time. */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "just now" · "12m" · "3h" · "Yesterday" · "Mon" · "14 Aug". */
function relativeTime(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  const today = startOfToday();
  if (at >= today) return `${Math.floor(diff / 3_600_000)}h`;
  if (at >= today - DAY_MS) return "Yesterday";
  if (at >= today - DAY_MS * 6) {
    return new Date(at).toLocaleDateString("en-GB", { weekday: "short" });
  }
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

type Group = { key: string; label: string; items: ThreadSummary[] };

/** Today / Yesterday / Earlier, in that order, empty groups dropped. */
function groupThreads(threads: ThreadSummary[]): Group[] {
  const today = startOfToday();
  const groups: Group[] = [
    { key: "today", label: "Today", items: [] },
    { key: "yesterday", label: "Yesterday", items: [] },
    { key: "earlier", label: "Earlier", items: [] },
  ];
  for (const thread of threads) {
    if (thread.updatedAt >= today) groups[0].items.push(thread);
    else if (thread.updatedAt >= today - DAY_MS) groups[1].items.push(thread);
    else groups[2].items.push(thread);
  }
  return groups.filter((g) => g.items.length > 0);
}

const ICON_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300";

function ThreadRow({
  thread,
  active,
  onSelect,
  onRename,
  onDelete,
  now,
}: {
  thread: ThreadSummary;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  now: number;
}) {
  const [mode, setMode] = React.useState<"idle" | "renaming" | "confirming">("idle");
  const [draft, setDraft] = React.useState(thread.title);

  // Entering rename mode seeds the draft from the handler rather than an
  // effect, so the input mounts with the right value on its first render.
  const startRename = () => {
    setDraft(thread.title);
    setMode("renaming");
  };

  if (mode === "renaming") {
    return (
      <li>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onRename(thread.id, draft);
            setMode("idle");
          }}
          className="flex items-center gap-1 rounded-xl bg-white px-1.5 py-1 ring-1 ring-primary-200"
        >
          <input
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Studio's global Esc steps the workspace down; this Esc is
                // only meant to abandon the rename.
                e.preventDefault();
                e.stopPropagation();
                setMode("idle");
              }
            }}
            aria-label="Rename conversation"
            className="min-w-0 flex-1 bg-transparent px-1 text-[13px] font-medium text-slate-800 outline-none"
          />
          <button
            type="submit"
            aria-label="Save name"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-emerald-600 transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setMode("idle")}
            aria-label="Cancel rename"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      </li>
    );
  }

  if (mode === "confirming") {
    return (
      <li className="rounded-xl bg-rose-50 px-2.5 py-2 ring-1 ring-rose-200">
        <p className="truncate text-[12px] font-medium text-rose-800">
          Delete “{thread.title}”?
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onDelete(thread.id)}
            className="rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setMode("idle")}
            className="rounded-lg px-2.5 py-1 text-[11px] font-semibold text-rose-700 transition hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            Keep
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group flex items-start gap-1 rounded-xl px-1 transition",
        active ? "bg-primary-50 ring-1 ring-primary-200" : "hover:bg-slate-100",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(thread.id)}
        aria-current={active ? "true" : undefined}
        className="min-w-0 flex-1 rounded-xl px-1.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
      >
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] font-medium",
              active ? "text-primary-800" : "text-slate-700",
            )}
          >
            {thread.title}
          </span>
          <span className="shrink-0 text-[10px] text-slate-400">
            {relativeTime(thread.updatedAt, now)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">
            {thread.preview || "No messages yet"}
          </span>
          {thread.artifactCount > 0 && (
            <span className="shrink-0 rounded-full bg-white px-1.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200">
              {thread.artifactCount}
            </span>
          )}
        </span>
      </button>

      <Dropdown
        className="mt-1.5 shrink-0"
        align="right"
        trigger={
          <button
            type="button"
            aria-label={`Options for ${thread.title}`}
            className={cn(
              ICON_BUTTON,
              "h-7 w-7 opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
            )}
          >
            <EllipsisVertical className="h-3.5 w-3.5" />
          </button>
        }
      >
        {(close) => (
          <>
            <DropdownItem
              icon={<Pencil className="h-4 w-4" />}
              onClick={() => {
                close();
                startRename();
              }}
            >
              Rename
            </DropdownItem>
            <DropdownItem
              destructive
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => {
                close();
                setMode("confirming");
              }}
            >
              Delete
            </DropdownItem>
          </>
        )}
      </Dropdown>
    </li>
  );
}

/**
 * The Studio's conversation history and app jump-list.
 *
 * @remarks Rendering is driven entirely by props: the rail owns only its
 * search query, its collapsed state (when uncontrolled) and the per-row
 * rename/confirm affordances.
 */
export function ThreadRail({
  threads,
  activeThreadId,
  onSearch,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onSeed,
  overlay,
  onDismiss,
  isAdmin = true,
  collapsed: collapsedProp,
  onToggleCollapsed,
  className,
}: ThreadRailProps): React.ReactElement {
  const reduced = useReducedMotion();
  const [query, setQuery] = React.useState("");
  const [selfCollapsed, setSelfCollapsed] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement | null>(null);

  // An overlay drawer is already a temporary surface; collapsing it to icons
  // as well would leave the user with neither history nor context.
  const collapsed = (collapsedProp ?? selfCollapsed) && !overlay;

  // Relative times are computed against a value that ticks, not against
  // Date.now() inside render — otherwise "2m" never becomes "3m".
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const navItems = React.useMemo<NavItem[]>(
    () => NAV.filter((item) => isAdmin || !item.adminOnly),
    [isAdmin],
  );

  const trimmed = query.trim();
  const visible = trimmed ? onSearch(trimmed) : threads;
  const groups = React.useMemo(
    () => (trimmed ? [{ key: "results", label: "Results", items: visible }] : groupThreads(visible)),
    [trimmed, visible],
  );
  const jumpItems = trimmed
    ? navItems.filter((item) => item.label.toLowerCase().includes(trimmed.toLowerCase()))
    : navItems;

  const setCollapsed = (next: boolean) => {
    setSelfCollapsed(next);
    onToggleCollapsed?.(next);
  };

  const handleSelect = (id: string) => {
    onSelect(id);
    if (overlay) onDismiss();
  };

  const handleSeed = (text: string) => {
    onSeed(text);
    if (overlay) onDismiss();
  };

  const base = collapsed
    ? "flex min-h-0 w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-slate-200/70 bg-white/55 px-2 py-3 no-scrollbar"
    : "flex min-h-0 w-[264px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-200/70 bg-white/55 p-3";

  const overlayClasses = overlay
    ? "absolute inset-y-0 left-0 z-20 bg-white shadow-[var(--shadow-lift)]"
    : undefined;

  const rail = (
    <motion.aside
      key="rail"
      aria-label="Conversations and app areas"
      initial={overlay ? (reduced ? { opacity: 0 } : { opacity: 0, x: -16 }) : false}
      animate={{ opacity: 1, x: 0 }}
      exit={overlay ? (reduced ? { opacity: 0 } : { opacity: 0, x: -16 }) : undefined}
      transition={{ duration: reduced ? 0 : 0.18, ease: "easeOut" }}
      // `className` last-but-one so the workspace can restyle the rail, and
      // the collapsed width last so it always wins over a passed-in width.
      className={cn(base, overlayClasses, className, collapsed && "w-14")}
    >
      {collapsed ? (
        <>
          <button
            type="button"
            onClick={onNew}
            aria-label="New chat"
            title="New chat"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl gradient-primary text-white shadow-[var(--shadow-soft)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
          >
            <MessageSquarePlus className="h-4.5 w-4.5" />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label="Expand the conversation rail"
            title="Expand"
            className={ICON_BUTTON}
          >
            <PanelRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              // Expand first — the field only exists in the wide rail.
              setCollapsed(false);
              requestAnimationFrame(() => searchRef.current?.focus());
            }}
            aria-label="Search conversations"
            title="Search conversations"
            className={ICON_BUTTON}
          >
            <Search className="h-4 w-4" />
          </button>
          <span aria-hidden className="my-1 h-px w-6 bg-slate-200" />
          {navItems.map((item) => (
            <button
              key={item.href}
              type="button"
              onClick={() => handleSeed(`Show me ${item.label}`)}
              aria-label={`Ask about ${item.label}`}
              title={item.label}
              className={ICON_BUTTON}
            >
              <item.icon className="h-4 w-4" />
            </button>
          ))}
        </>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onNew}
              className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl gradient-primary text-[13px] font-semibold text-white shadow-[var(--shadow-soft)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            >
              <MessageSquarePlus className="h-4 w-4" />
              New chat
            </button>
            <button
              type="button"
              onClick={() => (overlay ? onDismiss() : setCollapsed(true))}
              aria-label={overlay ? "Close the conversation rail" : "Collapse the conversation rail"}
              title={overlay ? "Close" : "Collapse"}
              className={ICON_BUTTON}
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          <div className="relative shrink-0">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  // Clear the search first; Studio's Esc handler only gets a
                  // turn once there is nothing left to clear.
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              type="search"
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="h-9 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-primary-300 focus:ring-2 focus:ring-primary-100"
            />
          </div>

          <div className="min-h-0 shrink-0 space-y-3">
            {groups.length === 0 ? (
              <p className="px-2.5 py-6 text-center text-[12px] text-slate-400">
                {trimmed ? `No chats match “${trimmed}”` : "No conversations yet."}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.key}>
                  <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {group.label}
                  </p>
                  <ul role="list" className="space-y-0.5">
                    {group.items.map((thread) => (
                      <ThreadRow
                        key={thread.id}
                        thread={thread}
                        active={thread.id === activeThreadId}
                        onSelect={handleSelect}
                        onRename={onRename}
                        onDelete={onDelete}
                        now={now}
                      />
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>

          <div className="shrink-0 border-t border-slate-200/70 pt-3">
            <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Jump to
            </p>
            {jumpItems.length === 0 ? (
              <p className="px-2.5 py-2 text-[12px] text-slate-400">No areas match.</p>
            ) : (
              <ul role="list" className="space-y-0.5">
                {jumpItems.map((item) => (
                  <li key={item.href}>
                    <button
                      type="button"
                      onClick={() => handleSeed(`Show me ${item.label}`)}
                      className="group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-primary-500" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </motion.aside>
  );

  if (!overlay) return rail;

  // As a drawer the rail floats over the conversation, so it needs its own
  // dismissable scrim — the workspace backdrop sits behind the whole panel.
  return (
    <>
      <motion.div
        key="rail-scrim"
        aria-hidden
        onClick={onDismiss}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reduced ? 0 : 0.15 }}
        className="absolute inset-0 z-10 bg-slate-950/20"
      />
      {rail}
    </>
  );
}
