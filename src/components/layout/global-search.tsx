"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  Search,
  Users,
  ListChecks,
  FolderKanban,
  KanbanSquare,
  CalendarClock,
  FolderOpen,
  ArrowRight,
  Loader2,
  X,
  LayoutDashboard,
} from "lucide-react";

import { cn } from "@/lib/utils";

interface SearchResult {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  href: string;
}

interface QuickLink {
  id: string;
  title: string;
  subtitle: string;
  category: "Navigation";
  href: string;
  icon: React.ReactNode;
}

const QUICK_LINKS: QuickLink[] = [
  {
    id: "nav-dashboard",
    title: "Go to Dashboard",
    subtitle: "Overview of your workspace",
    category: "Navigation",
    href: "/dashboard",
    icon: <LayoutDashboard className="h-4 w-4 text-indigo-500" />,
  },
  {
    id: "nav-clients",
    title: "Go to Clients",
    subtitle: "Shared client directory",
    category: "Navigation",
    href: "/clients",
    icon: <Users className="h-4 w-4 text-emerald-500" />,
  },
  {
    id: "nav-todos",
    title: "Go to To-Dos",
    subtitle: "View and manage team tasks",
    category: "Navigation",
    href: "/todos",
    icon: <ListChecks className="h-4 w-4 text-amber-500" />,
  },
  {
    id: "nav-projects",
    title: "Go to Projects",
    subtitle: "Active workspace projects",
    category: "Navigation",
    href: "/projects",
    icon: <FolderKanban className="h-4 w-4 text-blue-500" />,
  },
  {
    id: "nav-crm",
    title: "Go to CRM Pipeline",
    subtitle: "Track leads and sales stages",
    category: "Navigation",
    href: "/crm",
    icon: <KanbanSquare className="h-4 w-4 text-violet-500" />,
  },
  {
    id: "nav-meetings",
    title: "Go to Meetings",
    subtitle: "Schedule and view bookings",
    category: "Navigation",
    href: "/meetings",
    icon: <CalendarClock className="h-4 w-4 text-rose-500" />,
  },
  {
    id: "nav-resources",
    title: "Go to Resources",
    subtitle: "Shared assets and links",
    category: "Navigation",
    href: "/resources",
    icon: <FolderOpen className="h-4 w-4 text-cyan-500" />,
  },
];

function getCategoryIcon(category: string) {
  switch (category) {
    case "Clients":
      return <Users className="h-4 w-4 text-emerald-500" />;
    case "To-Dos":
      return <ListChecks className="h-4 w-4 text-amber-500" />;
    case "Projects":
      return <FolderKanban className="h-4 w-4 text-blue-500" />;
    case "CRM Pipeline":
      return <KanbanSquare className="h-4 w-4 text-violet-500" />;
    case "Meetings":
      return <CalendarClock className="h-4 w-4 text-rose-500" />;
    case "Resources":
      return <FolderOpen className="h-4 w-4 text-cyan-500" />;
    default:
      return <Search className="h-4 w-4 text-slate-500" />;
  }
}

