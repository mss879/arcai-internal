"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  Mail,
  Pause,
  Play,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import { cn } from "@/lib/utils";
import type { CampaignStats } from "@/lib/outreach-campaign";
import type { OutreachCampaign } from "@/lib/types";

import {
  cancelCampaign,
  pauseCampaign,
  previewCampaign,
  resumeCampaign,
  startCampaign,
  type EligibilityPreview,
} from "./actions";
import { useDriveOutreach } from "./use-drive-outreach";

export type CampaignWithStats = {
  campaign: OutreachCampaign;
  stats: CampaignStats;
};

export function OutreachView({
  campaigns,
  sentToday,
  configured,
}: {
  campaigns: CampaignWithStats[];
  sentToday: number;
  configured: boolean;
}) {
  const [launching, setLaunching] = React.useState(false);
  useRealtimeSyncTables(["outreach_campaigns", "lead_outreach"]);

  const active = campaigns.some(
    (c) => c.campaign.status === "running" || c.campaign.status === "paused",
  );
  useDriveOutreach(active);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Email campaigns"
        description="Research every cold lead, write each one a personalized pitch, and send — with or without your approval."
        actions={
          <Button onClick={() => setLaunching(true)} disabled={!configured}>
            <Sparkles className="h-4 w-4" /> New campaign
          </Button>
        }
      />

      {!configured && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">
            <p className="font-semibold">Outreach isn&apos;t configured</p>
            <p className="mt-0.5 text-amber-800">
              Campaigns need <code className="font-mono text-xs">RESEND_API_KEY</code>{" "}
              for sending plus the research keys (
              <code className="font-mono text-xs">OPENAI_API_KEY</code>,{" "}
              <code className="font-mono text-xs">FIRECRAWL_API_KEY</code>) to
              personalize. Add them and reload.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Mail className="h-3.5 w-3.5" />
        <span>
          <span className="font-semibold text-slate-700">{sentToday}</span> outreach
          email{sentToday === 1 ? "" : "s"} sent today across all campaigns.
        </span>
      </div>

      {campaigns.length === 0 ? (
        <EmptyState
          icon={<Send className="h-6 w-6" />}
          title="No campaigns yet"
          description="A campaign researches every cold lead in your CRM, writes each a tailored email, and either queues it for your approval or sends it automatically."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {campaigns.map((c) => (
            <CampaignCard key={c.campaign.id} {...c} />
          ))}
        </div>
      )}

      <LaunchModal open={launching} onClose={() => setLaunching(false)} />
    </div>
  );
}

// ---- Launch ---------------------------------------------------------------

function LaunchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  const [autoSend, setAutoSend] = React.useState(false);
  const [dailyCap, setDailyCap] = React.useState(40);
  const [includeFindable, setIncludeFindable] = React.useState(false);
  const [preview, setPreview] = React.useState<EligibilityPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(`Cold outreach — ${new Date().toLocaleDateString()}`);
      setAutoSend(false);
      setDailyCap(40);
      setIncludeFindable(false);
      setPreview(null);
    }
  }, [open]);

  // Re-count whenever the targeting changes, so the number on the button is
  // always the number that will actually be emailed.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingPreview(true);
    void (async () => {
      const res = await previewCampaign({ includeFindable });
      if (cancelled) return;
      setPreview(res.ok ? res.preview : null);
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, includeFindable]);

  function launch() {
    startTransition(async () => {
      const res = await startCampaign({
        name,
        autoSend,
        dailyCap,
        filters: { includeFindable },
      });
      setConfirming(false);
      if (res.ok) {
        toast.success(
          autoSend
            ? `Campaign started — ${res.queued} leads queued, sending up to ${dailyCap}/day.`
            : `Campaign started — ${res.queued} drafts being written for your approval.`,
        );
        router.refresh();
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  const count = preview?.count ?? 0;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="New email campaign"
        description="Every lead gets researched, then written a pitch built from what we find."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => setConfirming(true)}
              disabled={pending || loadingPreview || count === 0}
              loading={pending}
            >
              {autoSend ? (
                <>
                  <Send className="h-4 w-4" /> Start &amp; send to {count}
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> Draft {count} email
                  {count === 1 ? "" : "s"}
                </>
              )}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <Field label="Campaign name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field
            label="Approval"
            hint="You can pause or cancel a running campaign at any time."
          >
            <div className="flex flex-col gap-2">
              <ModeOption
                active={!autoSend}
                onClick={() => setAutoSend(false)}
                icon={<ShieldCheck className="h-4 w-4" />}
                title="Draft for my approval"
                body="Each email waits on its lead until you click Approve & send. Nothing goes out on its own."
              />
              <ModeOption
                active={autoSend}
                onClick={() => setAutoSend(true)}
                icon={<Send className="h-4 w-4" />}
                title="Send automatically"
                body="Emails go out as they're written, without review. Paced by the daily cap below."
                warn
              />
            </div>
          </Field>

          {autoSend && (
            <Field
              label="Daily limit"
              hint="Cold email from arcai.agency shares a reputation with your invoice mail. 40/day is the safe pace."
            >
              <Select
                value={String(dailyCap)}
                onChange={(e) => setDailyCap(Number(e.target.value))}
              >
                <option value="20">20 emails / day — very cautious</option>
                <option value="40">40 emails / day — recommended</option>
                <option value="100">100 emails / day — aggressive</option>
                <option value="150">150 emails / day — risky</option>
              </Select>
            </Field>
          )}

          <Field
            label="Who gets emailed"
            hint="Won deals, lost deals, existing clients, anyone already emailed, and anyone who unsubscribed are always excluded."
          >
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 bg-white p-3">
              <input
                type="checkbox"
                checked={includeFindable}
                onChange={(e) => setIncludeFindable(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-primary-600"
              />
              <span className="text-sm">
                <span className="font-medium text-slate-800">
                  Also chase leads with no email on file
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Digs an address out of their website during research. Leads
                  where nothing turns up are skipped and flagged for you.
                </span>
              </span>
            </label>
          </Field>

          <PreviewPanel loading={loadingPreview} preview={preview} />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={launch}
        destructive={autoSend}
        confirmLabel={autoSend ? `Send to ${count} leads` : `Draft ${count} emails`}
        title={autoSend ? "Send without approval?" : "Start drafting?"}
        description={
          autoSend
            ? `${count} cold emails will be written and sent from support@arcai.agency with no further review, up to ${dailyCap} per day. You can pause at any time, but anything already delivered can't be recalled.`
            : `${count} emails will be researched and drafted. Nothing sends until you approve each one.`
        }
      />
    </>
  );
}

function ModeOption({
  active,
  onClick,
  icon,
  title,
  body,
  warn,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
  warn?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 rounded-xl border p-3 text-left transition",
        active
          ? warn
            ? "border-amber-300 bg-amber-50 ring-2 ring-amber-100"
            : "border-primary-300 bg-primary-50/50 ring-2 ring-primary-100"
          : "border-slate-200 bg-white hover:border-slate-300",
      )}
    >
      <span
        className={cn(
          "mt-0.5 shrink-0",
          active ? (warn ? "text-amber-600" : "text-primary-600") : "text-slate-400",
        )}
      >
        {icon}
      </span>
      <span>
        <span className="block text-sm font-semibold text-slate-800">{title}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{body}</span>
      </span>
    </button>
  );
}

function PreviewPanel({
  loading,
  preview,
}: {
  loading: boolean;
  preview: EligibilityPreview | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Counting eligible leads…
      </div>
    );
  }
  if (!preview) return null;

  const { excluded } = preview;
  const skipped = excluded.alreadyQueued + excluded.noContact + excluded.suppressed;

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
      <p className="text-sm font-semibold text-slate-800">
        {preview.count} lead{preview.count === 1 ? "" : "s"} will be emailed
        {preview.findable > 0 && (
          <span className="font-normal text-slate-500">
            {" "}
            · {preview.findable} need an address found first
          </span>
        )}
      </p>
      {preview.sample.length > 0 && (
        <p className="mt-1 truncate text-xs text-slate-500">
          e.g. {preview.sample.join(", ")}
          {preview.count > preview.sample.length && "…"}
        </p>
      )}
      {skipped > 0 && (
        <ul className="mt-2.5 flex flex-col gap-1 border-t border-slate-200 pt-2.5 text-xs text-slate-500">
          {excluded.alreadyQueued > 0 && (
            <li>{excluded.alreadyQueued} skipped — already drafted or emailed</li>
          )}
          {excluded.noContact > 0 && (
            <li>{excluded.noContact} skipped — no email and no website to search</li>
          )}
          {excluded.suppressed > 0 && (
            <li>{excluded.suppressed} skipped — unsubscribed or bounced</li>
          )}
        </ul>
      )}
      {preview.truncated && (
        <p className="mt-2 text-xs font-medium text-amber-700">
          Only the 2,000 newest leads are considered in one campaign.
        </p>
      )}
      {preview.count === 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Nothing to send. Every open lead is either already queued, has no
          contact route, or has opted out.
        </p>
      )}
    </div>
  );
}

