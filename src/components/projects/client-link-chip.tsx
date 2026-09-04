"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { format, isBefore, startOfToday } from "date-fns";
import {
  Check,
  Copy,
  ExternalLink,
  Link as LinkIcon,
  Lock,
  Send,
  Unlock,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sendPortalToClient } from "@/app/(app)/projects/portal-actions";

/**
 * The client's tracking link, one glance from the project's front page (0112).
 *
 * The full portal controls (passcode, expiry, language, revoke, the asset
 * checklist) stay on the Client tab; this is the copy/open/send strip that
 * makes the link never more than one click away.
 */
export function ClientLinkChip({
  projectId,
  shareToken,
  baseUrl,
  passcode,
  revokedAt,
  expiresAt,
  lastSentAt,
  clientName,
  clientPhone,
}: {
  projectId: string;
  shareToken: string;
  /** Absolute origin from the server; the browser fills it in if unset. */
  baseUrl?: string;
  passcode: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  lastSentAt: string | null;
  clientName: string | null;
  clientPhone: string | null;
}) {
  const [origin, setOrigin] = React.useState(baseUrl ?? "");
  React.useEffect(() => {
    if (!origin && typeof window !== "undefined") setOrigin(window.location.origin);
  }, [origin]);
  const url = origin ? `${origin}/public/project/${shareToken}` : "";

  const [copied, setCopied] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  const revoked = Boolean(revokedAt);
  // A calendar comparison, not Date.now(): react-hooks/purity forbids the
  // impure global during render, and a day's granularity is all this needs.
  const expired = Boolean(expiresAt && isBefore(new Date(expiresAt), startOfToday()));
  const canSend = Boolean(clientPhone) && !revoked && !expired && Boolean(url);

  function copy() {
    if (!url) return;
    navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("Client link copied");
    setTimeout(() => setCopied(false), 2000);
  }

  async function send() {
    setSending(true);
    const res = await sendPortalToClient(projectId);
    setSending(false);
    if (res.ok) {
      toast.success(
        `Sent to ${clientName ?? "the client"} on ${res.channel === "sms" ? "SMS" : "WhatsApp"}`,
      );
    } else toast.error(res.error);
  }

  return (
    <section className="@container rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <LinkIcon className="h-4 w-4 text-primary-600" />
          Client tracking link
        </h2>
        {revoked ? (
          <Badge className="bg-rose-50 text-rose-600 ring-rose-200">
            <Lock className="h-3 w-3" /> Revoked
          </Badge>
        ) : expired ? (
          <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
            <Lock className="h-3 w-3" /> Expired
          </Badge>
        ) : passcode ? (
          <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">
            <Lock className="h-3 w-3" /> Passcode {passcode}
          </Badge>
        ) : (
          <Badge className="bg-slate-100 text-slate-600 ring-slate-200">
            <Unlock className="h-3 w-3" /> Open link
          </Badge>
        )}
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        <input
          readOnly
          value={url}
          className="min-w-0 flex-1 select-all rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={copy}
          title="Copy link"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:text-primary-600"
        >
          {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
        </button>
        <a
          href={url || "#"}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the portal"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:text-primary-600"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          {lastSentAt
            ? `Last sent ${format(new Date(lastSentAt), "d MMM yyyy")}`
            : clientPhone
              ? "Not sent yet"
              : clientName
                ? `${clientName} has no phone number`
                : "No client attached"}
        </p>
        <div className="flex items-center gap-2">
          <Link
            href={`/projects/${projectId}?tab=client`}
            className="text-xs font-medium text-slate-500 hover:text-primary-600"
          >
            Manage →
          </Link>
          <Button size="sm" onClick={send} loading={sending} disabled={!canSend}>
            <Send className="mr-1 h-3.5 w-3.5" /> Send
          </Button>
        </div>
      </div>
    </section>
  );
}
