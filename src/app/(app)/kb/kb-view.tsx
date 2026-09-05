"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Bot, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { markdownToHtml } from "@/lib/markdown";
import { cn } from "@/lib/utils";

import { deleteKbPage, saveKbPage, searchKb } from "./actions";

/**
 * How this agency does things, written down (0119).
 *
 * Two audiences, one page. The team reads it; the WhatsApp agent quotes the
 * ones marked for it — which is why visibility is a first-class field and
 * defaults to team-only. An internal note about which clients are difficult
 * must never become something the agent reads out to one.
 */

export type KbPageRow = {
  id: string;
  slug: string;
  title: string;
  body_md: string;
  category: string;
  tags: string[];
  visibility: "team" | "agent" | "both";
  updated_at: string;
};

const VISIBILITY: Record<string, { label: string; className: string }> = {
  team: { label: "Team only", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  agent: {
    label: "Agent only",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  both: {
    label: "Team + agent",
    className: "bg-primary-50 text-primary-700 ring-primary-200",
  },
};

export function KbView({ pages }: { pages: KbPageRow[] }) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<
    { id: string; title: string; category: string; snippet: string }[] | null
  >(null);
  const [openId, setOpenId] = React.useState<string | null>(pages[0]?.id ?? null);
  const [editing, setEditing] = React.useState<KbPageRow | null>(null);
  const [creating, setCreating] = React.useState(false);

  // Search runs server-side through the index, so it ranks a title match
  // above a passing mention. Debounced — every keystroke is a query.
  React.useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      void searchKb(q).then(setHits);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const byCategory = React.useMemo(() => {
    const map = new Map<string, KbPageRow[]>();
    for (const p of pages) {
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pages]);

  const open = pages.find((p) => p.id === openId) ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Knowledge"
        description="How we do things — for the team, and for the WhatsApp agent to answer from."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New page
          </Button>
        }
      />

      {pages.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="h-6 w-6" />}
          title="Nothing written down yet"
          description="Start with the questions you answer most: what hosting includes, how a handover works, what to say about discounts."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New page
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <div className="flex h-[72vh] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
            <div className="border-b border-slate-100 p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search everything"
                  className="pl-9"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {hits ? (
                hits.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-slate-400">
                    Nothing matches.
                  </p>
                ) : (
                  hits.map((h) => (
                    <button
                      key={h.id}
                      onClick={() => {
                        setOpenId(h.id);
                        setQuery("");
                      }}
                      className="block w-full border-b border-slate-50 px-3 py-2.5 text-left hover:bg-slate-50"
                    >
                      <p className="text-sm font-medium text-slate-900">{h.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                        {h.snippet}
                      </p>
                    </button>
                  ))
                )
              ) : (
                byCategory.map(([category, group]) => (
                  <div key={category}>
                    <p className="bg-slate-50/70 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {category}
                    </p>
                    {group.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setOpenId(p.id)}
                        className={cn(
                          "flex w-full items-center gap-2 border-b border-slate-50 px-3 py-2 text-left text-sm hover:bg-slate-50",
                          openId === p.id && "bg-primary-50/60",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-slate-800">
                          {p.title}
                        </span>
                        {p.visibility !== "team" && (
                          <Bot className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                        )}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="h-[72vh] overflow-y-auto rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm">
            {open ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">
                      {open.title}
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge className={VISIBILITY[open.visibility].className}>
                        {VISIBILITY[open.visibility].label}
                      </Badge>
                      {open.tags.map((tag) => (
                        <Badge key={tag}>{tag}</Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => setEditing(open)}>
                      Edit
                    </Button>
                    <button
                      onClick={async () => {
                        const res = await deleteKbPage(open.id);
                        if (res.ok) {
                          setOpenId(null);
                          router.refresh();
                        } else toast.error(res.error);
                      }}
                      aria-label="Delete"
                      className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <article
                  className="mt-5 text-sm leading-relaxed text-slate-700 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-base [&_h1]:font-bold [&_h1]:text-slate-900 [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:text-slate-900 [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_hr]:my-4 [&_hr]:border-slate-200 [&_li]:mb-1 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5"
                  dangerouslySetInnerHTML={{ __html: markdownToHtml(open.body_md) }}
                />
              </>
            ) : (
              <p className="py-16 text-center text-sm text-slate-400">
                Pick a page.
              </p>
            )}
          </div>
        </div>
      )}

      <KbEditor
        open={creating || Boolean(editing)}
        page={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

function KbEditor({
  open,
  page,
  onClose,
}: {
  open: boolean;
  page: KbPageRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState({
    title: "",
    bodyMd: "",
    category: "general",
    tags: "",
    visibility: "team" as "team" | "agent" | "both",
  });
  const [saving, setSaving] = React.useState(false);
  const [preview, setPreview] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setForm({
      title: page?.title ?? "",
      bodyMd: page?.body_md ?? "",
      category: page?.category ?? "general",
      tags: (page?.tags ?? []).join(", "),
      visibility: page?.visibility ?? "team",
    });
    setPreview(false);
  }, [open, page]);

  async function save() {
    setSaving(true);
    const res = await saveKbPage({
      id: page?.id ?? null,
      title: form.title,
      bodyMd: form.bodyMd,
      category: form.category,
      tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      visibility: form.visibility,
    });
    setSaving(false);
    if (res.ok) {
      toast.success("Saved.");
      onClose();
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={page ? "Edit page" : "New page"}
      description="Markdown: # headings, - bullets, **bold**."
      size="xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={saving}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Title" required>
          <Input
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="What hosting includes"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Category">
            <Input
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              placeholder="sales, delivery…"
            />
          </Field>
          <Field label="Tags">
            <Input
              value={form.tags}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
              placeholder="comma, separated"
            />
          </Field>
          <Field label="Who can see it">
            <Select
              value={form.visibility}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  visibility: e.target.value as "team" | "agent" | "both",
                }))
              }
            >
              <option value="team">Team only</option>
              <option value="both">Team + WhatsApp agent</option>
              <option value="agent">WhatsApp agent only</option>
            </Select>
          </Field>
        </div>
        <p className="text-xs text-slate-400">
          Anything the agent can see, it may quote to a customer. Leave a page
          team-only unless you would be happy for a client to read it verbatim.
        </p>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">The page</span>
            <button
              onClick={() => setPreview((p) => !p)}
              className="text-xs font-medium text-primary-600 hover:underline"
            >
              {preview ? "Edit" : "Preview"}
            </button>
          </div>
          {preview ? (
            <div
              className="min-h-[18rem] rounded-xl border border-slate-200 px-4 py-3 text-sm leading-relaxed text-slate-700 [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-bold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:font-bold [&_li]:mb-1 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5"
              dangerouslySetInnerHTML={{ __html: markdownToHtml(form.bodyMd) }}
            />
          ) : (
            <Textarea
              value={form.bodyMd}
              onChange={(e) => setForm((f) => ({ ...f, bodyMd: e.target.value }))}
              rows={18}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