// ---- Campaign card --------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  running: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  paused: "bg-amber-50 text-amber-700 ring-amber-200",
  done: "bg-slate-100 text-slate-600 ring-slate-200",
  cancelled: "bg-rose-50 text-rose-700 ring-rose-200",
};

function CampaignCard({ campaign, stats }: CampaignWithStats) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [cancelling, setCancelling] = React.useState(false);

  const live = campaign.status === "running" || campaign.status === "paused";
  const inFlight = stats.pending + stats.researching + stats.drafting;
  const donePct = stats.total
    ? Math.round(((stats.sent + stats.ready + stats.skipped + stats.failed) / stats.total) * 100)
    : 0;

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(msg);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-slate-900">
              {campaign.name}
            </h3>
            <Badge className={cn("ring-1", STATUS_STYLES[campaign.status])}>
              {campaign.status}
            </Badge>
            {campaign.auto_send ? (
              <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                <Send className="h-3 w-3" /> auto-sending · {campaign.daily_cap}/day
              </Badge>
            ) : (
              <Badge className="bg-slate-100 text-slate-600 ring-slate-200">
                <ShieldCheck className="h-3 w-3" /> needs approval
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {campaign.queued} queued ·{" "}
            {formatDistanceToNow(new Date(campaign.created_at), { addSuffix: true })}
          </p>
        </div>

        {live && (
          <div className="flex items-center gap-2">
            {campaign.status === "running" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => act(() => pauseCampaign(campaign.id), "Campaign paused.")}
              >
                <Pause className="h-3.5 w-3.5" /> Pause
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => act(() => resumeCampaign(campaign.id), "Campaign resumed.")}
              >
                <Play className="h-3.5 w-3.5" /> Resume
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setCancelling(true)}
            >
              <Ban className="h-3.5 w-3.5" /> Cancel
            </Button>
          </div>
        )}
      </div>

      {stats.total > 0 && (
        <>
          <div className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-primary-500 transition-all duration-500"
              style={{ width: `${donePct}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
            <Stat label="sent" value={stats.sent} tone="text-emerald-600" icon={<CheckCircle2 className="h-3 w-3" />} />
            {!campaign.auto_send && stats.ready > 0 && (
              <Stat label="awaiting approval" value={stats.ready} tone="text-primary-600" />
            )}
            {inFlight > 0 && (
              <Stat
                label={stats.researching ? "researching" : "drafting"}
                value={inFlight}
                tone="text-slate-500"
                icon={<Loader2 className="h-3 w-3 animate-spin" />}
              />
            )}
            {stats.skipped > 0 && <Stat label="skipped" value={stats.skipped} tone="text-slate-400" />}
            {stats.failed > 0 && <Stat label="failed" value={stats.failed} tone="text-rose-600" />}
          </div>
        </>
      )}

      {campaign.status === "paused" && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Paused — no research, drafting or sending is happening. Resume to pick
          up where it left off.
        </p>
      )}

      <ConfirmDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        onConfirm={() =>
          act(() => cancelCampaign(campaign.id), "Campaign cancelled.")
        }
        title="Cancel this campaign?"
        confirmLabel="Cancel campaign"
        description="Un-sent drafts are discarded so those leads are free for a future campaign. Emails already sent can't be recalled."
      />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: string;
  icon?: React.ReactNode;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", tone)}>
      {icon}
      {value} <span className="font-normal text-slate-400">{label}</span>
    </span>
  );
}