export function GlobalSearch() {
  const router = useRouter();
  const [isOpen, setIsOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const mobileInputRef = React.useRef<HTMLInputElement>(null);

  // Close dropdown on outside clicks
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Keyboard listener for Cmd+K and /
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsOpen(true);
        setTimeout(() => {
          inputRef.current?.focus();
        }, 50);
      } else if (e.key === "/") {
        const active = document.activeElement;
        if (
          active &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.hasAttribute("contenteditable"))
        ) {
          return;
        }
        e.preventDefault();
        setIsOpen(true);
        setTimeout(() => {
          inputRef.current?.focus();
        }, 50);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Debounce API requests
  React.useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      setSelectedIndex(0);
      return;
    }

    setLoading(true);
    const controller = new AbortController();

    const delayDebounceFn = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          setResults(data.results || []);
          setSelectedIndex(0);
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("Global search API error:", err);
        }
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => {
      clearTimeout(delayDebounceFn);
      controller.abort();
    };
  }, [query]);

  const activeItems = React.useMemo(() => {
    return query.trim() ? results : QUICK_LINKS;
  }, [query, results]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setIsOpen(false);
        inputRef.current?.blur();
        mobileInputRef.current?.blur();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % activeItems.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + activeItems.length) % activeItems.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const selected = activeItems[selectedIndex];
        if (selected) {
          router.push(selected.href);
          setIsOpen(false);
          inputRef.current?.blur();
          mobileInputRef.current?.blur();
        }
      }
    },
    [activeItems, selectedIndex, router]
  );

  // Auto-scroll selected item into view
  React.useEffect(() => {
    const listEl = containerRef.current;
    if (!listEl) return;
    const selectedEl = listEl.querySelector(`[data-index="${selectedIndex}"]`);
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  return (
    <div ref={containerRef} className="relative flex items-center">
      {/* Desktop Search Bar with Inline Dropdown */}
      <div className="relative hidden md:block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search…"
          className="h-10 w-64 rounded-xl border border-slate-200 bg-white pl-9 pr-14 text-sm text-slate-700 placeholder:text-slate-400 focus:border-primary-400 focus:outline-none focus:ring-4 focus:ring-primary-100 transition-all"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
          ) : query ? (
            <button
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <kbd className="pointer-events-none select-none rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[9px] font-medium text-slate-400">
              ⌘K
            </kbd>
          )}
        </div>

        {/* Dropdown Overlay for Desktop */}
        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full mt-2 w-[450px] overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-lift)] z-50"
            >
              <div className="max-h-[320px] overflow-y-auto px-2 py-3 scrollbar-thin">
                {activeItems.length > 0 ? (
                  <div className="space-y-4">
                    {query.trim() ? (
                      Object.entries(
                        results.reduce((acc, curr) => {
                          if (!acc[curr.category]) acc[curr.category] = [];
                          acc[curr.category].push(curr);
                          return acc;
                        }, {} as Record<string, SearchResult[]>)
                      ).map(([category, items]) => (
                        <div key={category} className="space-y-1">
                          <h3 className="px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                            {category}
                          </h3>
                          <div className="space-y-0.5">
                            {items.map((item) => {
                              const globalIdx = activeItems.findIndex(
                                (x) => x.id === item.id && x.category === item.category
                              );
                              const isSelected = globalIdx === selectedIndex;
                              return (
                                <button
                                  key={`${item.category}-${item.id}`}
                                  data-index={globalIdx}
                                  onClick={() => {
                                    router.push(item.href);
                                    setIsOpen(false);
                                  }}
                                  onMouseEnter={() => setSelectedIndex(globalIdx)}
                                  className={cn(
                                    "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition",
                                    isSelected
                                      ? "bg-slate-50 text-slate-900"
                                      : "text-slate-700 hover:bg-slate-50/50"
                                  )}
                                >
                                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 border border-slate-100">
                                    {getCategoryIcon(item.category)}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="font-medium text-xs text-slate-900 truncate">
                                      {item.title}
                                    </p>
                                    <p className="text-[10px] text-slate-400 truncate">
                                      {item.subtitle}
                                    </p>
                                  </div>
                                  {isSelected && (
                                    <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="space-y-1">
                        <h3 className="px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          Quick Page Jump
                        </h3>
                        <div className="space-y-0.5">
                          {QUICK_LINKS.map((link, idx) => {
                            const isSelected = idx === selectedIndex;
                            return (
                              <button
                                key={link.id}
                                data-index={idx}
                                onClick={() => {
                                  router.push(link.href);
                                  setIsOpen(false);
                                }}
                                onMouseEnter={() => setSelectedIndex(idx)}
                                className={cn(
                                  "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition",
                                  isSelected
                                    ? "bg-slate-50 text-slate-900"
                                    : "text-slate-700 hover:bg-slate-50/50"
                                )}
                              >
                                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 border border-slate-100">
                                  {link.icon}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium text-xs text-slate-900 truncate">
                                    {link.title}
                                  </p>
                                  <p className="text-[10px] text-slate-400 truncate">
                                    {link.subtitle}
                                  </p>
                                </div>
                                {isSelected && (
                                  <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="py-6 text-center">
                    <p className="text-xs font-medium text-slate-500">
                      No results found for &ldquo;{query}&rdquo;
                    </p>
                  </div>
                )}
              </div>

              {/* Dropdown Footer */}
              <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/50 px-3 py-1.5 text-[9px] text-slate-400 select-none">
                <span className="flex gap-2">
                  <span><kbd className="rounded bg-white border border-slate-200 px-1">↑↓</kbd> Navigate</span>
                  <span><kbd className="rounded bg-white border border-slate-200 px-1">↵</kbd> Select</span>
                </span>
                <span>Press <kbd className="rounded bg-white border border-slate-200 px-1">ESC</kbd> to close</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Mobile Search Button & Dropdown */}
      <div className="md:hidden">
        <button
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label="Search site"
          className="grid h-10 w-10 place-items-center rounded-xl text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition"
        >
          {isOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
        </button>

        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 5 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-x-4 top-16 z-50 rounded-2xl border border-slate-200 bg-white shadow-2xl p-2 flex flex-col max-h-[350px]"
            >
              {/* Search input in mobile dropdown */}
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  ref={mobileInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Search website..."
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-8 text-sm text-slate-700 placeholder:text-slate-400 focus:border-primary-400 focus:outline-none"
                  autoFocus
                />
                {loading && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-slate-400" />
                )}
              </div>

              {/* Scrollable list */}
              <div className="flex-1 overflow-y-auto min-h-0 space-y-2 py-1 scrollbar-thin">
                {activeItems.length > 0 ? (
                  query.trim() ? (
                    Object.entries(
                      results.reduce((acc, curr) => {
                        if (!acc[curr.category]) acc[curr.category] = [];
                        acc[curr.category].push(curr);
                        return acc;
                      }, {} as Record<string, SearchResult[]>)
                    ).map(([category, items]) => (
                      <div key={category} className="space-y-1">
                        <h3 className="px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          {category}
                        </h3>
                        {items.map((item) => (
                          <button
                            key={`${item.category}-${item.id}`}
                            onClick={() => {
                              router.push(item.href);
                              setIsOpen(false);
                            }}
                            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-slate-50 transition"
                          >
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 border border-slate-100">
                              {getCategoryIcon(item.category)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-xs text-slate-900 truncate">
                                {item.title}
                              </p>
                              <p className="text-[10px] text-slate-400 truncate">
                                {item.subtitle}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                    ))
                  ) : (
                    <div className="space-y-1">
                      <h3 className="px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        Quick Page Jump
                      </h3>
                      {QUICK_LINKS.map((link) => (
                        <button
                          key={link.id}
                          onClick={() => {
                            router.push(link.href);
                            setIsOpen(false);
                          }}
                          className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-slate-50 transition"
                        >
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 border border-slate-100">
                            {link.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-xs text-slate-900 truncate">
                              {link.title}
                            </p>
                            <p className="text-[10px] text-slate-400 truncate">
                              {link.subtitle}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )
                ) : (
                  <p className="text-xs text-center text-slate-400 py-4">
                    No results found for &ldquo;{query}&rdquo;
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
