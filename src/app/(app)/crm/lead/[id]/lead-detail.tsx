"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Building2,
  CalendarPlus,
  Check,
  FileSignature,
  Mail,
  MessageSquareText,
  NotebookPen,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  ScanSearch,
  Send,
  Sparkles,
  Tag,
  ThumbsDown,
  Trash2,
  Trophy,
  Users,
  Zap,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { LeadFormModal } from "@/components/crm/lead-form-modal";
import { daysInactive } from "@/components/crm/lead-card";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import { cn, formatCurrency } from "@/lib/utils";
import type {
  CrmField,
  CrmTask,
  LeadActivity,
  LeadActivityKind,
  LeadOutreach,
  LeadResearch,
  LeadWithAssignee,
  MemberLite,
  Pipeline,
  PipelineStage,
  Quote,
} from "@/lib/types";
import { ResearchReportView } from "@/components/crm/research-report-view";
import {
  ResearchProgress,
  researchStartedAt,
} from "@/components/crm/research-progress";
import { requestLeadResearch } from "../../research/actions";
import { useDriveResearch } from "../../research/use-drive-research";

import {
  addLeadActivity,
  aiLeadAssist,
  approveLeadOutreach,
  deleteCrmTask,
  discardLeadOutreach,
  prepareLeadOutreach,
  saveCrmTask,
  saveOutreachDraft,
  setLeadStatus,
  toggleCrmTask,
  trashLead,
  updateLeadPositions,
} from "../../actions";

const ACTIVITY_ICON: Partial<Record<LeadActivityKind, React.ReactNode>> = {
  created: <Plus className="h-3.5 w-3.5" />,
  note: <NotebookPen className="h-3.5 w-3.5" />,
  call: <Phone className="h-3.5 w-3.5" />,
  email: <Mail className="h-3.5 w-3.5" />,
  sms: <MessageSquareText className="h-3.5 w-3.5" />,
  meeting: <Users className="h-3.5 w-3.5" />,
  quote: <FileSignature className="h-3.5 w-3.5" />,
  automation: <Zap className="h-3.5 w-3.5" />,
};

const ACTIVITY_TONE: Partial<Record<LeadActivityKind, string>> = {
  created: "bg-emerald-500",
  note: "bg-slate-400",
  call: "bg-primary-500",
  email: "bg-sky-500",
  sms: "bg-cyan-500",
  meeting: "bg-violet-500",
  stage_changed: "bg-orange-400",
  field_changed: "bg-slate-300",
  quote: "bg-fuchsia-500",
  automation: "bg-amber-500",
  merged: "bg-slate-500",
  restored: "bg-emerald-400",
  score: "bg-rose-400",
};

