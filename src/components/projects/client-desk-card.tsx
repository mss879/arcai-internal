"use client";

/**
 * The client's side of the desk (0094).
 *
 * Everything the client has sent in, and the two things the team sends back:
 * something to approve, and — once it's all over — a request for a review.
 * One card, because they're all the same conversation.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  Check,
  Copy,
  MessageSquare,
  PenLine,
  Send,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn, formatCurrency } from "@/lib/utils";

import {
  acceptChangeRequest,
  declineChangeRequest,
  deleteApproval,
  postTeamComment,
  quoteChangeRequest,
  requestApproval,
} from "@/app/(app)/projects/cx-actions";
import { askForReview } from "@/app/(app)/projects/portal-actions";

export type DeskChangeRequest = {
  id: string;
  body: string;
  status: string;
  quoted_amount: number | null;
  quote_note: string | null;
  client_name: string | null;
  /** 0098 — spotted by the scope-creep reader rather than typed by a person. */
  ai_flagged?: boolean;
  ai_reason?: string | null;
  created_at: string;
};

export type DeskApproval = {
  id: string;
  title: string;
  detail: string | null;
  status: string;
  signer_name: string | null;
  signed_at: string | null;
  response_note: string | null;
  created_at: string;
};

export type DeskReview = {
  id: string;
  status: string;
  rating: number | null;
  headline: string | null;
  body: string | null;
  publishable: boolean;
  share_token: string;
  submitted_at: string | null;
  requested_at: string;
};

export type DeskComment = {
  id: string;
  author_type: string;
  author_name: string;
  body: string;
  created_at: string;
};

