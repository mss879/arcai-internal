"use client";

/**
 * Every file attached to a project, in one place (LOOP-9).
 *
 * They live in four different buckets and three different tables — the signed
 * proposal and invoice on the project row, whatever the client uploaded on the
 * portal, whatever they sent over WhatsApp, and the supplier receipts on
 * expenses. Finding one of them meant knowing which screen it came in through.
 */

import * as React from "react";
import { format } from "date-fns";
import {
  FileText,
  FolderOpen,
  Image as ImageIcon,
  MessageCircle,
  Receipt,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export type ProjectFile = {
  id: string;
  name: string;
  url: string;
  /** Where it came in through — the thing you actually remember about a file. */
  source: "proposal" | "invoice" | "portal" | "whatsapp" | "receipt";
  date: string | null;
  meta?: string | null;
};

const SOURCE_META: Record<
  ProjectFile["source"],
  { label: string; badge: string; icon: React.ReactNode }
> = {
  proposal: {
    label: "Proposal",
    badge: "bg-primary-50 text-primary-600 ring-primary-200",
    icon: <FileText className="h-4 w-4" />,
  },
  invoice: {
    label: "Invoice",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
    icon: <Receipt className="h-4 w-4" />,
  },
  portal: {
    label: "From the client",
    badge: "bg-sky-50 text-sky-600 ring-sky-200",
    icon: <ImageIcon className="h-4 w-4" />,
  },
  whatsapp: {
    label: "WhatsApp",
    badge: "bg-green-50 text-green-700 ring-green-200",
    icon: <MessageCircle className="h-4 w-4" />,
  },
  receipt: {
    label: "Supplier receipt",
    badge: "bg-amber-50 text-amber-700 ring-amber-200",
    icon: <Receipt className="h-4 w-4" />,
  },
};

export function FilesSection({ files }: { files: ProjectFile[] }) {
  const [query, setQuery] = React.useState("");
  const [source, setSource] = React.useState<ProjectFile["source"] | "all">("all");

  const sources = React.useMemo(() => {
    const counts = new Map<ProjectFile["source"], number>();
    for (const f of files) counts.set(f.source, (counts.get(f.source) ?? 0) + 1);
    return [...counts.entries()];
  }, [files]);

  const shown = files.filter((f) => {
    if (source !== "all" && f.source !== source) return false;
    if (!query.trim()) return true;
    return f.name.toLowerCase().includes(query.trim().toLowerCase());
  });

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500">
            <FolderOpen className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Files</h2>
            <p className="text-xs text-slate-400">
              {files.length} file{files.length === 1 ? "" : "s"} across the project
            </p>
          </div>
        </div>
        <div className="relative w-full max-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files"
            className="pl-9"
          />
        </div>
      </div>

      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-5 py-3">
          <FilterChip
            active={source === "all"}
            onClick={() => setSource("all")}
            label={`All (${files.length})`}
          />
          {sources.map(([s, count]) => (
            <FilterChip
              key={s}
              active={source === s}
              onClick={() => setSource(s)}
              label={`${SOURCE_META[s].label} (${count})`}
            />
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-400">
          {files.length === 0
            ? "Nothing attached yet. Documents on the project, client uploads and supplier receipts all land here."
            : "Nothing matches that."}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {shown.map((f) => {
            const meta = SOURCE_META[f.source];
            return (
              <li key={`${f.source}:${f.id}`}>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 px-5 py-3 transition hover:bg-slate-50"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-400">
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {f.name}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {f.date ? format(new Date(f.date), "d MMM yyyy") : "No date"}
                      {f.meta ? ` · ${f.meta}` : ""}
                    </p>
                  </div>
                  <Badge className={meta.badge}>{meta.label}</Badge>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "rounded-lg bg-primary-600 px-2.5 py-1 text-xs font-semibold text-white"
          : "rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
      }
    >
      {label}
    </button>
  );
}
