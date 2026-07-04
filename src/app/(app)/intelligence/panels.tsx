"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Bot,
  Copy,
  Globe,
  Megaphone,
  MousePointerClick,
  Phone,
  Plus,
  Sparkles,
  Star,
  Swords,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn, formatCurrency } from "@/lib/utils";
import type {
  AdEntry,
  AdPlatform,
  Competitor,
  CompetitorEntry,
  CompetitorEntryKind,
  VisitorEvent,
} from "@/lib/types";

import {
  addCompetitorEntry,
  deleteAdEntry,
  deleteCompetitor,
  draftReviewReply,
  saveAdEntry,
  saveCompetitor,
  summarizeCompetitor,
  type AdInput,
} from "./actions";

// ============================ ADS ============================

const PLATFORM_LABEL: Record<AdPlatform, string> = {
  meta: "Meta",
  google: "Google",
  tiktok: "TikTok",
  other: "Other",
};

export function AdsPanel({ ads }: { ads: AdEntry[] }) {
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<AdEntry | null>(null);
  const [toDelete, setToDelete] = React.useState<AdEntry | null>(null);

  const spend = ads.reduce((s, a) => s + Number(a.spend), 0);
  const revenue = ads.reduce((s, a) => s + Number(a.revenue ?? 0), 0);
  const leads = ads.reduce((s, a) => s + Number(a.leads ?? 0), 0);

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteAdEntry(toDelete.id);
    if (res.ok) toast.success("Entry removed.");
    else toast.error(res.error);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          Log each campaign&apos;s spend and results — revenue and cost live side by side, so you
          finally see which ads pay for themselves.
        </p>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          Log campaign
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MiniStat label="Total spend" value={formatCurrency(spend)} />
        <MiniStat label="Attributed revenue" value={formatCurrency(revenue)} />
        <MiniStat label="Leads from ads" value={String(leads)} />
        <MiniStat
          label="ROAS"
          value={spend > 0 ? `${(revenue / spend).toFixed(1)}×` : "—"}
          tone={revenue >= spend ? "text-emerald-600" : "text-rose-600"}
        />
      </div>

      {ads.length === 0 ? (
        <EmptyState
          icon={<Megaphone className="h-6 w-6" />}
          title="No campaigns logged"
          description="Add your Meta/Google campaigns with spend and results. The weekly digest picks the best performer automatically."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-400">
                <th className="px-4 py-2.5 font-semibold">Campaign</th>
                <th className="px-4 py-2.5 font-semibold">Period</th>
                <th className="px-4 py-2.5 text-right font-semibold">Spend</th>
                <th className="px-4 py-2.5 text-right font-semibold">Leads</th>
                <th className="px-4 py-2.5 text-right font-semibold">Revenue</th>
                <th className="px-4 py-2.5 text-right font-semibold">ROAS</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ads.map((ad) => {
                const roas = Number(ad.spend) > 0 ? Number(ad.revenue ?? 0) / Number(ad.spend) : null;
                return (
                  <tr key={ad.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => setEditing(ad)}
                        className="font-medium text-slate-800 hover:text-primary-600"
                      >
                        {ad.campaign}
                      </button>
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                        {PLATFORM_LABEL[ad.platform]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-400">
                      {ad.period_start} → {ad.period_end}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-600">
                      {formatCurrency(Number(ad.spend))}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-600">{ad.leads ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right text-slate-600">
                      {ad.revenue != null ? formatCurrency(Number(ad.revenue)) : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2.5 text-right font-semibold",
                        roas == null ? "text-slate-400" : roas >= 1 ? "text-emerald-600" : "text-rose-500",
                      )}
                    >
                      {roas == null ? "—" : `${roas.toFixed(1)}×`}
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      <button
                        onClick={() => setToDelete(ad)}
                        className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                        aria-label="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AdModal
        open={creating || editing !== null}
        ad={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Remove this campaign entry?"
        description="It disappears from the ads panel and the digest's best-ad pick."
      />
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className={cn("mt-1 text-xl font-bold text-slate-900", tone)}>{value}</p>
    </div>
  );
}

function AdModal({
  open,
  ad,
  onClose,
}: {
  open: boolean;
  ad: AdEntry | null;
  onClose: () => void;
}) {
  const [platform, setPlatform] = React.useState<AdPlatform>("meta");
  const [campaign, setCampaign] = React.useState("");
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [spend, setSpend] = React.useState("");
  const [impressions, setImpressions] = React.useState("");
  const [clicks, setClicks] = React.useState("");
  const [leads, setLeads] = React.useState("");
  const [revenue, setRevenue] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setPlatform(ad?.platform ?? "meta");
    setCampaign(ad?.campaign ?? "");
    setStart(ad?.period_start ?? "");
    setEnd(ad?.period_end ?? "");
    setSpend(ad ? String(ad.spend) : "");
    setImpressions(ad?.impressions != null ? String(ad.impressions) : "");
    setClicks(ad?.clicks != null ? String(ad.clicks) : "");
    setLeads(ad?.leads != null ? String(ad.leads) : "");
    setRevenue(ad?.revenue != null ? String(ad.revenue) : "");
  }, [open, ad]);

  async function handleSave() {
    setSubmitting(true);
    const input: AdInput = {
      id: ad?.id,
      platform,
      campaign,
      period_start: start,
      period_end: end,
      spend: Number(spend) || 0,
      impressions: impressions === "" ? null : Number(impressions),
      clicks: clicks === "" ? null : Number(clicks),
      leads: leads === "" ? null : Number(leads),
      revenue: revenue === "" ? null : Number(revenue),
    };
    const res = await saveAdEntry(input);
    setSubmitting(false);
    if (res.ok) {
      toast.success(ad ? "Campaign updated." : "Campaign logged.");
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={ad ? "Edit campaign" : "Log ad campaign"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={submitting}
            disabled={!campaign.trim() || !start || !end}
          >
            {ad ? "Save changes" : "Log campaign"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <Field label="Platform">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value as AdPlatform)}>
              {Object.entries(PLATFORM_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Campaign name" required>
            <Input value={campaign} onChange={(e) => setCampaign(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="From" required>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="To" required>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Spend (Rs.)" required>
            <Input value={spend} onChange={(e) => setSpend(e.target.value)} inputMode="decimal" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Impressions">
            <Input value={impressions} onChange={(e) => setImpressions(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Clicks">
            <Input value={clicks} onChange={(e) => setClicks(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Leads">
            <Input value={leads} onChange={(e) => setLeads(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Revenue (Rs.)">
            <Input value={revenue} onChange={(e) => setRevenue(e.target.value)} inputMode="decimal" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

// ============================ VISITORS ============================

export function VisitorsPanel({ events }: { events: VisitorEvent[] }) {
  const [origin, setOrigin] = React.useState("");
  React.useEffect(() => setOrigin(window.location.origin), []);

  const sites = Array.from(new Set(events.map((e) => e.site)));
  const [site, setSite] = React.useState<string>("all");
  const filtered = site === "all" ? events : events.filter((e) => e.site === site);

  const pageviews = filtered.filter((e) => e.kind === "pageview");
  const sessions = new Set(filtered.map((e) => e.session_id)).size;
  const formStarts = filtered.filter((e) => e.kind === "form_start").length;
  const formSubmits = filtered.filter((e) => e.kind === "form_submit").length;
  const formAbandons = filtered.filter((e) => e.kind === "form_abandon").length;

  const byPath = new Map<string, number>();
  for (const e of pageviews) byPath.set(e.path, (byPath.get(e.path) ?? 0) + 1);
  const topPages = Array.from(byPath.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const snippet = `<script src="${origin || "https://your-app"}/api/public/track" data-site="my-site" async></script>`;

  if (events.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={<MousePointerClick className="h-6 w-6" />}
          title="No visitor data yet"
          description="Add the tracking snippet to any website you manage. Pageviews, form starts, submits and abandons appear here within seconds."
        />
        <div className="mx-auto flex max-w-xl items-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-emerald-300">
            {snippet}
          </code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(snippet);
              toast.success("Snippet copied");
            }}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"
            aria-label="Copy snippet"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sites.length > 1 && (
        <Select value={site} onChange={(e) => setSite(e.target.value)} className="max-w-56">
          <option value="all">All sites</option>
          {sites.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MiniStat label="Pageviews (30d)" value={String(pageviews.length)} />
        <MiniStat label="Unique visitors" value={String(sessions)} />
        <MiniStat
          label="Form conversion"
          value={formStarts > 0 ? `${Math.round((formSubmits / formStarts) * 100)}%` : "—"}
        />
        <MiniStat
          label="Forms abandoned"
          value={String(formAbandons)}
          tone={formAbandons > formSubmits ? "text-rose-600" : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
          <h3 className="text-sm font-semibold text-slate-900">Top pages</h3>
          <div className="mt-3 space-y-2">
            {topPages.map(([path, count]) => (
              <div key={path}>
                <div className="flex justify-between text-xs">
                  <span className="truncate font-mono text-slate-600">{path}</span>
                  <span className="text-slate-400">{count}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                  <div
                    className="h-1.5 rounded-full bg-primary-400"
                    style={{ width: `${(count / (topPages[0]?.[1] ?? 1)) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
          <h3 className="text-sm font-semibold text-slate-900">Recent form activity</h3>
          <div className="mt-3 space-y-1.5">
            {filtered
              .filter((e) => e.kind.startsWith("form"))
              .slice(0, 10)
              .map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-xs">
                  <Badge
                    className={
                      e.kind === "form_submit"
                        ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                        : e.kind === "form_abandon"
                          ? "bg-rose-50 text-rose-600 ring-rose-200"
                          : "bg-slate-100 text-slate-600 ring-slate-200"
                    }
                  >
                    {e.kind.replace("form_", "")}
                  </Badge>
                  <span className="font-mono text-slate-500">{e.path}</span>
                  <span className="ml-auto text-slate-300">
                    {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                  </span>
                </div>
              ))}
            {filtered.filter((e) => e.kind.startsWith("form")).length === 0 && (
              <p className="text-sm text-slate-400">No form events yet.</p>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
        <Globe className="h-4 w-4 shrink-0 text-slate-500" />
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-emerald-300">
          {snippet}
        </code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(snippet);
            toast.success("Snippet copied");
          }}
          className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"
          aria-label="Copy snippet"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ============================ COMPETITORS ============================

const ENTRY_KINDS: { value: CompetitorEntryKind; label: string }[] = [
  { value: "price", label: "Price" },
  { value: "post", label: "Post" },
  { value: "ad", label: "Ad" },
  { value: "news", label: "News" },
  { value: "note", label: "Note" },
];

export function CompetitorsPanel({
  competitors,
  entries,
  aiReady,
}: {
  competitors: Competitor[];
  entries: CompetitorEntry[];
  aiReady: boolean;
}) {
  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Competitor | null>(null);

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteCompetitor(toDelete.id);
    if (res.ok) toast.success("Competitor removed.");
    else toast.error(res.error);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          Log competitor prices, posts and ads as you spot them; the AI turns the log into a
          monthly brief with counter-moves.
        </p>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          Add competitor
        </Button>
      </div>

      {competitors.length === 0 ? (
        <EmptyState
          icon={<Swords className="h-6 w-6" />}
          title="No competitors tracked"
          description="Add the agencies you keep losing deals to. Every observation you log builds the intelligence file."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {competitors.map((c) => (
            <CompetitorCard
              key={c.id}
              competitor={c}
              entries={entries.filter((e) => e.competitor_id === c.id)}
              aiReady={aiReady}
              onDelete={() => setToDelete(c)}
            />
          ))}
        </div>
      )}

      <CompetitorModal open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Remove this competitor?"
        description="Their observation log is deleted too."
      />
    </div>
  );
}

function CompetitorCard({
  competitor,
  entries,
  aiReady,
  onDelete,
}: {
  competitor: Competitor;
  entries: CompetitorEntry[];
  aiReady: boolean;
  onDelete: () => void;
}) {
  const [kind, setKind] = React.useState<CompetitorEntryKind>("note");
  const [content, setContent] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [summarizing, setSummarizing] = React.useState(false);

  async function handleAdd() {
    setAdding(true);
    const res = await addCompetitorEntry({ competitor_id: competitor.id, kind, content });
    setAdding(false);
    if (res.ok) setContent("");
    else toast.error(res.error);
  }

  async function handleSummarize() {
    setSummarizing(true);
    const res = await summarizeCompetitor(competitor.id);
    setSummarizing(false);
    if (res.ok) toast.success("AI brief updated.");
    else toast.error(res.error);
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{competitor.name}</h3>
          <p className="text-xs text-slate-400">
            {[competitor.website, competitor.facebook, competitor.instagram]
              .filter(Boolean)
              .join(" · ") || "No links saved"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSummarize}
            loading={summarizing}
            disabled={!aiReady}
            title={!aiReady ? "Needs OPENAI_API_KEY" : undefined}
          >
            <Sparkles className="h-3.5 w-3.5" />
            AI brief
          </Button>
          <button
            onClick={onDelete}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-500"
            aria-label="Remove competitor"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {competitor.ai_summary && (
        <div className="mt-3 rounded-xl bg-primary-50/70 p-3 text-sm leading-relaxed text-slate-700">
          <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-primary-600">
            <Sparkles className="h-3 w-3" />
            AI brief
            {competitor.ai_summary_at && (
              <span className="font-normal text-primary-400">
                · {formatDistanceToNow(new Date(competitor.ai_summary_at), { addSuffix: true })}
              </span>
            )}
          </p>
          <p className="whitespace-pre-line">{competitor.ai_summary}</p>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <Select
          value={kind}
          onChange={(e) => setKind(e.target.value as CompetitorEntryKind)}
          className="w-24 shrink-0"
        >
          {ENTRY_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
        <Input
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && content.trim() && handleAdd()}
          placeholder="e.g. Dropped website package to Rs. 60k"
        />
        <Button size="sm" onClick={handleAdd} loading={adding} disabled={!content.trim()}>
          Log
        </Button>
      </div>

      {entries.length > 0 && (
        <div className="mt-3 max-h-44 space-y-1.5 overflow-y-auto">
          {entries.map((e) => (
            <div key={e.id} className="flex items-start gap-2 text-xs">
              <Badge className="mt-0.5 shrink-0 bg-slate-100 text-slate-500 ring-slate-200">
                {e.kind}
              </Badge>
              <span className="text-slate-600">{e.content}</span>
              <span className="ml-auto shrink-0 text-slate-300">
                {new Date(e.created_at).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CompetitorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = React.useState("");
  const [website, setWebsite] = React.useState("");
  const [facebook, setFacebook] = React.useState("");
  const [instagram, setInstagram] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function handleCreate() {
    setSubmitting(true);
    const res = await saveCompetitor({ name, website, facebook, instagram });
    setSubmitting(false);
    if (res.ok) {
      toast.success("Competitor added — start logging observations.");
      setName("");
      setWebsite("");
      setFacebook("");
      setInstagram("");
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add competitor"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleCreate} loading={submitting} disabled={!name.trim()}>
            Add competitor
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Website">
          <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Facebook">
            <Input value={facebook} onChange={(e) => setFacebook(e.target.value)} />
          </Field>
          <Field label="Instagram">
            <Input value={instagram} onChange={(e) => setInstagram(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

// ============================ TOOLKIT ============================

export function ToolkitPanel({ aiReady }: { aiReady: boolean }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ReviewReplyCard aiReady={aiReady} />
      <VoiceReceptionistCard />
    </div>
  );
}

function ReviewReplyCard({ aiReady }: { aiReady: boolean }) {
  const [review, setReview] = React.useState("");
  const [reviewer, setReviewer] = React.useState("");
  const [rating, setRating] = React.useState(5);
  const [reply, setReply] = React.useState("");
  const [drafting, setDrafting] = React.useState(false);

  async function handleDraft() {
    setDrafting(true);
    const res = await draftReviewReply({ review, rating, reviewer });
    setDrafting(false);
    if (res.ok) setReply(res.reply);
    else toast.error(res.error);
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2">
        <Star className="h-4 w-4 text-amber-500" />
        <h3 className="text-sm font-semibold text-slate-900">Google review replies</h3>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Paste a Google Business Profile review, get a ready-to-post reply
        {aiReady ? " drafted by AI" : " (template mode — add an OpenAI key for tailored drafts)"}.
      </p>
      <div className="mt-4 space-y-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
          <Input
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            placeholder="Reviewer name (optional)"
          />
          <Select value={String(rating)} onChange={(e) => setRating(Number(e.target.value))}>
            {[5, 4, 3, 2, 1].map((r) => (
              <option key={r} value={r}>
                {"★".repeat(r)}
              </option>
            ))}
          </Select>
        </div>
        <Textarea
          value={review}
          onChange={(e) => setReview(e.target.value)}
          rows={3}
          placeholder="Paste the review here…"
        />
        <Button size="sm" onClick={handleDraft} loading={drafting} disabled={!review.trim()}>
          <Sparkles className="h-3.5 w-3.5" />
          Draft reply
        </Button>
        {reply && (
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="whitespace-pre-line text-sm text-slate-700">{reply}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => {
                navigator.clipboard.writeText(reply);
                toast.success("Reply copied — paste it into Google.");
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy reply
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function VoiceReceptionistCard() {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2">
        <Phone className="h-4 w-4 text-primary-500" />
        <h3 className="text-sm font-semibold text-slate-900">AI voice receptionist</h3>
        <Badge className="bg-primary-50 text-primary-600 ring-primary-200">Flagship tier</Badge>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-500">
        The in-app AI assistant already speaks and books meetings. To answer real phone calls it
        needs a telephony provider on top:
      </p>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-slate-600">
        <li>Get a Twilio (or Dialog Axiata IVR) number.</li>
        <li>
          Point its voice webhook at a relay that pipes audio to{" "}
          <code className="rounded bg-slate-100 px-1 text-xs">/api/assistant/chat</code> — the
          assistant answers FAQs and books meetings via the same tools it uses here.
        </li>
        <li>Missed-call fallback: an inbound webhook can log every caller as a CRM lead today.</li>
      </ol>
      <div className="mt-3 flex items-center gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
        <Bot className="h-4 w-4 shrink-0 text-slate-400" />
        Until the phone line is wired, share your meeting-booking link on the “missed call” SMS —
        that flow works end-to-end right now via Automation → Recipes.
      </div>
    </div>
  );
}
