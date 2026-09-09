"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { format } from "date-fns";
import { Check, ChevronDown, Download, ExternalLink, Loader2, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Textarea } from "@/components/ui/input";
import type {
  OfficeAgentView,
  OfficeCarouselLite,
  OfficeEventRow,
  OfficeMissionRow,
  OfficeSocialAccountLite,
  OfficeTaskRow,
} from "@/lib/agents/office-types";
import type { CarouselOption, CarouselPost } from "@/lib/types";
import { cn } from "@/lib/utils";

import { CarouselReview, downloadOptionZip } from "../carousel-review";
import { approveMissionOutput, cancelMission, requestMissionRevision, retryTask, scheduleFromProposal } from "../office-actions";
import { AgentDot, MissionBadge, SectionTitle, TaskBadge, relTime, usd } from "./office-ui";

/**
 * One mission, end to end (0130): the brief, the plan as the team worked it,
 * every deliverable, the drafts in the render queue, and the decision —
 * approve, approve & schedule, ask for changes, or cancel.
 */
export function MissionDrawer({
  mission,
  tasks,
  events,
  carousels,
  carouselPosts,
  carouselOptions,
  clients,
  agents,
  socialAccounts,
  canDirect,
  onClose,
}: {
  mission: OfficeMissionRow | null;
  tasks: OfficeTaskRow[];
  events: OfficeEventRow[];
  carousels: OfficeCarouselLite[];
  carouselPosts: CarouselPost[];
  carouselOptions: CarouselOption[];
  clients: { id: string; name: string }[];
  agents: OfficeAgentView[];
  socialAccounts: OfficeSocialAccountLite[];
  /** 0132 — false for members: they read the mission, they never decide it. */
  canDirect: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  React.useEffect(() => {
    if (!mission) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mission, onClose]);
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {mission && (
        <div className="fixed inset-0 z-[75]">
          <motion.div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside
            role="dialog"
            aria-modal="true"
            className="absolute inset-y-0 right-0 flex w-full max-w-[640px] flex-col bg-white shadow-[var(--shadow-lift)]"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 28 }}
          >
            <DrawerBody
              key={mission.id}
              mission={mission}
              tasks={tasks.filter((t) => t.mission_id === mission.id)}
              events={events.filter((e) => e.mission_id === mission.id)}
              carousels={carousels.filter((c) => c.mission_id === mission.id)}
              carouselPosts={carouselPosts}
              carouselOptions={carouselOptions}
              clients={clients}
              agents={agents}
              socialAccounts={socialAccounts}
              canDirect={canDirect}
              onClose={onClose}
            />
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function DrawerBody({
  mission,
  tasks,
  events,
  carousels,
  carouselPosts,
  carouselOptions,
  clients,
  agents,
  socialAccounts,
  canDirect,
  onClose,
}: {
  mission: OfficeMissionRow;
  tasks: OfficeTaskRow[];
  events: OfficeEventRow[];
  carousels: OfficeCarouselLite[];
  carouselPosts: CarouselPost[];
  carouselOptions: CarouselOption[];
  clients: { id: string; name: string }[];
  agents: OfficeAgentView[];
  socialAccounts: OfficeSocialAccountLite[];
  canDirect: boolean;
  onClose: () => void;
}) {
  const agentByKey = React.useMemo(() => new Map<string, OfficeAgentView>(agents.map((a) => [a.key, a])), [agents]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [reviewId, setReviewId] = React.useState<string | null>(null);

  const waves = React.useMemo(() => orderByWave(tasks), [tasks]);
  const decidable = canDirect && (mission.status === "review" || mission.status === "approved");
  const proposal = React.useMemo(() => {
    const pub = tasks.filter((t) => t.agent_key === "publisher" && t.status === "done").at(-1);
    const items = (pub?.output as { items?: unknown[] } | null)?.items;
    return Array.isArray(items) ? (items as { carousel_post_id: string; account_id: string | null; scheduled_for: string; platform: string }[]) : [];
  }, [tasks]);

  // Schedule form: one row per drafted carousel.
  const [rows, setRows] = React.useState<Record<string, { accountIds: string[]; when: string }>>({});
  React.useEffect(() => {
    setRows((prev) => {
      const next = { ...prev };
      for (const c of carousels) {
        if (next[c.id]) continue;
        const p = proposal.find((it) => it.carousel_post_id === c.id);
        const when = p?.scheduled_for ? toLocalInput(p.scheduled_for) : `${c.scheduled_for}T09:00`;
        const account = p?.account_id && socialAccounts.some((a) => a.id === p.account_id) ? [p.account_id] : socialAccounts.length === 1 ? [socialAccounts[0].id] : [];
        next[c.id] = { accountIds: account, when };
      }
      return next;
    });
  }, [carousels, proposal, socialAccounts]);

  async function run(label: string, fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setBusy(label);
    try {
      const res = await fn();
      if (!res.ok) return toast.error(res.error ?? "Something went wrong.");
      toast.success(success);
    } finally {
      setBusy(null);
    }
  }

  const reviewPost = reviewId ? carouselPosts.find((p) => p.id === reviewId) : null;
  const readyToSchedule = carousels.filter((c) => c.chosen_option_id && c.rendered > 0);

  return (
    <>
      <header className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <MissionBadge status={mission.status} />
            <span className="text-xs text-slate-500">
              {mission.mode === "direct" ? "Direct task" : "Directed mission"} · {usd(Number(mission.cost_usd))} · {relTime(mission.created_at)}
            </span>
          </div>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">{mission.title}</h2>
        </div>
        <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
        <section>
          <SectionTitle>The brief</SectionTitle>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-700">{mission.goal}</p>
          <OptionsLine mission={mission} />
          {mission.error && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{mission.error}</p>}
        </section>

        {mission.summary && Object.keys(mission.summary).length > 0 && mission.mode !== "direct" && (
          <section>
            <SectionTitle>What the Director says</SectionTitle>
            <ReviewSummary summary={mission.summary} />
          </section>
        )}

        <section>
          <SectionTitle right={<span className="text-xs text-slate-400">{tasks.filter((t) => t.status === "done").length}/{tasks.length} done</span>}>The team&apos;s work</SectionTitle>
          <ol className="mt-2 space-y-2">
            {waves.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                agent={agentByKey.get(t.agent_key)}
                canDirect={canDirect}
                onRetry={() => run(`retry:${t.id}`, () => retryTask(t.id), "Back on the floor.")}
                busy={busy === `retry:${t.id}`}
              />
            ))}
            {!tasks.length && <li className="text-sm text-slate-500">No tasks yet.</li>}
          </ol>
        </section>

        {carousels.length > 0 && (
          <section>
            <SectionTitle>Drafts in the render queue</SectionTitle>
            <ul className="mt-2 space-y-2">
              {carousels.map((c) => (
                <li key={c.id} className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900">{c.topic}</div>
                    <div className="text-xs text-slate-500">
                      {c.scheduled_for} · {c.status === "rendering" ? `Designing ${c.rendered}/${c.total} slides` : c.status} · {c.chosen_option_id ? "design picked" : "no design picked yet"}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setReviewId(c.id)} disabled={!carouselPosts.some((p) => p.id === c.id)}>
                    Review designs
                  </Button>
                  {c.chosen_option_id && c.rendered > 0 && (
                    <Button
                      size="sm"
                      title="Download the slides and the caption to post by hand"
                      onClick={() => {
                        const post = carouselPosts.find((p) => p.id === c.id);
                        const option = carouselOptions.find((o) => o.id === c.chosen_option_id);
                        if (post && option) void downloadOptionZip(post, option);
                        else toast.error("Refresh the page to download this one.");
                      }}
                    >
                      <Download className="h-3.5 w-3.5" /> Download
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {!canDirect && (mission.status === "review" || mission.status === "approved") && (
          <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <SectionTitle>Waiting for an admin</SectionTitle>
            <p className="mt-1.5 text-sm text-slate-600">
              The team has finished. An admin approves the work and schedules or downloads the posts.
            </p>
          </section>
        )}

        {decidable && (
          <section className="rounded-2xl border border-orange-200 bg-orange-50/60 p-4">
            <SectionTitle>Your decision</SectionTitle>
            {mission.mode === "direct" ? (
              <p className="mt-1.5 text-sm text-slate-700">The agent finished. Approve to close it, or ask for changes below.</p>
            ) : carousels.length ? (
              <>
                <p className="mt-1.5 text-sm text-slate-700">
                  Pick a design for each draft (Review designs), then <strong>Download</strong> the slides and caption and post them yourself. Approve closes the mission.
                  {socialAccounts.length ? " Scheduling to a connected account is optional." : ""}
                </p>
                <div className="mt-3 space-y-3">
                  {carousels.map((c) => {
                    const row = rows[c.id] ?? { accountIds: [], when: "" };
                    const canQueue = Boolean(c.chosen_option_id) && c.rendered > 0;
                    return (
                      <div key={c.id} className={cn("rounded-xl bg-white p-3 ring-1 ring-slate-200", !canQueue && "opacity-70")}>
                        <div className="text-sm font-medium text-slate-900">{c.topic}</div>
                        {!canQueue && <div className="text-xs text-amber-700">Pick a rendered design first.</div>}
                        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                          <div className="flex flex-wrap gap-1.5">
                            {socialAccounts.length ? (
                              socialAccounts.map((a) => {
                                const on = row.accountIds.includes(a.id);
                                return (
                                  <button
                                    key={a.id}
                                    type="button"
                                    onClick={() =>
                                      setRows((prev) => ({
                                        ...prev,
                                        [c.id]: { ...row, accountIds: on ? row.accountIds.filter((x) => x !== a.id) : [...row.accountIds, a.id] },
                                      }))
                                    }
                                    className={cn(
                                      "rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1",
                                      on ? "bg-primary-50 text-primary-700 ring-primary-200" : "bg-white text-slate-600 ring-slate-200",
                                    )}
                                  >
                                    {a.platform === "instagram" ? "IG" : "FB"} · {a.name}
                                  </button>
                                );
                              })
                            ) : (
                              <span className="text-xs text-slate-500">No social accounts are connected — connect one in Settings, or download the slides from Review designs.</span>
                            )}
                          </div>
                          <input
                            type="datetime-local"
                            value={row.when}
                            onChange={(e) => setRows((prev) => ({ ...prev, [c.id]: { ...row, when: e.target.value } }))}
                            className="h-9 rounded-lg border border-slate-200 px-2 text-xs"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="mt-1.5 text-sm text-slate-700">No drafts were made in this mission. Approve to close it, or ask for changes.</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {mission.mode !== "direct" && readyToSchedule.length > 0 && socialAccounts.length > 0 && (
                <Button
                  disabled={busy !== null}
                  onClick={() =>
                    run(
                      "schedule",
                      async () => {
                        const items = readyToSchedule
                          .map((c) => ({ carouselPostId: c.id, accountIds: rows[c.id]?.accountIds ?? [], scheduledFor: new Date(rows[c.id]?.when ?? "").toISOString() }))
                          .filter((i) => i.accountIds.length && i.scheduledFor);
                        if (!items.length) return { ok: false, error: "Pick at least one account and a time." };
                        const res = await scheduleFromProposal(mission.id, items);
                        if (!res.ok) return res;
                        if (res.problems.length) toast.warning(res.problems.join("\n"));
                        if (res.queued) await approveMissionOutput(mission.id);
                        return { ok: true };
                      },
                      "Scheduled — see the Publishing tab.",
                    )
                  }
                >
                  {busy === "schedule" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Approve &amp; schedule
                </Button>
              )}
              <Button variant={mission.mode === "direct" ? "primary" : "outline"} disabled={busy !== null} onClick={() => run("approve", () => approveMissionOutput(mission.id), "Approved.")}>
                {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Approve
              </Button>
            </div>
            <div className="mt-3">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Ask for changes — e.g. “make slide 1 punchier and drop the second hashtag set”" />
              <div className="mt-2 flex justify-end">
                <Button variant="secondary" size="sm" disabled={busy !== null || note.trim().length < 4} onClick={() => run("revise", () => requestMissionRevision(mission.id, note), "The team is on the changes.").then(() => setNote(""))}>
                  <RotateCcw className="h-3.5 w-3.5" /> Request changes
                </Button>
              </div>
            </div>
          </section>
        )}

        {canDirect && (mission.status === "failed" || mission.status === "paused") && (
          <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
            <SectionTitle>Stopped</SectionTitle>
            <p className="mt-1.5 text-sm text-slate-700">Retry the failed task above, or ask for changes with a note.</p>
            <div className="mt-3">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What should change?" />
              <div className="mt-2 flex justify-end">
                <Button variant="secondary" size="sm" disabled={busy !== null || note.trim().length < 4} onClick={() => run("revise", () => requestMissionRevision(mission.id, note), "Re-planned.").then(() => setNote(""))}>
                  <RotateCcw className="h-3.5 w-3.5" /> Re-plan with a note
                </Button>
              </div>
            </div>
          </section>
        )}

        <section>
          <SectionTitle>Feed</SectionTitle>
          <ul className="mt-2 space-y-1.5">
            {[...events].reverse().slice(0, 30).map((e) => (
              <li key={e.id} className="flex items-start gap-2 text-xs text-slate-600">
                <AgentDot color={agentByKey.get(e.agent_key)?.color ?? "#94a3b8"} className="mt-1" />
                <span className="min-w-0 flex-1">
                  {e.message} <span className="text-slate-400">{relTime(e.created_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-slate-100 px-5 py-3">
        <span className="text-xs text-slate-400">Mission {mission.id.slice(0, 8)}</span>
        {canDirect && !["done", "cancelled"].includes(mission.status) && (
          <Button variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50" onClick={() => setConfirmCancel(true)} disabled={busy !== null}>
            Cancel mission
          </Button>
        )}
      </footer>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this mission?"
        description="Running work is stopped. Drafts already in the render queue stay in the Calendar."
        onConfirm={async () => {
          await run("cancel", () => cancelMission(mission.id), "Cancelled.");
          setConfirmCancel(false);
        }}
      />

      {reviewPost && (
        <CarouselReview post={reviewPost} options={carouselOptions.filter((o) => o.post_id === reviewPost.id)} clients={clients} onClose={() => setReviewId(null)} />
      )}
    </>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return format(d, "yyyy-MM-dd'T'HH:mm");
}

function OptionsLine({ mission }: { mission: OfficeMissionRow }) {
  const o = mission.options ?? {};
  const parts = [
    o.platforms?.length ? o.platforms.join(" + ") : null,
    o.postCount ? `${o.postCount} post${o.postCount === 1 ? "" : "s"}` : null,
    o.dateFrom || o.dateTo ? `${o.dateFrom ?? "now"} → ${o.dateTo ?? "open"}` : null,
    o.autoPublish ? "auto-publish on" : null,
    mission.revision_round ? `revision round ${mission.revision_round}` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <p className="mt-1 text-xs text-slate-500">{parts.join(" · ")}</p>;
}

function ReviewSummary({ summary }: { summary: Record<string, unknown> }) {
  const text = typeof summary.summary === "string" ? summary.summary : null;
  const highlights = Array.isArray(summary.highlights) ? (summary.highlights as string[]) : [];
  const concerns = Array.isArray(summary.concerns) ? (summary.concerns as string[]) : [];
  const note = typeof summary.note === "string" ? summary.note : null;
  return (
    <div className="mt-1.5 space-y-2 text-sm">
      {text && <p className="text-slate-700">{text}</p>}
      {highlights.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-slate-700">
          {highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}
      {concerns.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
          <div className="text-xs font-semibold uppercase tracking-wide">Look at</div>
          <ul className="list-disc pl-5">
            {concerns.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {note && <p className="text-xs text-slate-500">{note}</p>}
    </div>
  );
}

/** Topological order by dependency depth, then creation. */
function orderByWave(tasks: OfficeTaskRow[]): OfficeTaskRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const depth = new Map<string, number>();
  const d = (t: OfficeTaskRow, seen = new Set<string>()): number => {
    if (depth.has(t.id)) return depth.get(t.id)!;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const v = t.depends_on.length ? 1 + Math.max(...t.depends_on.map((id) => (byId.get(id) ? d(byId.get(id)!, seen) : 0))) : 0;
    depth.set(t.id, v);
    return v;
  };
  return [...tasks].sort((a, b) => d(a) - d(b) || a.created_at.localeCompare(b.created_at));
}

function TaskRow({ task, agent, canDirect, onRetry, busy }: { task: OfficeTaskRow; agent?: OfficeAgentView; canDirect: boolean; onRetry: () => void; busy: boolean }) {
  const [open, setOpen] = React.useState(false);
  return (
    <li className="rounded-xl border border-slate-200">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
        <AgentDot color={agent?.color ?? "#94a3b8"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-900">{agent?.name ?? task.agent_key}</span>
            <span className="truncate text-sm text-slate-600">{task.title}</span>
            <TaskBadge status={task.status} />
            {task.revision_round > 0 && <span className="text-[11px] text-slate-400">r{task.revision_round}</span>}
          </div>
          <div className="text-xs text-slate-500">
            {task.step || (task.status === "queued" ? "Waiting for the steps before it" : "")}
            {task.model ? ` · ${task.model}` : ""}
            {Number(task.cost_usd) ? ` · ${usd(Number(task.cost_usd))}` : ""}
          </div>
        </div>
        <ChevronDown className={cn("h-4 w-4 text-slate-400 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-slate-100 px-3 py-3 text-sm">
          {task.instructions && (
            <p className="mb-2 whitespace-pre-wrap text-xs text-slate-500">{task.instructions.slice(0, 600)}{task.instructions.length > 600 ? "…" : ""}</p>
          )}
          {task.error && <p className="mb-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{task.error}</p>}
          {task.output ? <Deliverable kind={String(task.input?.deliverable ?? "")} output={task.output} /> : <p className="text-xs text-slate-400">No output yet.</p>}
          {canDirect && (task.status === "failed" || task.status === "blocked" || task.status === "cancelled") && (
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Retry
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ---- Deliverable renderers ----------------------------------------------------------

type Rec = Record<string, unknown>;
const list = (v: unknown): Rec[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Rec[]) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function Deliverable({ kind, output }: { kind: string; output: Rec }) {
  switch (kind) {
    case "research_brief":
      return (
        <div className="space-y-2">
          {typeof output.summary === "string" && <p className="text-slate-700">{output.summary}</p>}
          <ul className="space-y-1.5">
            {list(output.findings).map((f, i) => (
              <li key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-xs">
                <div className="text-slate-800">{String(f.claim)}</div>
                <a href={String(f.source_url)} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-sky-700 hover:underline">
                  <ExternalLink className="h-3 w-3" /> {String(f.source_title || f.source_url)}
                </a>
                <span className="ml-2 text-slate-400">confidence {String(f.confidence)}</span>
              </li>
            ))}
          </ul>
          {strs(output.angles).length > 0 && <Chips label="Angles" items={strs(output.angles)} />}
          {strs(output.risks).length > 0 && <Chips label="Risks" items={strs(output.risks)} />}
        </div>
      );
    case "content_plan":
      return (
        <div className="space-y-2">
          {typeof output.rationale === "string" && <p className="text-xs text-slate-600">{output.rationale}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-slate-400">
                <tr>
                  <th className="py-1 pr-2">Date</th>
                  <th className="py-1 pr-2">Topic</th>
                  <th className="py-1 pr-2">Pillar</th>
                  <th className="py-1">Hook</th>
                </tr>
              </thead>
              <tbody>
                {list(output.posts).map((p, i) => (
                  <tr key={i} className="border-t border-slate-100 align-top">
                    <td className="py-1.5 pr-2 whitespace-nowrap text-slate-700">{String(p.date)}</td>
                    <td className="py-1.5 pr-2 text-slate-900">{String(p.topic)}</td>
                    <td className="py-1.5 pr-2 text-slate-600">{String(p.pillar)}</td>
                    <td className="py-1.5 text-slate-600">{String(p.hook)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case "post_copy":
      return (
        <div className="space-y-2 text-xs">
          <p className="whitespace-pre-wrap text-slate-800">{String(output.caption ?? "")}</p>
          <p className="text-sky-700">{strs(output.hashtags).join(" ")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {list(output.options).map((o, i) => (
              <div key={i} className="rounded-lg bg-slate-50 p-2">
                <div className="mb-1 font-semibold text-slate-700">Concept {i + 1}</div>
                <div className="mb-1 text-slate-500">{String(o.concept)}</div>
                <ol className="list-decimal space-y-0.5 pl-4">
                  {list(o.slides).map((s, j) => (
                    <li key={j}>
                      <span className="font-medium text-slate-800">{String(s.headline)}</span>
                      {s.body ? <span className="text-slate-600"> — {String(s.body)}</span> : null}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </div>
      );
    case "carousel_draft":
      return (
        <div className="space-y-1 text-xs">
          {list(output.art_direction).map((a, i) => (
            <div key={i} className="rounded-lg bg-slate-50 px-3 py-2">
              <span className="font-semibold text-slate-700">Concept {String(a.variant)}</span> · {String(a.palette)} · {String(a.layout)} · {String(a.typography)} · {String(a.imagery)}
            </div>
          ))}
          {typeof output.notes === "string" && output.notes && <p className="text-slate-600">{output.notes}</p>}
        </div>
      );
    case "brand_review":
    case "qa_report":
      return (
        <div className="space-y-2 text-xs">
          <div className={cn("inline-flex rounded-full px-2.5 py-1 font-semibold ring-1", output.verdict === "pass" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200")}>
            {output.verdict === "pass" ? "Pass" : "Needs changes"}
            {typeof output.score === "number" ? ` · ${output.score}/100` : ""}
          </div>
          {list(output.checks).length > 0 && (
            <ul className="grid gap-1 sm:grid-cols-2">
              {list(output.checks).map((c, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full", c.ok ? "bg-emerald-500" : "bg-rose-500")} />
                  <span className="text-slate-700">
                    <span className="font-medium">{String(c.name).replace(/_/g, " ")}</span>
                    {c.detail ? ` — ${String(c.detail)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {list(output.fixes).length > 0 && (
            <ol className="list-decimal space-y-0.5 pl-4 text-slate-700">
              {list(output.fixes).map((f, i) => (
                <li key={i}>
                  <span className="font-medium">[{String(f.target)}]</span> {String(f.instruction)}
                </li>
              ))}
            </ol>
          )}
          {typeof output.notes === "string" && output.notes && <p className="text-slate-600">{output.notes}</p>}
          {typeof output.rewritten_caption === "string" && output.rewritten_caption && (
            <div className="rounded-lg bg-slate-50 px-3 py-2 whitespace-pre-wrap text-slate-800">{output.rewritten_caption}</div>
          )}
        </div>
      );
    case "schedule_proposal":
      return (
        <div className="space-y-1 text-xs">
          {typeof output.notes === "string" && output.notes && <p className="text-slate-600">{output.notes}</p>}
          {list(output.items).map((it, i) => (
            <div key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-slate-700">
              <span className="font-medium capitalize">{String(it.platform)}</span> · {new Date(String(it.scheduled_for)).toLocaleString()} — {String(it.reason)}
            </div>
          ))}
        </div>
      );
    case "plan":
      return (
        <ol className="list-decimal space-y-0.5 pl-4 text-xs text-slate-700">
          {list(output.tasks).map((t, i) => (
            <li key={i}>
              <span className="font-medium">{String(t.agent)}</span>: {String(t.title)}
              {strs(t.depends_on).length ? <span className="text-slate-400"> (after {strs(t.depends_on).join(", ")})</span> : null}
            </li>
          ))}
        </ol>
      );
    case "review":
      return <ReviewSummary summary={output} />;
    case "report":
      return (
        <div className="space-y-3 text-xs">
          {typeof output.summary === "string" && <p className="whitespace-pre-wrap text-sm text-slate-700">{output.summary}</p>}
          {list(output.findings).length > 0 && (
            <ul className="space-y-1">
              {list(output.findings).map((f, i) => (
                <li key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
                  {String(f.point)}
                  {typeof f.source_url === "string" && f.source_url && (
                    <a href={f.source_url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 text-sky-700 hover:underline">
                      <ExternalLink className="h-3 w-3" /> source
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          {list(output.deliverables).map((d, i) => (
            <div key={i} className="rounded-xl border border-slate-200 p-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{String(d.kind)}</span>
                <span className="font-semibold text-slate-800">{String(d.title)}</span>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-sans text-xs text-slate-700">{String(d.content)}</pre>
            </div>
          ))}
          {Number(output.messages_prepared) > 0 && (
            <a href="/dashboard" className="inline-flex items-center gap-1 rounded-lg bg-orange-50 px-3 py-2 font-medium text-orange-700 ring-1 ring-orange-200 hover:bg-orange-100">
              {Number(output.messages_prepared)} message{Number(output.messages_prepared) === 1 ? "" : "s"} waiting for your approval in the Arcus tray <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {strs(output.next_steps).length > 0 && <Chips label="Next" items={strs(output.next_steps)} />}
        </div>
      );
    default:
      return <pre className="max-h-64 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] text-slate-700">{JSON.stringify(output, null, 2)}</pre>;
  }
}

function Chips({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[10px] uppercase tracking-wide text-slate-400">{label}</span>
      {items.map((it, i) => (
        <span key={i} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
          {it}
        </span>
      ))}
    </div>
  );
}
