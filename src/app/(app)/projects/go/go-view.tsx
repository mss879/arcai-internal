"use client";

/**
 * Delivery on a phone (BIG-5, 0099).
 *
 * Four verbs per project — move it on, log the time, photograph what you
 * built, nudge the client — each a full-width tap target, each going through
 * the same server action the desktop uses. Nothing here is a shrunk-down
 * version of the board; it is the short list of things you do while standing
 * up.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";
import {
  ArrowRight,
  Camera,
  ChevronRight,
  Clock,
  CloudOff,
  MessageSquare,
  OctagonPause,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Field, Input, Textarea } from "@/components/ui/input";
import { DELIVERY_STAGES, DELIVERY_STAGE_META } from "@/lib/constants";
import {
  enqueueOutbox,
  listOutbox,
  removeFromOutbox,
  syncOutbox,
  type GoOutboxItem,
} from "@/lib/go-outbox";
// Type-only: the builder is server-only, the shape is not.
import type { GoProject } from "@/lib/go-projects";
import type { HealthTone } from "@/lib/projects";
import { cn, formatCurrency } from "@/lib/utils";

import { setProjectStage } from "../actions";
import { logTime } from "../plan-actions";
import { messageClient } from "../client-sms-actions";

export type { GoProject };

/**
 * 0119 — a server action called with no signal throws before it reaches the
 * server. Those, and only those, go to the outbox; a refusal from the gate
 * comes back as a normal result and is shown, never queued.
 */
function isNetworkFailure(e: unknown): boolean {
  return e instanceof TypeError || (typeof navigator !== "undefined" && !navigator.onLine);
}

/** True when the browser says we're offline — the outbox is the only route. */
function offline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** The outbox as React state, kept in step with the service worker's replays. */
function useOutbox() {
  const router = useRouter();
  const [items, setItems] = React.useState<GoOutboxItem[]>([]);
  const [online, setOnline] = React.useState(true);
  const [syncing, setSyncing] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      setItems(await listOutbox());
    } catch {
      setItems([]);
    }
  }, []);

  const sync = React.useCallback(async () => {
    setSyncing(true);
    try {
      const outcome = await syncOutbox();
      if (outcome.synced > 0) {
        toast.success(
          `Synced ${outcome.synced} change${outcome.synced === 1 ? "" : "s"} made offline.`,
        );
        router.refresh();
      }
      if (outcome.refused > 0) {
        toast.error(
          `${outcome.refused} change${outcome.refused === 1 ? " was" : "s were"} refused — see the list below.`,
        );
      }
    } catch {
      // Still offline, or the server is unreachable: keep them queued.
    } finally {
      setSyncing(false);
      void reload();
    }
  }, [reload, router]);

  React.useEffect(() => {
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    void reload();
    // Replay when the connection comes back, and whenever the page opens.
    const onOnline = () => {
      setOnline(true);
      void sync();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    void sync();

    // The service worker's Background Sync may replay while the page is open.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "go-outbox-synced") {
        void reload();
        router.refresh();
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    // A card just queued something.
    const onChanged = () => void reload();
    window.addEventListener("go-outbox-changed", onChanged);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("go-outbox-changed", onChanged);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [reload, router, sync]);

  const discard = React.useCallback(
    async (id: string) => {
      await removeFromOutbox([id]);
      await reload();
    },
    [reload],
  );

  return { items, online, syncing, sync, reload, discard };
}

const TONE_BAR: Record<HealthTone, string> = {
  good: "bg-emerald-500",
  watch: "bg-amber-500",
  risk: "bg-rose-500",
};

export function GoView({
  projects,
  userId,
}: {
  projects: GoProject[];
  userId: string;
}) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const outbox = useOutbox();

  return (
    <div className="mx-auto max-w-lg space-y-4 pb-28">
      <header className="px-1">
        <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-slate-900">
          <Smartphone className="h-5 w-5 text-primary-500" />
          On the go
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Everything live, worst first. Tap a project for the four things you can
          do without sitting down.
        </p>
      </header>

      {projects.length === 0 ? (
        <EmptyState
          icon={<Smartphone className="h-6 w-6" />}
          title="Nothing running"
          description="No open projects right now. Enjoy it."
        />
      ) : (
        <ul className="space-y-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              userId={userId}
              open={openId === p.id}
              onToggle={() => setOpenId(openId === p.id ? null : p.id)}
            />
          ))}
        </ul>
      )}

      <p className="px-1 text-center text-xs text-slate-400">
        Add this page to your home screen — the app is already installable. It
        works without signal: stage moves and time entries wait here and sync
        when you&apos;re back.
      </p>

      <QuickBar
        online={outbox.online}
        items={outbox.items}
        syncing={outbox.syncing}
        onSync={outbox.sync}
        onDiscard={outbox.discard}
      />
    </div>
  );
}

/**
 * 0119 — the strip along the bottom: are we online, what is waiting to sync,
 * and a way to push it now or drop something the server refused.
 */
