"use client";

import * as React from "react";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  CalendarDays,
  Check,
  Copy,
  ExternalLink,
  FileText,
  Link as LinkIcon,
  Lock,
  Plus,
  RefreshCw,
  Send,
  Shuffle,
  Trash2,
  Unlock,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { PORTAL_LANGUAGES, portalMessage } from "@/lib/portal-copy";
import type { PortalLanguage, ProjectDocumentRequest } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  seedChecklistAction,
  startOnboardingManual,
} from "@/app/(app)/delivery/actions";
import {
  rollPortalPasscode,
  savePortalAccess,
  sendPortalToClient,
  setPortalRevoked,
} from "@/app/(app)/projects/portal-actions";
import {
  createDocumentRequest,
  deleteDocumentRequest,
  regenerateShareToken,
} from "./actions";

export type PortalAccess = {
  passcode: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastSentAt: string | null;
  language: PortalLanguage;
};

export function PortalSection({
  projectId,
  projectName,
  shareToken,
  requests = [],
  isProjectCompleted = false,
  serviceType = null,
  hasClient = false,
  onboardingStartedAt = null,
  access,
  clientName,
  clientPhone,
}: {
  projectId: string;
  projectName: string;
  shareToken: string;
  requests: ProjectDocumentRequest[];
  isProjectCompleted?: boolean;
  serviceType?: string | null;
  hasClient?: boolean;
  onboardingStartedAt?: string | null;
  /** 0094 — passcode, expiry, language and revoke state. */
  access: PortalAccess;
  clientName: string | null;
  clientPhone: string | null;
}) {
  const [copied, setCopied] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [desc, setDesc] = React.useState("");
  const [regenerating, setRegenerating] = React.useState(false);
  const [seeding, setSeeding] = React.useState(false);
  const [startingOnboarding, setStartingOnboarding] = React.useState(false);

  const portalUrl = React.useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/public/project/${shareToken}`;
  }, [shareToken]);

  async function handleSeed() {
    setSeeding(true);
    const res = await seedChecklistAction(projectId);
    setSeeding(false);
    if (res.ok) toast.success(`Checklist seeded — ${res.seeded} items added.`);
    else toast.error(res.error);
  }

  async function handleStartOnboarding() {
    setStartingOnboarding(true);
    const res = await startOnboardingManual(projectId);
    setStartingOnboarding(false);
    if (res.ok) toast.success(res.detail ?? "Onboarding started.");
    else toast.error(res.error);
  }

  function copyLink() {
    navigator.clipboard.writeText(portalUrl);
    setCopied(true);
    toast.success("Client portal link copied!");
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleAdd() {
    if (!title.trim()) {
      toast.error("Request title is required.");
      return;
    }
    setLoading(true);
    const res = await createDocumentRequest(projectId, title, desc);
    setLoading(false);
    if (res.ok) {
      toast.success("Document requested!");
      setTitle("");
      setDesc("");
    } else {
      toast.error(res.error);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this request from the timeline?"))
      return;
    const res = await deleteDocumentRequest(id, projectId);
    if (res.ok) toast.success("Request deleted");
    else toast.error(res.error);
  }

  async function handleRegenerate() {
    if (
      !confirm(
        "Warning: Regenerating the token will immediately invalidate the current sharing link. Continue?",
      )
    )
      return;
    setRegenerating(true);
    const res = await regenerateShareToken(projectId);
    setRegenerating(false);
    if (res.ok) toast.success("New portal link generated!");
    else toast.error(res.error);
  }

  return (
    <div className="space-y-6">
      {/* ---- Access + send (0094) ------------------------------------- */}
      <PortalAccessCard
        projectId={projectId}
        projectName={projectName}
        portalUrl={portalUrl}
        access={access}
        clientName={clientName}
        clientPhone={clientPhone}
        copied={copied}
        onCopy={copyLink}
        onRegenerate={handleRegenerate}
        regenerating={regenerating}
      />

      {/* ---- Document requests timeline ------------------------------- */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-800">
          <CalendarDays className="h-5 w-5 text-slate-400" />
          Resources Timeline Request
        </h3>

        {!isProjectCompleted && (
          <div className="mb-4 flex flex-wrap gap-2">
            {requests.length === 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleSeed}
                loading={seeding}
                className="text-xs"
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                Seed checklist{serviceType ? " from template" : ""}
              </Button>
            )}
            {hasClient && !onboardingStartedAt && (
              <Button
                size="sm"
                onClick={handleStartOnboarding}
                loading={startingOnboarding}
                className="text-xs"
              >
                Start WhatsApp onboarding
              </Button>
            )}
            {onboardingStartedAt && (
              <span className="inline-flex items-center rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-600 ring-1 ring-inset ring-emerald-200">
                <Check className="mr-1 h-3.5 w-3.5" />
                Agent collecting since{" "}
                {format(new Date(onboardingStartedAt), "d MMM yyyy")}
              </span>
            )}
          </div>
        )}

        {requests.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">
            No document requests created for this project yet. Use the form below
            to request assets from the client.
          </p>
        ) : (
          <div className="relative ml-3 space-y-6 border-l border-slate-200 pl-6">
            {requests.map((req) => (
              <div key={req.id} className="relative">
                <span
                  className={cn(
                    "absolute -left-[31px] top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 bg-white transition",
                    req.status === "submitted"
                      ? "border-emerald-500 bg-emerald-500"
                      : req.status === "na"
                        ? "border-slate-300 bg-slate-300"
                        : "border-slate-300",
                  )}
                >
                  {req.status === "submitted" && (
                    <Check className="h-2 w-2 text-white" strokeWidth={4} />
                  )}
                </span>

                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-800">
                      {req.title}
                    </h4>
                    {req.description && (
                      <p className="mt-0.5 text-xs text-slate-500">
                        {req.description}
                      </p>
                    )}

                    {req.status === "submitted" ? (
                      <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                        <FileText className="h-3.5 w-3.5 text-emerald-600" />
                        <a
                          href={req.file_url!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="max-w-[200px] truncate font-semibold underline hover:text-emerald-900"
                        >
                          {req.file_name}
                        </a>
                        <span className="text-[10px] text-emerald-500/80">
                          {req.submitted_at
                            ? ` · ${format(new Date(req.submitted_at), "d MMM yyyy")}`
                            : ""}
                        </span>
                      </div>
                    ) : req.status === "na" ? (
                      <span className="mt-2 inline-block rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500">
                        Not applicable
                      </span>
                    ) : (
                      <span className="mt-2 inline-block rounded-md border border-amber-100 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700">
                        Waiting for Client
                        {req.source === "team" && req.required === false
                          ? " · optional"
                          : ""}
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => handleDelete(req.id)}
                    className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-50 hover:text-rose-600"
                    title="Remove from timeline"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 space-y-4 border-t border-slate-100 pt-5">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
            Request a Document
          </h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Document Title" required>
              <Input
                placeholder="e.g. Logo Vector, Pitch Deck PDF"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isProjectCompleted}
              />
            </Field>
            <Field label="Description (Optional)">
              <Input
                placeholder="Please upload SVG format or PDF under 10MB"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                disabled={isProjectCompleted}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={loading || isProjectCompleted}
              loading={loading}
            >
              <Plus className="mr-1 h-4 w-4" />
              Add to Timeline
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Access + send to client (CX-6)                                      */
/* ------------------------------------------------------------------ */

/**
 * Set the passcode, then hand the whole thing to the client in one text.
 *
 * The message is shown exactly as it will arrive before it goes — a link and a
 * code together in one message, because a client who gets them in two texts
 * will lose one of them.
 */
function PortalAccessCard({
  projectId,
  projectName,
  portalUrl,
  access,
  clientName,
  clientPhone,
  copied,
  onCopy,
  onRegenerate,
  regenerating,
}: {
  projectId: string;
  projectName: string;
  portalUrl: string;
  access: PortalAccess;
  clientName: string | null;
  clientPhone: string | null;
  copied: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const [passcode, setPasscode] = React.useState(access.passcode ?? "");
  const [expiresAt, setExpiresAt] = React.useState(
    access.expiresAt ? access.expiresAt.slice(0, 10) : "",
  );
  const [language, setLanguage] = React.useState<PortalLanguage>(access.language);
  const [busy, setBusy] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  const revoked = Boolean(access.revokedAt);
  const canSend = Boolean(clientPhone) && !revoked && portalUrl;

  const preview = React.useMemo(
    () =>
      portalMessage({
        name: (clientName ?? "there").split(/\s+/)[0],
        projectName,
        link: portalUrl || "https://…",
        passcode: passcode.trim() || null,
      }),
    [clientName, projectName, portalUrl, passcode],
  );

  async function save(patch?: { passcode?: string }) {
    setBusy(true);
    const res = await savePortalAccess(projectId, {
      passcode: patch?.passcode ?? passcode,
      expiresAt: expiresAt || null,
      language,
    });
    setBusy(false);
    if (res.ok) toast.success("Portal access saved");
    else toast.error(res.error);
  }

  async function roll() {
    setBusy(true);
    const res = await rollPortalPasscode(projectId);
    setBusy(false);
    if (res.ok && res.passcode) {
      setPasscode(res.passcode);
      toast.success(`New passcode: ${res.passcode}`);
    } else if (!res.ok) {
      toast.error(res.error);
    }
  }

  async function send() {
    // Save first, so what goes out is what's on screen.
    await save();
    setSending(true);
    const res = await sendPortalToClient(projectId);
    setSending(false);
    if (res.ok) toast.success(`Sent to ${clientName ?? "the client"}`);
    else toast.error(res.error);
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LinkIcon className="h-5 w-5 text-primary-600" />
          <h3 className="text-sm font-semibold text-slate-800">Client portal</h3>
        </div>
        {revoked ? (
          <Badge className="bg-rose-50 text-rose-600 ring-rose-200">
            <Lock className="h-3 w-3" /> Revoked
          </Badge>
        ) : access.passcode ? (
          <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">
            <Lock className="h-3 w-3" /> Passcode on
          </Badge>
        ) : (
          <Badge className="bg-slate-100 text-slate-600 ring-slate-200">
            <Unlock className="h-3 w-3" /> Open link
          </Badge>
        )}
      </div>

      {/* The link */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <input
            type="text"
            readOnly
            value={portalUrl}
            className="w-full select-all rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 pr-10 text-xs text-slate-600 focus:outline-none"
          />
          <button
            onClick={onCopy}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 transition hover:text-slate-700"
            title="Copy Link"
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRegenerate}
            disabled={regenerating}
            className="text-xs"
          >
            <RefreshCw
              className={cn("mr-1 h-3.5 w-3.5", regenerating && "animate-spin")}
            />
            New link
          </Button>
          <a href={portalUrl} target="_blank" rel="noopener noreferrer">
            <Button size="sm" variant="outline" className="text-xs">
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              Open
            </Button>
          </a>
        </div>
      </div>

      {/* Passcode + expiry + language */}
      <div className="mt-4 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 sm:grid-cols-3">
        <Field label="Passcode" hint="4–8 digits. Blank = anyone with the link.">
          <div className="flex gap-1.5">
            <Input
              value={passcode}
              inputMode="numeric"
              placeholder="none"
              onChange={(e) =>
                setPasscode(e.target.value.replace(/\D/g, "").slice(0, 8))
              }
              onBlur={() => save()}
            />
            <button
              type="button"
              onClick={roll}
              title="Generate one"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:text-primary-600"
            >
              <Shuffle className="h-4 w-4" />
            </button>
          </div>
        </Field>

        <Field label="Expires" hint="Blank = never.">
          <Input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            onBlur={() => save()}
          />
        </Field>

        <Field label="Language" hint="What the client's page is written in.">
          <Select
            value={language}
            onChange={(e) => {
              const next = e.target.value as PortalLanguage;
              setLanguage(next);
              void savePortalAccess(projectId, { language: next });
            }}
          >
            {PORTAL_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* What the client will get */}
      <div className="mt-4">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
          What they&apos;ll receive
        </p>
        <pre className="mt-1.5 whitespace-pre-wrap rounded-xl border border-slate-200 bg-white px-3.5 py-3 font-sans text-xs leading-relaxed text-slate-600">
          {preview}
        </pre>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-400">
            {clientPhone
              ? `To ${clientName ?? "the client"} · ${clientPhone}`
              : clientName
                ? `${clientName} has no phone number on their record`
                : "No client attached to this project"}
            {access.lastSentAt &&
              ` · last sent ${format(new Date(access.lastSentAt), "d MMM")}`}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const res = await setPortalRevoked(projectId, !revoked);
                if (res.ok) toast.success(revoked ? "Link re-opened" : "Link revoked");
                else toast.error(res.error);
              }}
              className="text-xs"
            >
              {revoked ? (
                <>
                  <Unlock className="mr-1 h-3.5 w-3.5" /> Re-open
                </>
              ) : (
                <>
                  <Lock className="mr-1 h-3.5 w-3.5" /> Revoke
                </>
              )}
            </Button>
            <Button size="sm" onClick={send} loading={sending || busy} disabled={!canSend}>
              <Send className="mr-1 h-3.5 w-3.5" /> Send to client
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
