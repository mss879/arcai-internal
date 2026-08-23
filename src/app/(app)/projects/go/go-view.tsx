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
  MessageSquare,
  OctagonPause,
  Smartphone,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Field, Input, Textarea } from "@/components/ui/input";
import { DELIVERY_STAGES, DELIVERY_STAGE_META } from "@/lib/constants";
import type { HealthTone } from "@/lib/projects";
import type { DeliveryStage } from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";

import { setProjectStage } from "../actions";
import { logTime } from "../plan-actions";
import { messageClient } from "../client-sms-actions";

export type GoProject = {
  id: string;
  name: string;
  clientName: string | null;
  clientPhone: string | null;
  stage: DeliveryStage | null;
  currency: string;
  balance: number;
  dueDate: string | null;
  idleDays: number | null;
  blocked: boolean;
  assetsOutstanding: number;
  overdueTasks: number;
  healthTone: HealthTone;
  healthScore: number;
  why: string | null;
  riskRank: number | null;
};

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

  return (
    <div className="mx-auto max-w-lg space-y-4 pb-24">
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
        Add this page to your home screen — the app is already installable.
      </p>
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

  async function advance() {
    if (!nextStage) return;
    setBusy(true);
    const res = await setProjectStage(p.id, nextStage);
    setBusy(false);
    if (res.ok) {
      toast.success(`Moved to ${DELIVERY_STAGE_META[nextStage].label}.`);
      router.refresh();
    } else {
      // The deposit gate and the launch checklist explain themselves — show
      // the reason rather than a generic failure.
      toast.error(res.error);
    }
  }

  async function submitTime() {
    setBusy(true);
    const res = await logTime({
      project_id: p.id,
      minutes: Number(minutes),
      note: note.trim() || null,
      user_id: userId,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(`Logged ${minutes} minutes.`);
      setLogging(false);
      setNote("");
      router.refresh();
    } else toast.error(res.error);
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
