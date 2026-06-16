"use client";

import * as React from "react";

import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { MemberLite } from "@/lib/types";

export function MentionTextarea({
  value,
  onChange,
  members,
  placeholder,
  rows = 4,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  members: MemberLite[];
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = React.useState<string | null>(null);
  const [active, setActive] = React.useState(0);

  const suggestions = React.useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return members
      .filter(
        (m) =>
          m.username.toLowerCase().includes(q) ||
          (m.full_name ?? "").toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [query, members]);

  function detect() {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? 0;
    const upto = value.slice(0, caret);
    const m = upto.match(/(^|\s)@([a-zA-Z0-9._-]*)$/);
    if (m) {
      setQuery(m[2]);
      setActive(0);
    } else {
      setQuery(null);
    }
  }

  function insert(member: MemberLite) {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const at = value.slice(0, caret).lastIndexOf("@");
    if (at < 0) return;
    const next =
      value.slice(0, at) + "@" + member.username + " " + value.slice(caret);
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = at + member.username.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (query === null || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insert(suggestions[active]);
    } else if (e.key === "Escape") {
      setQuery(null);
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          detect();
        }}
        onClick={detect}
        onKeyUp={detect}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        className={cn(
          "w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-primary-400 focus:outline-none focus:ring-4 focus:ring-primary-100",
          className,
        )}
      />
      {query !== null && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-[var(--shadow-lift)]">
          <p className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Mention a teammate
          </p>
          {suggestions.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insert(m);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors",
                i === active ? "bg-primary-50" : "hover:bg-slate-50",
              )}
            >
              <Avatar name={m.full_name} src={m.avatar_url} size="xs" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-slate-800">
                  {m.full_name || m.username}
                </span>
                <span className="block truncate text-xs text-slate-400">
                  @{m.username}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
