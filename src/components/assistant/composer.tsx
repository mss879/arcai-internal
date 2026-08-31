"use client";

/**
 * The Studio composer — the one input that has to do everything.
 *
 * Talking to Arc should not mean remembering what Arc can do. So the field
 * carries its own affordances: "/" opens a command palette seeded from the
 * real app nav (every area, plus the things people actually ask for — an
 * invoice, a proposal, a payment reminder), and "@" searches clients,
 * projects and leads through the same endpoint global search uses, inserting
 * a plain name the model can resolve.
 *
 * Everything is keyboard-first, and neither menu is allowed to steal Enter
 * while it is closed — the single most annoying thing a smart composer can do.
 */

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AtSign,
  Command,
  CornerDownLeft,
  CreditCard,
  FileText,
  Landmark,
  Loader2,
  Mic,
  Sparkles,
  Square,
  ScrollText,
  Search,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { NAV } from "@/components/layout/nav";
import type { Status } from "@/components/assistant/use-voice-chat";

/** One row of the "/" palette. */
export type AssistantCommand = {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  /** Text placed in the composer. */
  insert: string;
  /** true → send immediately; false → leave the caret at the end. */
  send: boolean;
};

export type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  /** Enter / Cmd+Enter / send button. */
  onSend: (value: string) => void;
  onToggleMic: () => void;
  /** Shown instead of Send while a turn is in flight. */
  onCancel: () => void;
  status: Status;
  /** 0..1 RMS from the mic, used only for the button's ring. */
  level: number;
  busy: boolean;
  /** Rendered above the field when the active thread is empty. */
  suggestions: string[];
  onSuggest: (text: string) => void;
  /** Imperative focus/seed handle for the rail's "Jump to" and empty-state chips. */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Members never see admin-only areas; defaults to an admin session. */
  isAdmin?: boolean;
  className?: string;
};

/** Past this the field scrolls instead of growing. */
const MAX_TEXTAREA_PX = 200;
/** One keystroke's grace before we ask the server who "@sil" is. */
const MENTION_DEBOUNCE_MS = 220;
const MENTION_LIMIT = 8;
/** The three things you'd actually @-mention in a work conversation. */
const MENTION_CATEGORIES = new Set(["Clients", "Projects", "CRM Pipeline"]);

type SearchResult = {
  id: string;
  title: string;
  subtitle?: string;
  category: string;
  href: string;
};

/** The fixed head of the palette, before every nav area is appended. */
const CORE_COMMANDS: Omit<AssistantCommand, "id">[] = [
  {
    label: "New invoice",
    hint: "Draft an invoice for a client",
    icon: FileText,
    insert: "Create an invoice for ",
    send: false,
  },
  {
    label: "New proposal",
    hint: "Write a branded proposal",
    icon: ScrollText,
    insert: "Write a proposal for ",
    send: false,
  },
  {
    label: "Payment reminder",
    hint: "Chase an unpaid invoice",
    icon: CreditCard,
    insert: "Send a payment reminder for invoice ",
    send: false,
  },
  {
    label: "Who owes me money",
    hint: "Outstanding balances",
    icon: Landmark,
    insert: "Who owes me money?",
    send: true,
  },
  {
    label: "This month's numbers",
    hint: "Income, costs and margin",
    icon: Sparkles,
    insert: "Show me this month's numbers.",
    send: true,
  },
  {
    label: "What can you do",
    hint: "Everything Arcus has access to",
    icon: Command,
    insert: "What can you do?",
    send: true,
  },
];

function buildCommands(isAdmin: boolean): AssistantCommand[] {
  const core = CORE_COMMANDS.map((c, i) => ({ ...c, id: `core-${i}` }));
  const areas = NAV
    .filter((item) => isAdmin || !item.adminOnly)
    .map<AssistantCommand>((item) => ({
      id: `nav-${item.href}`,
      label: item.label,
      hint: "Open in the preview",
      icon: item.icon,
      insert: `Show me ${item.label}`,
      send: true,
    }));
  return [...core, ...areas];
}