function QuickBar({
  online,
  items,
  syncing,
  onSync,
  onDiscard,
}: {
  online: boolean;
  items: GoOutboxItem[];
  syncing: boolean;
  onSync: () => void;
  onDiscard: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const refused = items.filter((i) => i.error).length;

  if (online && items.length === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-lg px-3 pb-3">
      <div className="rounded-2xl border border-slate-200 bg-white/95 shadow-lg backdrop-blur">
        <div className="flex items-center gap-3 px-4 py-3">
          <span
            className={cn(
              "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
              online ? "bg-primary-50 text-primary-600" : "bg-amber-50 text-amber-600",
            )}
          >
            {online ? <RefreshCw className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />}
          </span>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="min-w-0 flex-1 text-left"
          >
            <p className="text-sm font-semibold text-slate-900">
              {online ? "Back online" : "No signal"}
              {items.length > 0 && (
                <span className="ml-2 rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white">
                  {items.length} pending
                </span>
              )}
            </p>
            <p className="truncate text-xs text-slate-500">
              {items.length === 0
                ? "Everything is saved."
                : refused > 0
                  ? `${refused} refused by the server — tap to see why.`
                  : online
                    ? "Waiting to sync — tap to see what."
                    : "Your changes are kept here and sent when you're back."}
            </p>
          </button>
          {online && items.length > 0 && (
            <Button size="sm" onClick={onSync} loading={syncing}>
              Sync now
            </Button>
          )}
        </div>

        {open && items.length > 0 && (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-800">{i.label}</p>
                  <p className={cn("truncate text-xs", i.error ? "text-rose-600" : "text-slate-400")}>
                    {i.error ?? `Queued ${format(parseISO(i.createdAt), "d MMM, h:mm a")}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onDiscard(i.id)}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  aria-label="Drop this change"
                  title="Drop this change"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProjectCard({
  project: p,
  userId,
  open,
  onToggle,
}: {
  project: GoProject;
  userId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [logging, setLogging] = React.useState(false);
  const [nudging, setNudging] = React.useState(false);
  const [minutes, setMinutes] = React.useState("60");
  const [note, setNote] = React.useState("");
  const [nudge, setNudge] = React.useState("");

  const stageIndex = p.stage ? DELIVERY_STAGES.indexOf(p.stage) : -1;
  const nextStage =
    stageIndex >= 0 && stageIndex < DELIVERY_STAGES.length - 1
      ? DELIVERY_STAGES[stageIndex + 1]
      : stageIndex === -1
        ? DELIVERY_STAGES[0]
        : null;

  /** 0119 — park it for later, with the words the list shows. */
  async function queue(kind: "advance_stage" | "log_time", label: string, payload: Record<string, unknown>) {
    try {
      await enqueueOutbox({ kind, label, payload });
      toast.success("No signal — saved. It syncs when you're back online.");
      window.dispatchEvent(new Event("go-outbox-changed"));
    } catch {
      toast.error("Couldn't save this offline on this device.");
    }
  }

  async function advance() {
    if (!nextStage) return;
    const label = `${p.name} → ${DELIVERY_STAGE_META[nextStage].label}`;
    const payload = { project_id: p.id, stage: nextStage };
    if (offline()) {
      await queue("advance_stage", label, payload);
      return;
    }
    setBusy(true);
    try {
      const res = await setProjectStage(p.id, nextStage);
      if (res.ok) {
        toast.success(`Moved to ${DELIVERY_STAGE_META[nextStage].label}.`);
        router.refresh();
      } else {
        // The deposit gate and the launch checklist explain themselves — show
        // the reason rather than a generic failure.
        toast.error(res.error);
      }
    } catch (e) {
      if (isNetworkFailure(e)) await queue("advance_stage", label, payload);
      else toast.error("That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function submitTime() {
    const label = `${minutes} min on ${p.name}`;
    const payload = {
      project_id: p.id,
      minutes: Number(minutes),
      note: note.trim() || null,
      worked_on: new Date().toISOString().slice(0, 10),
    };
    if (offline()) {
      await queue("log_time", label, payload);
      setLogging(false);
      setNote("");
      return;
    }
    setBusy(true);
    try {
      const res = await logTime({
        project_id: p.id,
        minutes: Number(minutes),
        note: note.trim() || null,
        user_id: userId,
      });
      if (res.ok) {
        toast.success(`Logged ${minutes} minutes.`);
        setLogging(false);
        setNote("");
        router.refresh();
      } else toast.error(res.error);
    } catch (e) {
      if (isNetworkFailure(e)) {
        await queue("log_time", label, payload);
        setLogging(false);
        setNote("");
      } else toast.error("That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function submitNudge() {
    setBusy(true);
    const res = await messageClient(p.id, nudge);
    setBusy(false);
    if (res.ok) {
      toast.success("Texted.");
      setNudging(false);
      setNudge("");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <li className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-stretch gap-0 text-left"
      >
        <span className={cn("w-1.5 shrink-0", TONE_BAR[p.healthTone])} />
        <span className="min-w-0 flex-1 px-4 py-3.5">
          <span className="flex items-start justify-between gap-2">
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-slate-900">
                {p.name}
              </span>
              {p.clientName && (
                <span className="block truncate text-xs text-slate-400">
                  {p.clientName}
                </span>
              )}
            </span>
            <ChevronRight
              className={cn(
                "h-5 w-5 shrink-0 text-slate-300 transition-transform",
                open && "rotate-90",
              )}
            />
          </span>

          {p.why && (
            <span className="mt-2 block text-xs leading-relaxed text-slate-600">
              {p.why}
            </span>
          )}

          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            {p.stage && (
              <Badge className={DELIVERY_STAGE_META[p.stage].badge}>
                {DELIVERY_STAGE_META[p.stage].label}
              </Badge>
            )}
            {p.blocked && (
              <Badge className="bg-amber-100/80 text-amber-800 ring-amber-300/70">
                <OctagonPause className="h-3 w-3" /> Blocked
              </Badge>
            )}
            {p.assetsOutstanding > 0 && (
              <Badge className="bg-sky-50 text-sky-700 ring-sky-200">
                {p.assetsOutstanding} asset
                {p.assetsOutstanding === 1 ? "" : "s"} missing
              </Badge>
            )}
            {p.balance > 0 && (
              <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                {formatCurrency(p.balance, p.currency)} due
              </Badge>
            )}
            {p.dueDate && (
              <span className="text-[11px] text-slate-400">
                due {format(parseISO(p.dueDate), "d MMM")}
              </span>
            )}
          </span>
        </span>
      </button>

      {open && (
        <div className="grid grid-cols-2 gap-2 border-t border-slate-100 p-3">
          <Button
            variant="outline"
            onClick={advance}
            loading={busy}
            disabled={!nextStage}
            className="h-12 justify-start"
          >
            <ArrowRight className="h-4 w-4" />
            <span className="truncate">
              {nextStage ? DELIVERY_STAGE_META[nextStage].label : "Finished"}
            </span>
          </Button>

          <Button
            variant="outline"
            onClick={() => setLogging(true)}
            className="h-12 justify-start"
          >
            <Clock className="h-4 w-4" /> Log time
          </Button>

          {/* The camera lives on the project page, where the draft can be read
              and edited before it is filed — a two-line client update is not
              something to approve blind on a phone. */}
          <Link href={`/projects/${p.id}`} className="contents">
            <Button variant="outline" className="h-12 w-full justify-start">
              <Camera className="h-4 w-4" /> Photograph
            </Button>
          </Link>

          <Button
            variant="outline"
            onClick={() => setNudging(true)}
            disabled={!p.clientPhone}
            className="h-12 justify-start"
            title={p.clientPhone ? undefined : "No phone number on this client"}
          >
            <MessageSquare className="h-4 w-4" /> Nudge
          </Button>
        </div>
      )}

      <Modal
        open={logging}
        onClose={() => setLogging(false)}
        title="Log time"
        description={p.name}
      >
        <div className="space-y-4">
          <Field label="Minutes">
            <Input
              type="number"
              inputMode="numeric"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              className="text-lg"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            {[15, 30, 60, 120, 240].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMinutes(String(m))}
                className="rounded-full bg-slate-100 px-3.5 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200"
              >
                {m < 60 ? `${m}m` : `${m / 60}h`}
              </button>
            ))}
          </div>
          <Field label="What on?">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setLogging(false)}>
              Cancel
            </Button>
            <Button onClick={submitTime} loading={busy}>
              Log it
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={nudging}
        onClose={() => setNudging(false)}
        title="Nudge the client"
        description={p.clientName ?? p.name}
      >
        <div className="space-y-4">
          <Textarea
            value={nudge}
            onChange={(e) => setNudge(e.target.value)}
            rows={4}
            placeholder={`Hi, just checking in on ${p.name} — anything you need from us?`}
          />
          {p.assetsOutstanding > 0 && (
            <button
              type="button"
              onClick={() =>
                setNudge(
                  `Hi! We're ready to keep moving on ${p.name} — we're just waiting on ${p.assetsOutstanding} thing${p.assetsOutstanding === 1 ? "" : "s"} from you. Anything we can help with? — ARC AI`,
                )
              }
              className="w-full rounded-xl bg-slate-50 px-3 py-2 text-left text-xs text-slate-600 ring-1 ring-slate-200 transition hover:bg-white"
            >
              Use the &ldquo;still waiting on assets&rdquo; wording
            </button>
          )}
          <p className="text-xs text-slate-400">
            Sent by SMS to the client on this project, and filed to its history.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setNudging(false)}>
              Cancel
            </Button>
            <Button onClick={submitNudge} loading={busy} disabled={!nudge.trim()}>
              Send
            </Button>
          </div>
        </div>
      </Modal>
    </li>
  );
}