export function ClientDeskCard({
  projectId,
  currency,
  canText,
  changeRequests,
  approvals,
  reviews,
  comments,
  pulseAverage,
  pulseCount,
  isDelivered,
}: {
  projectId: string;
  currency: string;
  canText: boolean;
  changeRequests: DeskChangeRequest[];
  approvals: DeskApproval[];
  reviews: DeskReview[];
  comments: DeskComment[];
  /** 1–3, or null when they've never been asked. */
  pulseAverage: number | null;
  pulseCount: number;
  isDelivered: boolean;
}) {
  const router = useRouter();
  const [quoting, setQuoting] = React.useState<DeskChangeRequest | null>(null);
  const [askingApproval, setAskingApproval] = React.useState(false);
  const [reply, setReply] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const openChanges = changeRequests.filter((c) =>
    ["new", "quoted"].includes(c.status),
  );
  const submittedReview = reviews.find((r) => r.status === "submitted");
  const pendingReview = reviews.find((r) => r.status === "requested");

  async function ask() {
    setBusy(true);
    const res = await askForReview(projectId);
    setBusy(false);
    if (res.ok) {
      toast.success("Review request texted");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function sendReply() {
    if (!reply.trim()) return;
    setBusy(true);
    const res = await postTeamComment(projectId, reply);
    setBusy(false);
    if (res.ok) {
      setReply("");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-500">
            <MessageSquare className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">From the client</h2>
            <p className="text-xs text-slate-400">
              {openChanges.length > 0
                ? `${openChanges.length} request${openChanges.length === 1 ? "" : "s"} waiting on you`
                : "Requests, approvals and how they're feeling"}
            </p>
          </div>
        </div>
        {pulseAverage !== null && (
          <Badge
            className={cn(
              pulseAverage >= 2.5
                ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                : pulseAverage >= 1.6
                  ? "bg-amber-50 text-amber-600 ring-amber-200"
                  : "bg-rose-50 text-rose-600 ring-rose-200",
            )}
            title={`${pulseCount} response${pulseCount === 1 ? "" : "s"}`}
          >
            {pulseAverage >= 2.5
              ? "Happy"
              : pulseAverage >= 1.6
                ? "Lukewarm"
                : "Unhappy"}
          </Badge>
        )}
      </div>

      {/* ---- Change requests --------------------------------------- */}
      <div className="border-b border-slate-100 px-5 py-4">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          Change requests
        </h3>
        {changeRequests.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            Nothing asked for yet. When the client asks for something extra on
            the portal it lands here to be priced.
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {changeRequests.map((c) => (
              <li
                key={c.id}
                className="rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-3"
              >
                <p className="text-sm text-slate-800">{c.body}</p>
                {/* AI-3 — say plainly which of these a model raised, so the
                    team weighs it differently from one the client typed. */}
                {c.ai_flagged && c.ai_reason && (
                  <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-fuchsia-50 px-2 py-1 text-[11px] leading-relaxed text-fuchsia-700">
                    <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
                    {c.ai_reason}
                  </p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-400">
                    {format(new Date(c.created_at), "d MMM yyyy")}
                  </span>
                  {c.ai_flagged && (
                    <Badge className="bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200">
                      Spotted by AI
                    </Badge>
                  )}
                  {c.quoted_amount != null && (
                    <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                      {formatCurrency(Number(c.quoted_amount), currency)}
                    </Badge>
                  )}
                  {c.status === "accepted" && (
                    <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
                      Billed
                    </Badge>
                  )}
                  {c.status === "declined" && (
                    <Badge className="bg-slate-100 text-slate-500 ring-slate-200">
                      Declined
                    </Badge>
                  )}
                </div>

                {["new", "quoted"].includes(c.status) && (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setQuoting(c)}>
                      {c.quoted_amount == null ? "Price it" : "Re-price"}
                    </Button>
                    {c.quoted_amount != null && (
                      <Button
                        size="sm"
                        onClick={async () => {
                          const res = await acceptChangeRequest(c.id, projectId);
                          if (res.ok) {
                            toast.success("Billed as an extra, and a task added");
                            router.refresh();
                          } else toast.error(res.error);
                        }}
                      >
                        <Check className="h-3.5 w-3.5" /> Accept &amp; bill
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const res = await declineChangeRequest(c.id, projectId);
                        if (res.ok) router.refresh();
                        else toast.error(res.error);
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Approvals --------------------------------------------- */}
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Sign-offs
          </h3>
          <Button size="sm" variant="ghost" onClick={() => setAskingApproval(true)}>
            <PenLine className="h-3.5 w-3.5" /> Ask for one
          </Button>
        </div>

        {approvals.length === 0 ? (
          <p className="mt-1 text-xs text-slate-400">
            Nothing waiting. Ask for a sign-off and it appears at the top of
            their portal.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {approvals.map((a) => (
              <li
                key={a.id}
                className="group flex items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">{a.title}</p>
                  <p className="text-xs text-slate-400">
                    {a.status === "approved" ? (
                      <span className="text-emerald-600">
                        Signed by {a.signer_name}
                        {a.signed_at
                          ? ` · ${format(new Date(a.signed_at), "d MMM yyyy")}`
                          : ""}
                      </span>
                    ) : a.status === "changes_requested" ? (
                      <span className="text-amber-600">
                        Changes requested
                        {a.response_note ? ` — ${a.response_note}` : ""}
                      </span>
                    ) : (
                      "Waiting on the client"
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const res = await deleteApproval(a.id, projectId);
                    if (res.ok) router.refresh();
                    else toast.error(res.error);
                  }}
                  className="shrink-0 text-slate-300 opacity-0 transition hover:text-rose-600 group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Review ------------------------------------------------- */}
      <div className="border-b border-slate-100 px-5 py-4">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          Review
        </h3>

        {submittedReview ? (
          <div className="mt-2 rounded-xl border border-emerald-100 bg-emerald-50/60 px-3.5 py-3">
            <div className="flex items-center gap-1">
              {Array.from({ length: 5 }, (_, i) => (
                <Star
                  key={i}
                  className={cn(
                    "h-4 w-4",
                    i < (submittedReview.rating ?? 0)
                      ? "fill-amber-400 text-amber-400"
                      : "text-slate-300",
                  )}
                />
              ))}
              {submittedReview.publishable && (
                <Badge className="ml-2 bg-emerald-100 text-emerald-700 ring-emerald-300">
                  OK to publish
                </Badge>
              )}
            </div>
            {submittedReview.headline && (
              <p className="mt-2 text-sm font-semibold text-slate-900">
                {submittedReview.headline}
              </p>
            )}
            {submittedReview.body && (
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                {submittedReview.body}
              </p>
            )}
            {submittedReview.publishable && submittedReview.body && (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(
                    `${submittedReview.headline ? `${submittedReview.headline}\n` : ""}${submittedReview.body}`,
                  );
                  toast.success("Copied — ready to post");
                }}
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-900"
              >
                <Copy className="h-3.5 w-3.5" /> Copy for social
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2">
            <p className="text-xs text-slate-400">
              {pendingReview
                ? `Asked ${format(new Date(pendingReview.requested_at), "d MMM")} — no reply yet.`
                : isDelivered
                  ? "Delivered and they're still happy? Now is the moment."
                  : "Best asked once the project is delivered."}
            </p>
            <Button
              size="sm"
              className="mt-2"
              onClick={ask}
              loading={busy}
              disabled={!canText}
              title={canText ? undefined : "No phone number on the client record"}
            >
              <Star className="h-3.5 w-3.5" />
              {pendingReview ? "Ask again" : "Ask for a review"}
            </Button>
          </div>
        )}
      </div>

      {/* ---- Messages ----------------------------------------------- */}
      <div className="px-5 py-4">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          Portal messages
        </h3>
        {comments.length === 0 ? (
          <p className="mt-1 text-xs text-slate-400">
            Nothing yet. Anything the client writes on their portal shows here.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {comments.slice(-6).map((c) => (
              <li
                key={c.id}
                className={cn(
                  "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm",
                  c.author_type === "client"
                    ? "bg-slate-100 text-slate-800"
                    : "ml-auto bg-primary-50 text-primary-900",
                )}
              >
                <p className="whitespace-pre-wrap">{c.body}</p>
                <p className="mt-0.5 text-[11px] opacity-60">
                  {c.author_name} · {format(new Date(c.created_at), "d MMM, HH:mm")}
                </p>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex gap-2">
          <Input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendReply()}
            placeholder="Reply on the portal…"
          />
          <Button size="sm" onClick={sendReply} loading={busy} disabled={!reply.trim()}>
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <QuoteModal
        request={quoting}
        projectId={projectId}
        currency={currency}
        canText={canText}
        onClose={() => setQuoting(null)}
      />

      <ApprovalModal
        open={askingApproval}
        projectId={projectId}
        canText={canText}
        onClose={() => setAskingApproval(false)}
      />
    </section>
  );
}

function QuoteModal({
  request,
  projectId,
  currency,
  canText,
  onClose,
}: {
  request: DeskChangeRequest | null;
  projectId: string;
  currency: string;
  canText: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  const [tell, setTell] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!request) return;
    setAmount(request.quoted_amount != null ? String(request.quoted_amount) : "");
    setNote(request.quote_note ?? "");
    setTell(canText);
  }, [request, canText]);

  async function save() {
    if (!request) return;
    setBusy(true);
    const res = await quoteChangeRequest(
      request.id,
      projectId,
      Number(amount),
      note || null,
      { tellClient: tell && canText },
    );
    setBusy(false);
    if (res.ok) {
      if (res.smsError) toast.warning(`Priced, but the text didn't go: ${res.smsError}`);
      else toast.success("Priced");
      onClose();
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Modal
      open={!!request}
      onClose={onClose}
      title="Price this change"
      description={request?.body}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!amount.trim()}>
            Save price
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={`What it costs (${currency})`} required>
          <Input
            autoFocus
            type="number"
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Anything to add">
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Adds about 3 days to the timeline."
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={tell}
            disabled={!canText}
            onChange={(e) => setTell(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-primary-600"
          />
          Text the client the price
          {!canText && (
            <span className="text-xs text-slate-400">(no phone number)</span>
          )}
        </label>
      </div>
    </Modal>
  );
}

function ApprovalModal({
  open,
  projectId,
  canText,
  onClose,
}: {
  open: boolean;
  projectId: string;
  canText: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [detail, setDetail] = React.useState("");
  const [tell, setTell] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    const res = await requestApproval(projectId, title, detail, {
      tellClient: tell && canText,
    });
    setBusy(false);
    if (res.ok) {
      if (res.smsError) toast.warning(`Asked, but the text didn't go: ${res.smsError}`);
      else toast.success("Waiting on the client");
      setTitle("");
      setDetail("");
      onClose();
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ask the client to sign off"
      description="It appears at the top of their portal, and they sign it with their name."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!title.trim()}>
            <Sparkles className="h-4 w-4" /> Ask
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="What are they approving?" required>
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Homepage design"
          />
        </Field>
        <Field label="Anything they should know">
          <Textarea
            rows={3}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="Have a look at the staging link — once you approve we'll build out the rest."
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={tell}
            disabled={!canText}
            onChange={(e) => setTell(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-primary-600"
          />
          Text them the link too
        </label>
      </div>
    </Modal>
  );
}
