"use client";

import * as React from "react";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  Check,
  CalendarDays,
  Clock,
  FileText,
  Flag,
  FolderCheck,
  FolderOpen,
  Frown,
  Loader2,
  MessageSquare,
  Meh,
  PenLine,
  Smile,
  Sparkles,
  Upload,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DELIVERY_STAGES, SERVICE_TYPE_LABELS } from "@/lib/constants";
import { portalCopy, type PortalCopy } from "@/lib/portal-copy";
import type {
  DeliveryStage,
  PortalLanguage,
  ProjectDocumentRequest,
} from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";

import {
  postClientComment,
  respondToApproval,
  sendPulse,
  submitChangeRequest,
  uploadPortalFile,
} from "./actions";

/**
 * Everything the portal shows, and nothing else.
 *
 * The page builds this on the server from a hand-picked column list. Whatever
 * is in this type is public to anyone holding the link (and the passcode), so
 * nothing internal — budget, cost expenses, commissions, the share token —
 * may be added to it.
 */
export type PortalProject = {
  name: string;
  description: string | null;
  status: string;
  serviceType: string | null;
  stage: DeliveryStage | null;
  stageIndex: number;
  currency: string;
  totalValue: number;
  received: number;
  balance: number;
  paidPercent: number;
  startDate: string | null;
  dueDate: string | null;
  clientName: string | null;
  clientCompany: string | null;
  documents: { label: string; url: string }[];
  payments: {
    id: string;
    amount: number;
    date: string | null;
    label: "deposit" | "payment";
  }[];
  milestones: {
    id: string;
    title: string;
    detail: string | null;
    done: boolean;
    dueDate: string | null;
  }[];
  approvals: {
    id: string;
    title: string;
    detail: string | null;
    status: string;
    signerName: string | null;
    signedAt: string | null;
  }[];
  changeRequests: {
    id: string;
    body: string;
    status: string;
    quotedAmount: number | null;
    quoteNote: string | null;
    createdAt: string;
  }[];
  comments: {
    id: string;
    milestoneId: string | null;
    fromClient: boolean;
    authorName: string;
    body: string;
    createdAt: string;
  }[];
  askForPulse: boolean;
};