/** The `@token` under the caret, if there is one. */
function findMention(value: string, caret: number): { start: number; query: string } | null {
  const upToCaret = value.slice(0, caret);
  // `@` must start the string or follow whitespace, and the token itself
  // cannot contain whitespace or another `@`.
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(upToCaret);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}

/** Shared popover chrome for both menus. */
function Menu({
  id,
  labelledBy,
  children,
}: {
  id: string;
  labelledBy: string;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      transition={{ duration: reduced ? 0 : 0.14, ease: "easeOut" }}
      className="absolute bottom-full left-0 z-30 mb-2 max-h-[280px] w-[min(420px,100%)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-[var(--shadow-lift)]"
    >
      <div id={id} role="listbox" aria-label={labelledBy}>
        {children}
      </div>
    </motion.div>
  );
}

/**
 * The Studio's message composer: autogrowing field, mic with a live level
 * ring, stop control, "/" command palette and "@" entity mentions.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onToggleMic,
  onCancel,
  status,
  level,
  busy,
  suggestions,
  onSuggest,
  inputRef,
  isAdmin = true,
  className,
}: ComposerProps): React.ReactElement {
  const localRef = React.useRef<HTMLTextAreaElement | null>(null);
  const taRef = inputRef ?? localRef;

  const [caret, setCaret] = React.useState(0);
  /** Which menu the user pressed Esc on; cleared once its trigger is gone. */
  const [dismissed, setDismissed] = React.useState<"palette" | "mention" | null>(null);
  /** Highlighted row, tied to the menu it belongs to so it resets itself. */
  const [highlight, setHighlight] = React.useState<{ key: string; index: number }>({
    key: "",
    index: 0,
  });
  /** The last completed "@" lookup, keyed by the query that produced it. */
  const [lookup, setLookup] = React.useState<{ key: string; results: SearchResult[] }>({
    key: "",
    results: [],
  });

  const commands = React.useMemo(() => buildCommands(isAdmin), [isAdmin]);

  // ---- which menu, if any, is open --------------------------------------
  // A slash only counts as a command when it is the very first character —
  // otherwise "and/or" would pop a palette mid-sentence.
  const slashMatch = /^\/(\S*)$/.exec(value);
  const paletteQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const paletteItems = React.useMemo(
    () =>
      paletteQuery === null
        ? []
        : commands.filter((c) => c.label.toLowerCase().includes(paletteQuery)),
    [commands, paletteQuery],
  );
  const paletteOpen =
    paletteQuery !== null && dismissed !== "palette" && paletteItems.length > 0;

  const mention = React.useMemo(() => findMention(value, caret), [value, caret]);
  // Only one menu at a time; the palette owns the field when it is open.
  const mentionOpen = !paletteOpen && mention !== null && dismissed !== "mention";

  // The menu the highlight belongs to. When it changes — a new query, a
  // different menu, no menu — the highlight falls back to the first row
  // without needing an effect to reset it.
  const menuKey = paletteOpen
    ? `/${paletteQuery ?? ""}`
    : mentionOpen
      ? `@${mention?.query ?? ""}`
      : "";

  // ---- "@" lookup --------------------------------------------------------
  const mentionQuery = mentionOpen ? (mention?.query ?? "") : null;
  const searching = mentionQuery !== null && mentionQuery.trim().length >= 1;
  // Results are shown only when they belong to the query on screen, so a
  // stale list never flashes under a newer token.
  const mentionResults = searching && lookup.key === mentionQuery ? lookup.results : [];
  const mentionLoading = searching && lookup.key !== mentionQuery;

  React.useEffect(() => {
    if (mentionQuery === null || mentionQuery.trim().length < 1) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(mentionQuery)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const data: unknown = await res.json();
        const raw = (data as { results?: unknown }).results;
        const results = Array.isArray(raw) ? (raw as SearchResult[]) : [];
        setLookup({
          key: mentionQuery,
          results: results
            .filter((r) => r && typeof r.title === "string" && MENTION_CATEGORIES.has(r.category))
            .slice(0, MENTION_LIMIT),
        });
      } catch {
        // Aborted, offline or a 500. An empty menu is the right answer here,
        // and typing must never be blocked on this request.
        if (!controller.signal.aborted) setLookup({ key: mentionQuery, results: [] });
      }
    }, MENTION_DEBOUNCE_MS);

    // Every new keystroke cancels the pending debounce *and* the request it
    // may already have started.
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mentionQuery]);

  // ---- autogrow ----------------------------------------------------------
  React.useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    // Reset first: without this the box can only ever grow.
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [value, taRef]);

  const syncCaret = () => {
    const el = taRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  };

  /** Put the caret at `position` on the next frame, once React has painted. */
  const focusAt = (position: number) => {
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(position, position);
      setCaret(position);
    });
  };

  const send = () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setDismissed(null);
    onSend(trimmed);
  };

  const runCommand = (command: AssistantCommand) => {
    if (command.send) {
      onChange("");
      onSend(command.insert);
      return;
    }
    onChange(command.insert);
    focusAt(command.insert.length);
  };

  const insertMention = (result: SearchResult) => {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(caret);
    // Plain text, no marker syntax: the model resolves the name itself, and a
    // token format would be one more thing to keep in sync with the server.
    const inserted = `${result.title} `;
    onChange(`${before}${inserted}${after}`);
    focusAt(before.length + inserted.length);
  };

  const optionCount = paletteOpen
    ? paletteItems.length
    : mentionOpen
      ? mentionResults.length
      : 0;

  const active =
    highlight.key === menuKey ? Math.min(highlight.index, Math.max(0, optionCount - 1)) : 0;
  const setActive = (index: number) => setHighlight({ key: menuKey, index });

  const chooseActive = () => {
    if (paletteOpen) {
      const command = paletteItems[active];
      if (command) runCommand(command);
      return;
    }
    if (mentionOpen) {
      const result = mentionResults[active];
      if (result) insertMention(result);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const menuOpen = paletteOpen || mentionOpen;
    const withModifier = event.metaKey || event.ctrlKey;

    // Cmd/Ctrl+Enter always sends, menu or no menu.
    if (event.key === "Enter" && withModifier) {
      event.preventDefault();
      send();
      return;
    }

    if (menuOpen && optionCount > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((active + 1) % optionCount);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((active - 1 + optionCount) % optionCount);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseActive();
        return;
      }
    }

    if (menuOpen && event.key === "Escape") {
      // Consume it: Studio's global Esc would otherwise close the workspace
      // out from under a menu the user was only trying to dismiss.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(paletteOpen ? "palette" : "mention");
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const listboxId = paletteOpen ? "arc-composer-commands" : "arc-composer-mentions";
  const activeId = optionCount > 0 ? `${listboxId}-${active}` : undefined;
  const listening = status === "listening";

  return (
    <div className={cn("shrink-0 px-4 pb-4 pt-2", className)}>
      <div className="mx-auto w-full max-w-[820px]">
        {suggestions.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {suggestions.map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => onSuggest(text)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-600 transition hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
              >
                {text}
              </button>
            ))}
          </div>
        )}

        <div className="relative">
          <AnimatePresence>
            {paletteOpen && (
              <Menu key="palette" id={listboxId} labelledBy="Commands">
                {paletteItems.map((command, index) => (
                  <button
                    key={command.id}
                    id={`${listboxId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => runCommand(command)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] transition",
                      index === active
                        ? "bg-primary-50 text-primary-800"
                        : "text-slate-700 hover:bg-slate-100",
                    )}
                  >
                    <command.icon className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate font-medium">{command.label}</span>
                    {command.hint && (
                      <span className="hidden shrink-0 truncate text-[11px] text-slate-400 sm:block">
                        {command.hint}
                      </span>
                    )}
                  </button>
                ))}
              </Menu>
            )}

            {mentionOpen && (
              <Menu key="mentions" id={listboxId} labelledBy="Clients, projects and leads">
                {mentionLoading && mentionResults.length === 0 && (
                  <p className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-slate-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Searching…
                  </p>
                )}
                {!mentionLoading && mentionResults.length === 0 && (
                  <p className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-slate-400">
                    <Search className="h-3.5 w-3.5" />
                    {mention && mention.query ? "No matches" : "Type a name to search"}
                  </p>
                )}
                {mentionResults.map((result, index) => {
                  const first =
                    index === 0 || mentionResults[index - 1].category !== result.category;
                  return (
                    <React.Fragment key={`${result.category}-${result.id}`}>
                      {first && (
                        <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          {result.category}
                        </p>
                      )}
                      <button
                        id={`${listboxId}-${index}`}
                        role="option"
                        aria-selected={index === active}
                        type="button"
                        onMouseEnter={() => setActive(index)}
                        onClick={() => insertMention(result)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] transition",
                          index === active
                            ? "bg-primary-50 text-primary-800"
                            : "text-slate-700 hover:bg-slate-100",
                        )}
                      >
                        <AtSign className="h-4 w-4 shrink-0 text-slate-400" />
                        <span className="min-w-0 flex-1 truncate font-medium">{result.title}</span>
                        {result.subtitle && (
                          <span className="hidden shrink-0 max-w-[45%] truncate text-[11px] text-slate-400 sm:block">
                            {result.subtitle}
                          </span>
                        )}
                      </button>
                    </React.Fragment>
                  );
                })}
              </Menu>
            )}
          </AnimatePresence>

          <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-[var(--shadow-soft)] transition focus-within:border-primary-300 focus-within:ring-4 focus-within:ring-primary-100">
            <textarea
              ref={taRef}
              rows={1}
              value={value}
              onChange={(e) => {
                const next = e.target.value;
                const nextCaret = e.target.selectionStart ?? next.length;
                onChange(next);
                setCaret(nextCaret);
                // A dismissed menu may reopen once its trigger is gone —
                // done here rather than in an effect so there is no extra
                // render between the keystroke and the decision.
                if (dismissed === "palette" && !/^\/\S*$/.test(next)) setDismissed(null);
                if (dismissed === "mention" && !findMention(next, nextCaret)) setDismissed(null);
              }}
              onKeyUp={syncCaret}
              onClick={syncCaret}
              onSelect={syncCaret}
              onKeyDown={onKeyDown}
              placeholder={listening ? "Listening…" : "Ask Arcus anything — or type / for commands"}
              aria-label="Message Arcus"
              role="combobox"
              aria-expanded={paletteOpen || mentionOpen}
              aria-controls={paletteOpen || mentionOpen ? listboxId : undefined}
              aria-activedescendant={activeId}
              aria-autocomplete="list"
              className="max-h-[200px] min-h-[40px] w-full resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed text-slate-800 outline-none placeholder:text-slate-400"
            />

            <button
              type="button"
              onClick={onToggleMic}
              disabled={busy && !listening}
              aria-label={listening ? "Stop recording" : "Start talking"}
              aria-pressed={listening}
              className={cn(
                "relative grid h-10 w-10 shrink-0 place-items-center overflow-visible rounded-xl text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:opacity-50",
                listening ? "bg-rose-600 hover:bg-rose-700" : "gradient-primary hover:brightness-110",
              )}
            >
              {listening && (
                <span
                  aria-hidden
                  className="absolute inset-0 -z-10 rounded-xl bg-rose-500/40 transition-transform duration-75"
                  style={{ transform: `scale(${1 + Math.min(level * 4, 1)})` }}
                />
              )}
              {listening ? (
                <Square className="h-4 w-4" fill="currentColor" />
              ) : status === "thinking" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </button>

            {busy ? (
              <button
                type="button"
                onClick={onCancel}
                aria-label="Stop Arcus"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-200 text-slate-700 transition hover:bg-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
              >
                <Square className="h-4 w-4" fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!value.trim()}
                aria-label="Send message"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-white transition hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:opacity-40"
              >
                <CornerDownLeft className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Keyboard hints, for people with a keyboard. On a phone the row is
            both useless and too wide, so it is dropped rather than clipped. */}
        <p className="mt-1.5 hidden px-1 text-[11px] text-slate-400 sm:block">
          ⏎ send · ⇧⏎ new line · / commands · @ mention
        </p>
      </div>
    </div>
  );
}