export function LeadDetail({
  lead,
  activities,
  tasks,
  quotes,
  customFields,
  stages,
  pipeline,
  research,
  outreach,
  members,
}: {
  lead: LeadWithAssignee;
  activities: LeadActivity[];
  tasks: CrmTask[];
  quotes: Quote[];
  customFields: CrmField[];
  stages: PipelineStage[];
  pipeline: Pipeline | null;
  research: LeadResearch | null;
  outreach: LeadOutreach | null;
  members: MemberLite[];
}) {
  useRealtimeSyncTables([
    "leads",
    "lead_activities",
    "crm_tasks",
    "lead_research",
    "lead_outreach",
  ]);
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmTrash, setConfirmTrash] = React.useState(false);
  const [lostOpen, setLostOpen] = React.useState(false);

  const idle = daysInactive(lead);
  const stale =
    lead.status === "open" && idle >= (pipeline?.stale_after_days ?? 7);
  const stage = stages.find((s) => s.id === lead.stage_id);

  async function handleStage(stageId: string) {
    const res = await updateLeadPositions([
      { id: lead.id, stage_id: stageId, position: 0 },
    ]);
    if (!res.ok) toast.error(res.error);
    else router.refresh();
  }

  async function handleWon() {
    const res = await setLeadStatus(lead.id, "won");
    if (res.ok) {
      toast.success("Deal won! 🎉");
      router.refresh();
    } else toast.error(res.error);
  }

  async function handleReopen() {
    const res = await setLeadStatus(lead.id, "open");
    if (res.ok) router.refresh();
    else toast.error(res.error);
  }

  async function handleTrash() {
    const res = await trashLead(lead.id);
    if (res.ok) {
      toast.success("Moved to trash — restore it from CRM → Trash.");
      router.push("/crm");
    } else toast.error(res.error);
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/crm"
          className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:text-slate-800 sm:h-9 sm:w-9"
          aria-label="Back to CRM"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight text-slate-900">
            {lead.title}
          </h1>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
            {lead.company && (
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                {lead.company}
              </span>
            )}
            <span>source: {lead.source}</span>
            <span>· added {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}</span>
          </p>
        </div>

        <span className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
          {lead.value != null && (
            <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
              {formatCurrency(Number(lead.value), lead.currency)}
            </Badge>
          )}
          {lead.score && (
            <Badge
              className={
                lead.score === "hot"
                  ? "bg-rose-50 text-rose-600 ring-rose-200"
                  : lead.score === "warm"
                    ? "bg-amber-50 text-amber-600 ring-amber-200"
                    : "bg-sky-50 text-sky-600 ring-sky-200"
              }
            >
              {lead.score === "hot" ? "🔥 Hot" : lead.score === "warm" ? "🌤 Warm" : "🧊 Cold"}
            </Badge>
          )}
          {stale && (
            <Badge className="bg-amber-50 text-amber-600 ring-amber-200">{idle}d idle</Badge>
          )}
          {outreach?.status === "sent" && (
            <Badge className="bg-sky-50 text-sky-600 ring-sky-200">✉️ Email Sent</Badge>
          )}
          {outreach?.status === "ready" && (
            <Badge className="bg-amber-50 text-amber-600 ring-amber-200">✍️ Draft Ready</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditOpen(true)}
            className="h-10 sm:h-9"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          {lead.status === "open" ? (
            <>
              <Button
                size="sm"
                onClick={handleWon}
                className="h-10 bg-emerald-600 hover:bg-emerald-500 sm:h-9"
              >
                <Trophy className="h-3.5 w-3.5" />
                Won
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLostOpen(true)}
                className="h-10 text-slate-500 sm:h-9"
              >
                <ThumbsDown className="h-3.5 w-3.5" />
                Lost
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleReopen}
              className="h-10 sm:h-9"
            >
              Reopen
            </Button>
          )}
          <button
            onClick={() => setConfirmTrash(true)}
            className="grid h-10 w-10 place-items-center rounded-xl text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 sm:h-9 sm:w-9"
            aria-label="Move to trash"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </span>
      </div>

      {/* Status banner + stage stepper */}
      {lead.status === "won" && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
          🎉 Won {lead.won_at && formatDistanceToNow(new Date(lead.won_at), { addSuffix: true })}
        </div>
      )}
      {lead.status === "lost" && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Lost{lead.lost_reason ? ` — ${lead.lost_reason}` : ""}
        </div>
      )}
      {lead.status === "open" && stages.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {stages.map((s) => {
            const reached =
              stage && stages.findIndex((x) => x.id === s.id) <= stages.findIndex((x) => x.id === stage.id);
            return (
              <button
                key={s.id}
                onClick={() => handleStage(s.id)}
                className={cn(
                  "rounded-xl border px-3 py-2 text-xs font-semibold transition-colors sm:py-1.5",
                  s.id === lead.stage_id
                    ? "text-white shadow-sm"
                    : reached
                      ? "border-transparent text-slate-600"
                      : "border-slate-200 bg-white text-slate-400 hover:border-slate-300",
                )}
                style={
                  s.id === lead.stage_id
                    ? { backgroundColor: s.color, borderColor: s.color }
                    : reached
                      ? { backgroundColor: `${s.color}20`, color: s.color }
                      : undefined
                }
              >
                {s.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Main column: composer + timeline */}
        <div className="min-w-0 space-y-4">
          <Composer leadId={lead.id} />
          <Timeline activities={activities} members={members} />
        </div>

        {/* Side column */}
        <div className="min-w-0 space-y-4">
          <AiPanel lead={lead} />
          <OutreachCard lead={lead} outreach={outreach} />
          <ResearchCard lead={lead} research={research} />
          <DetailsCard lead={lead} customFields={customFields} />
          <TasksCard leadId={lead.id} tasks={tasks} members={members} />
          <QuotesCard quotes={quotes} />
        </div>
      </div>

      <LeadFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        pipelineId={lead.pipeline_id}
        stages={stages}
        members={members}
        clients={[]}
        customFields={customFields}
        lead={lead}
      />
      <LostModal open={lostOpen} onClose={() => setLostOpen(false)} leadId={lead.id} />
      <ConfirmDialog
        open={confirmTrash}
        onClose={() => setConfirmTrash(false)}
        onConfirm={handleTrash}
        title="Move this lead to trash?"
        description="It disappears from the board but can be restored from CRM → Trash."
      />
    </div>
  );
}

// ---- Composer ---------------------------------------------------------------

function Composer({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [kind, setKind] = React.useState<"note" | "call" | "email" | "meeting">("note");
  const [text, setText] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function handleAdd() {
    setSaving(true);
    const res = await addLeadActivity({
      lead_id: leadId,
      kind,
      title:
        kind === "note"
          ? text.slice(0, 80)
          : `Logged ${kind}${text ? `: ${text.slice(0, 60)}` : ""}`,
      body: text,
    });
    setSaving(false);
    if (res.ok) {
      setText("");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex gap-1.5">
        {(["note", "call", "email", "meeting"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={cn(
              "rounded-lg px-3 py-2 text-xs font-semibold capitalize transition-colors sm:py-1.5",
              kind === k ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100",
            )}
          >
            {k}
          </button>
        ))}
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        className="mt-2"
        placeholder={
          kind === "note" ? "Write a note…" : `What happened on the ${kind}?`
        }
      />
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={handleAdd} loading={saving} disabled={!text.trim()}>
          Log {kind}
        </Button>
      </div>
    </div>
  );
}

// ---- Timeline -----------------------------------------------------------------

function Timeline({
  activities,
  members,
}: {
  activities: LeadActivity[];
  members: MemberLite[];
}) {
  const nameById = new Map(members.map((m) => [m.id, m.full_name || m.username]));
  const [showAll, setShowAll] = React.useState(false);
  // Field-change noise is collapsed by default.
  const visible = showAll
    ? activities
    : activities.filter((a) => a.kind !== "field_changed");

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Activity timeline</h3>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300 text-primary-600"
          />
          Show change history
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">Nothing logged yet.</p>
      ) : (
        <ol className="mt-4 space-y-0">
          {visible.map((activity, i) => (
            <li key={activity.id} className="relative flex gap-3 pb-4">
              {i < visible.length - 1 && (
                <span className="absolute left-[13px] top-7 h-full w-px bg-slate-100" />
              )}
              <span
                className={cn(
                  "z-10 mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-white",
                  ACTIVITY_TONE[activity.kind] ?? "bg-slate-300",
                )}
              >
                {ACTIVITY_ICON[activity.kind] ?? <Check className="h-3.5 w-3.5" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-slate-800">
                  {activity.title}
                </p>
                {activity.body && (
                  <p className="mt-0.5 whitespace-pre-line break-words text-sm text-slate-500">
                    {activity.body}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-slate-300">
                  {formatDistanceToNow(new Date(activity.created_at), { addSuffix: true })}
                  {activity.actor_id && nameById.get(activity.actor_id)
                    ? ` · ${nameById.get(activity.actor_id)}`
                    : activity.actor_id
                      ? ""
                      : " · automation"}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---- AI panel -------------------------------------------------------------------

function AiPanel({ lead }: { lead: LeadWithAssignee }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");

  async function run(mode: "summary" | "next_action" | "draft_reply") {
    setBusy(mode);
    const res = await aiLeadAssist(lead.id, mode);
    setBusy(null);
    if (res.ok) {
      if (mode === "draft_reply") setDraft(res.text);
      else router.refresh();
      toast.success("Done.");
    } else toast.error(res.error);
  }

  return (
    <div className="rounded-2xl border border-primary-200/70 bg-gradient-to-b from-primary-50/60 to-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-primary-600" />
        <h3 className="text-sm font-semibold text-slate-900">AI sales assistant</h3>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => run("summary")}
          loading={busy === "summary"}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Summarize
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => run("next_action")}
          loading={busy === "next_action"}
        >
          Next action
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => run("draft_reply")}
          loading={busy === "draft_reply"}
        >
          Draft reply
        </Button>
      </div>

      {lead.ai_summary && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Summary
          </p>
          <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{lead.ai_summary}</p>
        </div>
      )}
      {lead.ai_next_action && (
        <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-primary-100">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-primary-500">
            Suggested next action
          </p>
          <p className="mt-1 text-sm text-slate-700">{lead.ai_next_action}</p>
        </div>
      )}
      {draft && (
        <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-slate-100">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Drafted reply
          </p>
          <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{draft}</p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1.5"
            onClick={() => {
              navigator.clipboard.writeText(draft);
              toast.success("Copied — send it via SMS or WhatsApp.");
            }}
          >
            Copy
          </Button>
        </div>
      )}
    </div>
  );
}

// ---- Outreach card ----------------------------------------------------------

function OutreachCard({
  lead,
  outreach,
}: {
  lead: LeadWithAssignee;
  outreach: LeadOutreach | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [subject, setSubject] = React.useState(outreach?.subject ?? "");
  const [body, setBody] = React.useState(outreach?.body ?? "");

  // Keep the local draft in sync when realtime pushes a fresh row.
  React.useEffect(() => {
    setSubject(outreach?.subject ?? "");
    setBody(outreach?.body ?? "");
  }, [outreach?.subject, outreach?.body]);

  const status = outreach?.status;
  const preparing =
    status === "pending" || status === "drafting" || status === "sending";
  const idle = !outreach || status === "discarded";

  async function act(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    okMsg: string,
  ) {
    setBusy(true);
    try {
      const res = await fn();
      if (res.ok) {
        toast.success(okMsg);
        router.refresh();
      } else toast.error(res.error ?? "Something went wrong.");
    } catch {
      toast.error("Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    try {
      const res = await approveLeadOutreach(lead.id);
      if (res.ok) {
        toast.success(`Sent to ${res.sent} recipient${res.sent === 1 ? "" : "s"} 🎉`);
        router.refresh();
      } else toast.error(res.error ?? "Send failed.");
    } catch {
      toast.error("Send failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdits() {
    setBusy(true);
    try {
      const res = await saveOutreachDraft(lead.id, subject, body);
      if (res.ok) {
        setEditing(false);
        toast.success("Draft saved.");
        router.refresh();
      } else toast.error(res.error ?? "Couldn't save.");
    } catch {
      toast.error("Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2">
        <Send className="h-4 w-4 text-primary-600" />
        <h3 className="text-sm font-semibold text-slate-900">AI outreach</h3>
      </div>

      {/* No draft yet */}
      {idle && (
        <div className="mt-3">
          <p className="text-sm text-slate-500">
            Research this company, audit their website, and let AI write a
            personalised cold email. Nothing sends until you approve it.
          </p>
          <Button
            className="mt-3"
            size="sm"
            loading={busy}
            onClick={() =>
              act(
                () => prepareLeadOutreach(lead.id),
                "Drafting outreach — it'll appear here shortly.",
              )
            }
          >
            <Sparkles className="h-3.5 w-3.5" />
            Draft AI outreach
          </Button>
        </div>
      )}

      {/* Working */}
      {preparing && (
        <p className="mt-3 animate-pulse rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-500">
          {status === "sending"
            ? "Sending the email…"
            : "Researching the company + writing the email…"}
        </p>
      )}

      {/* Ready to approve */}
      {status === "ready" && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-slate-400">
            {outreach?.recipients?.length
              ? `To: ${outreach.recipients.join(", ")}`
              : "No email found yet — add a contact email in Details, then re-draft."}
          </p>

          {editing ? (
            <div className="space-y-2">
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
              />
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={9}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={saveEdits} loading={busy}>
                  <Check className="h-3.5 w-3.5" />
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSubject(outreach?.subject ?? "");
                    setBody(outreach?.body ?? "");
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <p className="text-sm font-semibold text-slate-800">
                {outreach?.subject || "(no subject)"}
              </p>
              <p className="mt-1.5 whitespace-pre-line text-sm text-slate-600">
                {outreach?.body}
              </p>
              <button
                onClick={() => setEditing(true)}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:underline"
              >
                <Pencil className="h-3 w-3" /> Edit before sending
              </button>
            </div>
          )}

          {!editing && (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={approve}
                  loading={busy}
                  disabled={!outreach?.recipients?.length}
                  className="bg-emerald-600 hover:bg-emerald-500"
                >
                  <Send className="h-3.5 w-3.5" />
                  Approve &amp; send
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-slate-500"
                  onClick={() =>
                    act(() => discardLeadOutreach(lead.id), "Draft discarded.")
                  }
                >
                  Discard
                </Button>
              </div>
              <p className="text-[11px] text-slate-400">
                Sends from support@arcai.agency with an unsubscribe footer.
              </p>
            </>
          )}
        </div>
      )}

      {/* Sent */}
      {status === "sent" && (
        <div className="mt-3 space-y-2">
          <p className="rounded-xl bg-sky-50 px-3 py-2.5 text-sm text-sky-700">
            ✉️ Sent to {outreach?.sent_to?.join(", ") || "the contact"}
            {outreach?.sent_at
              ? ` · ${formatDistanceToNow(new Date(outreach.sent_at), { addSuffix: true })}`
              : ""}
          </p>
          <p className="whitespace-pre-line rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{outreach?.subject}</span>
            {"\n"}
            {outreach?.body}
          </p>
          <Button
            variant="ghost"
            size="sm"
            loading={busy}
            onClick={() =>
              act(() => prepareLeadOutreach(lead.id), "Drafting a fresh email…")
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Draft again
          </Button>
        </div>
      )}

      {/* No deliverable email */}
      {status === "skipped" && (
        <div className="mt-3">
          <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
            No deliverable email was found for this lead. Add a contact email in
            Details, then re-draft.
          </p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            loading={busy}
            onClick={() =>
              act(() => prepareLeadOutreach(lead.id), "Re-drafting…")
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        </div>
      )}

      {/* Failed */}
      {status === "failed" && (
        <div className="mt-3">
          <p className="rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-600">
            {outreach?.error || "Outreach failed. Try again."}
          </p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            loading={busy}
            onClick={() =>
              outreach?.body
                ? approve()
                : act(() => prepareLeadOutreach(lead.id), "Re-drafting…")
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

// ---- Research card ----------------------------------------------------------

function ResearchCard({
  lead,
  research,
}: {
  lead: LeadWithAssignee;
  research: LeadResearch | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const status = research?.status;
  const running =
    busy || (!!status && status !== "done" && status !== "error");
  const hasCompany = Boolean(lead.company?.trim());
  // Keep the pipeline moving while this card shows an in-progress report — the
  // parent already subscribes to lead_research realtime for the status flip.
  useDriveResearch(!!status && status !== "done" && status !== "error");

  async function run() {
    setBusy(true);
    try {
      const res = await requestLeadResearch(lead.id);
      if (res.ok) {
        toast.success("Research started — the briefing will appear here shortly.");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    } catch {
      toast.error("Couldn't start research. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScanSearch className="h-4 w-4 text-primary-600" />
          <h3 className="text-sm font-semibold text-slate-900">
            Prospect research
          </h3>
        </div>
        {(status === "done" || status === "error") && (
          <Button variant="ghost" size="sm" onClick={run} loading={busy}>
            <RefreshCw className="h-3.5 w-3.5" />
            Re-run
          </Button>
        )}
      </div>

      {/* No report yet */}
      {!research && (
        <div className="mt-3">
          <p className="text-sm text-slate-500">
            Build an agency dossier — scrape the company&apos;s brand (colours,
            fonts, logo), map its site &amp; socials, size up competitors, and
            get pitch angles for how you&apos;d win the work.
          </p>
          <Button
            className="mt-3"
            size="sm"
            onClick={run}
            loading={busy}
            disabled={!hasCompany}
          >
            <ScanSearch className="h-3.5 w-3.5" />
            {hasCompany ? "Research this company" : "Add a company first"}
          </Button>
        </div>
      )}

      {/* Queued / in progress — live phase + elapsed timer */}
      {research && running && status !== "done" && (
        <ResearchProgress
          status={status ?? "pending"}
          startedAt={researchStartedAt(research)}
          className="mt-3"
        />
      )}

      {/* Failed */}
      {research && status === "error" && (
        <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-600">
          {research.error || "Research failed. Try again."}
        </p>
      )}

      {/* Done */}
      {research && status === "done" && (
        <div className="mt-3 space-y-3">
          <Link
            href={`/crm/research?lead=${lead.id}`}
            className="flex items-center justify-between gap-2 rounded-xl border border-primary-200 bg-primary-50/60 px-3 py-2 text-sm font-medium text-primary-700 transition hover:bg-primary-50"
          >
            <span className="inline-flex items-center gap-1.5">
              <ScanSearch className="h-4 w-4" />
              Open the full research view
            </span>
            <ArrowRight className="h-4 w-4" />
          </Link>
          <ResearchReportView research={research} compact />
        </div>
      )}
    </div>
  );
}

// ---- Details card ---------------------------------------------------------------

function DetailsCard({
  lead,
  customFields,
}: {
  lead: LeadWithAssignee;
  customFields: CrmField[];
}) {
  const custom = (lead.custom ?? {}) as Record<string, unknown>;
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <h3 className="text-sm font-semibold text-slate-900">Details</h3>
      <dl className="mt-3 space-y-2 text-sm">
        {lead.contact_name && <Row label="Contact">{lead.contact_name}</Row>}
        {lead.contact_phone && (
          <Row label="Phone">
            <a href={`tel:${lead.contact_phone}`} className="break-all text-primary-600 hover:underline">
              {lead.contact_phone}
            </a>
          </Row>
        )}
        {lead.contact_email && (
          <Row label="Email">
            <a href={`mailto:${lead.contact_email}`} className="break-all text-primary-600 hover:underline">
              {lead.contact_email}
            </a>
          </Row>
        )}
        {lead.expected_close_date && (
          <Row label="Close date">{lead.expected_close_date}</Row>
        )}
        {lead.probability != null && <Row label="Probability">{lead.probability}%</Row>}
        {lead.assignee && (
          <Row label="Owner">
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={lead.assignee.full_name} src={lead.assignee.avatar_url} size="xs" />
              {lead.assignee.full_name}
            </span>
          </Row>
        )}
        {(lead.tags ?? []).length > 0 && (
          <Row label="Tags">
            <span className="flex flex-wrap gap-1">
              {(lead.tags ?? []).map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"
                >
                  <Tag className="h-2.5 w-2.5" />
                  {t}
                </span>
              ))}
            </span>
          </Row>
        )}
        {customFields.map((field) => {
          const value = custom[field.key];
          if (value == null || value === "") return null;
          return (
            <Row key={field.id} label={field.label}>
              {field.kind === "checkbox" ? (value ? "Yes" : "No") : String(value)}
            </Row>
          );
        })}
        {lead.notes && (
          <Row label="Notes">
            <span className="whitespace-pre-line">{lead.notes}</span>
          </Row>
        )}
      </dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-slate-700">{children}</dd>
    </div>
  );
}

// ---- Tasks card -----------------------------------------------------------------

function TasksCard({
  leadId,
  tasks,
  members,
}: {
  leadId: string;
  tasks: CrmTask[];
  members: MemberLite[];
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");
  const [assignee, setAssignee] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const nameById = new Map(members.map((m) => [m.id, m.full_name || m.username]));
  // Snapshot once per mount so the overdue check stays pure during render.
  const [now] = React.useState(() => Date.now());

  const open = tasks.filter((t) => t.status === "open");
  const done = tasks.filter((t) => t.status === "done");

  async function handleAdd() {
    setSaving(true);
    const res = await saveCrmTask({
      lead_id: leadId,
      title,
      due_at: dueDate ? `${dueDate}T09:00:00` : null,
      assigned_to: assignee || null,
    });
    setSaving(false);
    if (res.ok) {
      setTitle("");
      setDueDate("");
      setAdding(false);
      router.refresh();
    } else toast.error(res.error);
  }

  async function handleToggle(task: CrmTask) {
    const res = await toggleCrmTask(task.id, task.status !== "done");
    if (res.ok) router.refresh();
    else toast.error(res.error);
  }

  async function handleDelete(task: CrmTask) {
    const res = await deleteCrmTask(task.id);
    if (res.ok) router.refresh();
    else toast.error(res.error);
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          Follow-ups{open.length > 0 && ` (${open.length})`}
        </h3>
        <Button variant="ghost" size="sm" onClick={() => setAdding((v) => !v)}>
          <CalendarPlus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {adding && (
        <div className="mt-2 space-y-2 rounded-xl bg-slate-50 p-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Call about the proposal"
            autoFocus
          />
          <div className="flex gap-2">
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="flex-1"
            />
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="flex-1">
              <option value="">Anyone</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name || m.username}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" onClick={handleAdd} loading={saving} disabled={!title.trim()}>
            Add task
          </Button>
        </div>
      )}

      <div className="mt-2 space-y-1.5">
        {open.map((task) => {
          const overdue = task.due_at && new Date(task.due_at).getTime() < now;
          return (
            <div
              key={task.id}
              className={cn(
                "group flex items-start gap-2 rounded-xl border px-3 py-2",
                overdue ? "border-rose-200 bg-rose-50/50" : "border-slate-100",
              )}
            >
              <input
                type="checkbox"
                checked={false}
                onChange={() => handleToggle(task)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-primary-600"
                aria-label="Mark done"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800">{task.title}</p>
                <p className="text-xs text-slate-400">
                  {task.due_at
                    ? `Due ${new Date(task.due_at).toLocaleDateString()}${overdue ? " — overdue" : ""}`
                    : "No due date"}
                  {task.assigned_to && ` · ${nameById.get(task.assigned_to) ?? ""}`}
                </p>
              </div>
              <button
                onClick={() => handleDelete(task)}
                className="hidden text-slate-300 hover:text-rose-500 group-hover:block"
                aria-label="Delete task"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        {open.length === 0 && !adding && (
          <p className="text-sm text-slate-400">No open follow-ups.</p>
        )}
        {done.length > 0 && (
          <p className="pt-1 text-xs text-slate-300">{done.length} completed</p>
        )}
      </div>
    </div>
  );
}

// ---- Quotes card ----------------------------------------------------------------

function QuotesCard({ quotes }: { quotes: Quote[] }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Quotes</h3>
        <Link href="/invoices?tab=quotes" className="text-xs font-semibold text-primary-600 hover:underline">
          New quote →
        </Link>
      </div>
      {quotes.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">No quotes for this lead yet.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {quotes.map((q) => (
            <Link
              key={q.id}
              href="/invoices?tab=quotes"
              className="flex items-center gap-2 rounded-xl border border-slate-100 px-3 py-2 text-sm hover:border-primary-200"
            >
              <FileSignature className="h-3.5 w-3.5 text-slate-400" />
              <span className="font-medium text-slate-800">{q.quote_number}</span>
              <Badge
                className={
                  q.status === "accepted"
                    ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                    : q.status === "declined"
                      ? "bg-rose-50 text-rose-600 ring-rose-200"
                      : "bg-slate-100 text-slate-500 ring-slate-200"
                }
              >
                {q.status}
              </Badge>
              <span className="ml-auto text-slate-600">
                {formatCurrency(Number(q.grand_total), q.currency)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Lost modal -----------------------------------------------------------------

function LostModal({
  open,
  onClose,
  leadId,
}: {
  open: boolean;
  onClose: () => void;
  leadId: string;
}) {
  const router = useRouter();
  const [reason, setReason] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function handleLost() {
    setSaving(true);
    const res = await setLeadStatus(leadId, "lost", reason);
    setSaving(false);
    if (res.ok) {
      onClose();
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mark as lost"
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleLost} loading={saving}>
            Mark lost
          </Button>
        </>
      }
    >
      <Field label="Reason" hint="Optional, but it feeds your win/loss learning.">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="e.g. budget, competitor, timing…"
        />
      </Field>
    </Modal>
  );
}