export function PortalClient({
  token,
  project,
  language,
  initialRequests,
}: {
  token: string;
  project: PortalProject;
  /**
   * The language code, not the dictionary — the copy object holds functions
   * (plurals, percentages), and functions cannot be serialised from a Server
   * Component to a Client one.
   */
  language: PortalLanguage;
  initialRequests: ProjectDocumentRequest[];
}) {
  const copy = portalCopy(language);
  const [requests, setRequests] = React.useState(initialRequests);
  const [uploadingId, setUploadingId] = React.useState<string | null>(null);
  const fileInputs = React.useRef<{ [key: string]: HTMLInputElement | null }>({});

  const isCompleted = project.status === "completed";
  const outstanding = requests.filter((r) => r.status !== "submitted").length;
  const pendingApproval = project.approvals.find((a) => a.status === "pending");

  async function handleFileChange(
    requestId: string,
    e: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingId(requestId);
    const formData = new FormData();
    formData.append("file", file);

    const res = await uploadPortalFile(token, requestId, formData);
    setUploadingId(null);

    if (res.ok) {
      toast.success(`"${file.name}" uploaded — thank you!`);
      setRequests((prev) =>
        prev.map((r) =>
          r.id === requestId
            ? {
                ...r,
                status: "submitted",
                file_name: file.name,
                file_url: URL.createObjectURL(file),
                submitted_at: new Date().toISOString(),
              }
            : r,
        ),
      );
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="min-h-screen app-bg px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[900px] space-y-6 animate-float-in">
        {/* ---- Header ---- */}
        <div className="rounded-3xl border border-white/30 bg-white/70 p-6 shadow-lg backdrop-blur-xl saturate-150">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <FolderCheck className="h-6 w-6 text-primary-500" />
                <h1 className="text-xl font-bold tracking-tight text-slate-800 sm:text-2xl">
                  {project.name}
                </h1>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {copy.workspace}
                {project.clientName ? ` · ${project.clientName}` : ""}
              </p>
            </div>
            {project.serviceType && (
              <Badge className="bg-primary-50 font-semibold text-primary-700 ring-primary-200">
                {SERVICE_TYPE_LABELS[project.serviceType] || project.serviceType}
              </Badge>
            )}
          </div>

          {project.description && (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                {copy.whatWereBuilding}
              </h2>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">
                {project.description}
              </p>
            </div>
          )}

          {project.dueDate && (
            <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-slate-400">
              <CalendarDays className="h-3.5 w-3.5" />
              {copy.targetCompletion} {format(new Date(project.dueDate), "d MMMM yyyy")}
            </p>
          )}
        </div>

        {/* ---- Waiting on you ---- */}
        {pendingApproval && (
          <ApprovalCard
            token={token}
            copy={copy}
            approval={pendingApproval}
          />
        )}

        {/* ---- Where your project is ---- */}
        <ProgressStepper project={project} copy={copy} />

        {/* ---- Milestones ---- */}
        {project.milestones.length > 0 && (
          <MilestoneList project={project} copy={copy} />
        )}

        {outstanding > 0 && !isCompleted && (
          <div className="rounded-2xl border border-amber-200/70 bg-amber-50/70 px-5 py-4 text-sm text-amber-900 shadow-sm backdrop-blur">
            <p className="font-semibold">
              {outstanding === 1
                ? copy.waitingOnYouOne
                : copy.waitingOnYouMany(outstanding)}
            </p>
            <p className="mt-0.5 text-amber-800/80">{copy.uploadBelow}</p>
          </div>
        )}

        {/* ---- Money ---- */}
        <div className="rounded-3xl border border-white/30 bg-white/70 p-6 shadow-lg backdrop-blur-xl saturate-150">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
            <Wallet className="h-4 w-4 text-primary-500" />
            {copy.yourAccount}
          </h3>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <Figure
              label={copy.totalValue}
              value={formatCurrency(project.totalValue, project.currency)}
            />
            <Figure
              label={copy.paidSoFar}
              value={formatCurrency(project.received, project.currency)}
              tone="emerald"
            />
            <Figure
              label={copy.balanceDue}
              value={formatCurrency(project.balance, project.currency)}
              tone={project.balance > 0 ? "amber" : "emerald"}
            />
          </div>

          {project.totalValue > 0 && (
            <div className="mt-5">
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    project.paidPercent >= 100 ? "bg-emerald-500" : "bg-primary-500",
                  )}
                  style={{ width: `${project.paidPercent}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-slate-400">
                {copy.settledPercent(project.paidPercent)}
              </p>
            </div>
          )}

          {project.payments.length > 0 && (
            <div className="mt-5 border-t border-slate-100 pt-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                {copy.paymentsReceived}
              </h4>
              <ul className="mt-2 divide-y divide-slate-100">
                {project.payments.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="text-slate-600">
                      {p.label === "deposit" ? copy.deposit : copy.paymentReceived}
                      {p.date && (
                        <span className="ml-2 text-xs text-slate-400">
                          {format(new Date(p.date), "d MMM yyyy")}
                        </span>
                      )}
                    </span>
                    <span className="font-semibold tabular-nums text-slate-800">
                      {formatCurrency(p.amount, project.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {project.documents.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
              {project.documents.map((doc) => (
                <a
                  key={doc.url}
                  href={doc.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200 transition hover:text-primary-700 hover:ring-primary-200"
                >
                  <FileText className="h-3.5 w-3.5" />
                  {doc.label}
                </a>
              ))}
            </div>
          )}
        </div>

        {/* ---- Asset timeline ---- */}
        <div className="rounded-3xl border border-white/30 bg-white/70 p-6 shadow-lg backdrop-blur-xl saturate-150">
          <h3 className="mb-6 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
            <CalendarDays className="h-4 w-4 text-slate-400" />
            {copy.whatWeNeed}
          </h3>

          {requests.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <FolderOpen className="mb-2 h-10 w-10 text-slate-300" />
              <p className="text-sm font-medium text-slate-400">
                {copy.nothingToSend}
              </p>
              <p className="text-xs text-slate-300">{copy.weWillAddHere}</p>
            </div>
          ) : (
            <div className="relative ml-4 space-y-8 border-l border-slate-200 pl-8">
              {requests.map((req) => (
                <div key={req.id} className="relative">
                  <span
                    className={cn(
                      "absolute -left-[41px] top-1 flex h-6 w-6 items-center justify-center rounded-full border-2 bg-white shadow-sm transition-all duration-300",
                      req.status === "submitted"
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : "border-slate-300 text-slate-400",
                    )}
                  >
                    {req.status === "submitted" ? (
                      <Check className="h-3 w-3" strokeWidth={3} />
                    ) : (
                      <Clock className="h-3.5 w-3.5" />
                    )}
                  </span>

                  <div className="rounded-2xl border border-slate-100 bg-white/50 p-5 shadow-sm transition-all duration-300 hover:shadow-md">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">
                          {req.title}
                          {req.required === false && (
                            <span className="ml-2 text-[10px] font-semibold uppercase text-slate-400">
                              {copy.optional}
                            </span>
                          )}
                        </h4>
                        {req.description && (
                          <p className="mt-1 text-xs text-slate-500">{req.description}</p>
                        )}

                        {req.status === "submitted" && (
                          <div className="mt-3 inline-flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-800">
                            <FileText className="h-3.5 w-3.5 text-emerald-600" />
                            <span className="max-w-[200px] truncate font-semibold">
                              {req.file_name}
                            </span>
                            <span className="text-[10px] text-emerald-500/80">
                              {req.submitted_at
                                ? ` · ${copy.uploadedOn} ${format(new Date(req.submitted_at), "d MMM yyyy")}`
                                : ""}
                            </span>
                          </div>
                        )}
                      </div>

                      <div>
                        {req.status !== "submitted" && (
                          <>
                            <input
                              type="file"
                              ref={(el) => {
                                fileInputs.current[req.id] = el;
                              }}
                              onChange={(e) => handleFileChange(req.id, e)}
                              className="hidden"
                              accept="image/*,application/pdf"
                              disabled={isCompleted || uploadingId === req.id}
                            />
                            <Button
                              size="sm"
                              onClick={() => fileInputs.current[req.id]?.click()}
                              disabled={isCompleted || uploadingId === req.id}
                              className="shrink-0 text-xs"
                            >
                              {uploadingId === req.id ? (
                                <>
                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  {copy.uploading}
                                </>
                              ) : (
                                <>
                                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                                  {copy.upload}
                                </>
                              )}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---- Ask for something ---- */}
        {!isCompleted && (
          <ChangeRequestCard token={token} copy={copy} project={project} />
        )}

        {/* ---- Talk to us ---- */}
        <CommentsCard token={token} project={project} />

        {/* ---- How's it going ---- */}
        {project.askForPulse && <PulseCard token={token} copy={copy} />}

        <p className="pb-4 text-center text-xs text-slate-400">
          {copy.privateNote}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Approvals (CX-2)                                                    */
/* ------------------------------------------------------------------ */

function ApprovalCard({
  token,
  copy,
  approval,
}: {
  token: string;
  copy: PortalCopy;
  approval: PortalProject["approvals"][number];
}) {
  const [name, setName] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<"approved" | "changes" | null>(null);

  async function respond(decision: "approved" | "changes_requested") {
    setBusy(true);
    const res = await respondToApproval(token, approval.id, decision, name, note);
    setBusy(false);
    if (res.ok) {
      setDone(decision === "approved" ? "approved" : "changes");
      toast.success(copy.pulseThanks);
    } else {
      toast.error(res.error);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50/70 px-5 py-4 text-sm text-emerald-900">
        <p className="font-semibold">{copy.pulseThanks}</p>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-primary-200/70 bg-primary-50/60 p-6 shadow-lg backdrop-blur-xl">
      <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-primary-700">
        <PenLine className="h-4 w-4" />
        {copy.approveTitle}
      </h3>
      <p className="mt-2 text-base font-semibold text-slate-900">{approval.title}</p>
      {approval.detail && (
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">
          {approval.detail}
        </p>
      )}
      <p className="mt-3 text-xs text-slate-500">{copy.approveBlurb}</p>

      <div className="mt-4 space-y-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={copy.approveName}
          className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
        />
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="…"
          className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => respond("approved")} loading={busy} disabled={!name.trim()}>
            <Check className="h-4 w-4" /> {copy.approveButton}
          </Button>
          <Button
            variant="outline"
            onClick={() => respond("changes_requested")}
            disabled={busy}
          >
            {copy.approveChanges}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Milestones (CX-1)                                                   */
/* ------------------------------------------------------------------ */

function MilestoneList({
  project,
  copy,
}: {
  project: PortalProject;
  copy: PortalCopy;
}) {
  return (
    <div className="rounded-3xl border border-white/30 bg-white/70 p-6 shadow-lg backdrop-blur-xl saturate-150">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
        <Flag className="h-4 w-4 text-primary-500" />
        {copy.whereYouAre}
      </h3>
      <ul className="space-y-2.5">
        {project.milestones.map((m) => (
          <li key={m.id} className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full",
                m.done ? "bg-emerald-500 text-white" : "bg-slate-100 text-slate-400",
              )}
            >
              {m.done ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  "text-sm font-medium",
                  m.done ? "text-slate-400 line-through" : "text-slate-800",
                )}
              >
                {m.title}
              </p>
              {m.detail && <p className="text-xs text-slate-500">{m.detail}</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Change requests (CX-3)                                              */
/* ------------------------------------------------------------------ */

function ChangeRequestCard({
  token,
  copy,
  project,
}: {
  token: string;
  copy: PortalCopy;
  project: PortalProject;
}) {
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function send() {
    setBusy(true);
    const res = await submitChangeRequest(token, body);
    setBusy(false);
    if (res.ok) {
      setBody("");
      setSent(true);
      toast.success(copy.askSent);
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="rounded-3xl border border-white/30 bg-white/70 p-6 shadow-lg backdrop-blur-xl saturate-150">
      <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
        <Sparkles className="h-4 w-4 text-primary-500" />
        {copy.askTitle}
      </h3>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{copy.askBlurb}</p>

      {sent ? (
        <p className="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {copy.askSent}
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={copy.askPlaceholder}
            className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
          />
          <div className="flex justify-end">
            <Button onClick={send} loading={busy} disabled={!body.trim()}>
              {copy.askSend}
            </Button>
          </div>
        </div>
      )}

      {project.changeRequests.length > 0 && (
        <ul className="mt-5 space-y-3 border-t border-slate-100 pt-4">
          {project.changeRequests.map((c) => (
            <li key={c.id} className="text-sm">
              <p className="text-slate-700">{c.body}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-400">
                  {format(new Date(c.createdAt), "d MMM yyyy")}
                </span>
                {c.status === "quoted" && c.quotedAmount != null && (
                  <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                    {formatCurrency(c.quotedAmount, project.currency)}
                  </Badge>
                )}
                {c.status === "accepted" && (
                  <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
                    Going ahead
                  </Badge>
                )}
                {c.status === "new" && (
                  <Badge className="bg-slate-100 text-slate-600 ring-slate-200">
                    With the team
                  </Badge>
                )}
              </div>
              {c.quoteNote && (
                <p className="mt-1 text-xs text-slate-500">{c.quoteNote}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Comments (CX-4)                                                     */
/* ------------------------------------------------------------------ */

function CommentsCard({
  token,
  project,
}: {
  token: string;
  project: PortalProject;
}) {
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [posted, setPosted] = React.useState<PortalProject["comments"]>([]);

  const all = [...project.comments, ...posted];

  async function send() {
    setBusy(true);
    const res = await postClientComment(token, body);
    setBusy(false);
    if (res.ok) {
      setPosted((p) => [
        ...p,
        {
          id: `local-${p.length}`,
          milestoneId: null,
          fromClient: true,
          authorName: project.clientName ?? "You",
          body,
          createdAt: new Date().toISOString(),
        },
      ]);
      setBody("");
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="rounded-3xl border border-white/30 bg-white/70 p-6 shadow-lg backdrop-blur-xl saturate-150">
      <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
        <MessageSquare className="h-4 w-4 text-primary-500" />
        Messages
      </h3>

      {all.length > 0 && (
        <ul className="mt-4 space-y-3">
          {all.map((c) => (
            <li
              key={c.id}
              className={cn(
                "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
                c.fromClient
                  ? "ml-auto bg-primary-50 text-primary-900"
                  : "bg-slate-50 text-slate-700",
              )}
            >
              <p className="whitespace-pre-wrap">{c.body}</p>
              <p className="mt-1 text-[11px] opacity-60">
                {c.fromClient ? "" : `${c.authorName} · `}
                {format(new Date(c.createdAt), "d MMM, HH:mm")}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex gap-2">
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && body.trim()) send();
          }}
          placeholder="…"
          className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
        />
        <Button onClick={send} loading={busy} disabled={!body.trim()}>
          <MessageSquare className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pulse (CX-9)                                                        */
/* ------------------------------------------------------------------ */

function PulseCard({ token, copy }: { token: string; copy: PortalCopy }) {
  const [done, setDone] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function tap(score: 1 | 2 | 3) {
    setBusy(true);
    const res = await sendPulse(token, score);
    setBusy(false);
    if (res.ok) setDone(true);
    else toast.error(res.error);
  }

  if (done) {
    return (
      <p className="rounded-2xl bg-emerald-50 px-5 py-4 text-center text-sm font-medium text-emerald-800">
        {copy.pulseThanks}
      </p>
    );
  }

  return (
    <div className="rounded-3xl border border-white/30 bg-white/70 p-6 text-center shadow-lg backdrop-blur-xl saturate-150">
      <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">
        {copy.pulseTitle}
      </h3>
      <div className="mt-4 flex justify-center gap-3">
        <PulseButton
          onClick={() => tap(1)}
          disabled={busy}
          icon={<Frown className="h-7 w-7" />}
          label={copy.pulseBad}
          tone="rose"
        />
        <PulseButton
          onClick={() => tap(2)}
          disabled={busy}
          icon={<Meh className="h-7 w-7" />}
          label={copy.pulseOk}
          tone="amber"
        />
        <PulseButton
          onClick={() => tap(3)}
          disabled={busy}
          icon={<Smile className="h-7 w-7" />}
          label={copy.pulseGreat}
          tone="emerald"
        />
      </div>
    </div>
  );
}

function PulseButton({
  onClick,
  disabled,
  icon,
  label,
  tone,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  tone: "rose" | "amber" | "emerald";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-24 flex-col items-center gap-1.5 rounded-2xl border px-3 py-3 transition disabled:opacity-50",
        tone === "rose"
          ? "border-rose-100 text-rose-500 hover:bg-rose-50"
          : tone === "amber"
            ? "border-amber-100 text-amber-500 hover:bg-amber-50"
            : "border-emerald-100 text-emerald-500 hover:bg-emerald-50",
      )}
    >
      {icon}
      <span className="text-xs font-medium text-slate-600">{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The six delivery stages, in the client's language.
 *
 * DELIVERY_STAGE_META has carried a `clientLabel` for every stage since 0084
 * and nothing had ever rendered it; 0094 translated them too, so the wording
 * now comes from the portal's own dictionary.
 */
function ProgressStepper({
  project,
  copy,
}: {
  project: PortalProject;
  copy: PortalCopy;
}) {
  if (project.stageIndex < 0) return null;

  return (
    <div className="rounded-3xl border border-white/30 bg-white/70 p-6 shadow-lg backdrop-blur-xl saturate-150">
      <h3 className="mb-5 text-sm font-bold uppercase tracking-wider text-slate-400">
        {copy.whereYouAre}
      </h3>

      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {DELIVERY_STAGES.map((stage, i) => {
          const done = i < project.stageIndex;
          const current = i === project.stageIndex;
          return (
            <li
              key={stage}
              className={cn(
                "flex items-center gap-3 rounded-2xl border px-3 py-2.5 transition",
                current
                  ? "border-primary-200 bg-primary-50/80 shadow-sm"
                  : done
                    ? "border-emerald-100 bg-emerald-50/60"
                    : "border-slate-100 bg-white/40",
              )}
            >
              <span
                className={cn(
                  "grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold",
                  current
                    ? "bg-primary-500 text-white"
                    : done
                      ? "bg-emerald-500 text-white"
                      : "bg-slate-100 text-slate-400",
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span
                className={cn(
                  "text-sm font-medium",
                  current
                    ? "text-primary-800"
                    : done
                      ? "text-emerald-800"
                      : "text-slate-400",
                )}
              >
                {copy.stages[stage]}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "amber";
}) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white/50 p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 text-2xl font-black tabular-nums",
          tone === "emerald"
            ? "text-emerald-600"
            : tone === "amber"
              ? "text-amber-600"
              : "text-slate-800",
        )}
      >
        {value}
      </p>
    </div>
  );
}
