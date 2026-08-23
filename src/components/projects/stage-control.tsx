"use client";

/**
 * Delivery stage and blocked state, on the project itself (LOOP-3, PLAN-7).
 *
 * Both used to live only on the Client Delivery hub, which is why no project
 * in the workspace had a stage set: the person doing the work was on the
 * project page, and the control was in another menu.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { differenceInCalendarDays, startOfToday } from "date-fns";
import {
  Check,
  ChevronRight,
  MessageSquareText,
  OctagonPause,
  PlayCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { DELIVERY_STAGES, DELIVERY_STAGE_META } from "@/lib/constants";
import type { DeliveryStage } from "@/lib/types";
import { cn } from "@/lib/utils";

import { setProjectBlocked, setProjectStage } from "@/app/(app)/projects/actions";
import { textStageUpdate } from "@/app/(app)/projects/client-sms-actions";

export function StageControl({
  projectId,
  stage,
  blockedReason,
  blockedSince,
  canTextClient,
}: {
  projectId: string;
  stage: DeliveryStage | null;
  blockedReason: string | null;
  blockedSince: string | null;
  /** False when the project has no client, or the client has no number. */
  canTextClient: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<DeliveryStage | null>(null);
  const [blockOpen, setBlockOpen] = React.useState(false);
  const [reason, setReason] = React.useState(blockedReason ?? "");
  const [gate, setGate] = React.useState<{
    stage: DeliveryStage;
    message: string;
  } | null>(null);
  // 0093 — offered right after a move, when "should the client know?" is
  // actually on someone's mind. Never automatic: most stage moves are internal
  // rhythm the client doesn't need a text about.
  const [offerText, setOfferText] = React.useState<DeliveryStage | null>(null);
  const [texting, setTexting] = React.useState(false);

  const currentIndex = stage ? DELIVERY_STAGES.indexOf(stage) : -1;

  async function move(next: DeliveryStage, force = false) {
    setBusy(next);
    const res = await setProjectStage(projectId, next, { force });
    setBusy(null);

    if (res.ok) {
      setGate(null);
      toast.success(`Moved to ${DELIVERY_STAGE_META[next].label}`);
      if (canTextClient) setOfferText(next);
      router.refresh();
      return;
    }
    // A gate is a question, not a failure — show what's wrong and let the
    // team decide, because a rule that can't be overridden gets worked around.
    if (res.gate) setGate({ stage: next, message: res.error });
    else toast.error(res.error);
  }

  async function toggleBlocked() {
    const next = blockedReason ? null : reason.trim();
    if (!blockedReason && !next) {
      toast.error("Say what you're waiting for.");
      return;
    }
    const res = await setProjectBlocked(projectId, next);
    if (res.ok) {
      setBlockOpen(false);
      toast.success(next ? "Marked as blocked" : "Unblocked");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  // date-fns rather than Date.now(): calling an impure global during render
  // is what react-hooks/purity forbids, and "since the start of today" is the
  // honest unit for a day count anyway.
  async function tellClient(target: DeliveryStage) {
    setTexting(true);
    const res = await textStageUpdate(projectId, target);
    setTexting(false);
    setOfferText(null);
    if (res.ok) toast.success("Client texted");
    else toast.error(res.error);
  }

  const blockedDays = blockedSince
    ? differenceInCalendarDays(startOfToday(), new Date(blockedSince))
    : 0;

  return (
    <div className="space-y-3">
      {blockedReason && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-2.5">
          <p className="text-sm text-amber-900">
            <span className="font-semibold">Blocked</span> — {blockedReason}
            <span className="ml-2 text-xs text-amber-700/80">
              {blockedDays === 0 ? "since today" : `${blockedDays} day${blockedDays === 1 ? "" : "s"}`}
            </span>
          </p>
          <Button size="sm" variant="outline" onClick={toggleBlocked}>
            <PlayCircle className="h-3.5 w-3.5" /> Unblock
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {DELIVERY_STAGES.map((s, i) => {
          const done = currentIndex > i;
          const current = currentIndex === i;
          return (
            <React.Fragment key={s}>
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
              <button
                type="button"
                onClick={() => move(s)}
                disabled={busy !== null}
                title={`Move to ${DELIVERY_STAGE_META[s].label}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-50",
                  current
                    ? "bg-primary-600 text-white shadow-sm"
                    : done
                      ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                      : "bg-slate-50 text-slate-500 hover:bg-slate-100 hover:text-slate-700",
                )}
              >
                {done && <Check className="h-3 w-3" strokeWidth={3} />}
                {DELIVERY_STAGE_META[s].label}
              </button>
            </React.Fragment>
          );
        })}

        {!blockedReason && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-1 text-xs"
            onClick={() => setBlockOpen(true)}
          >
            <OctagonPause className="h-3.5 w-3.5" /> Block
          </Button>
        )}
      </div>

      {currentIndex < 0 && (
        <p className="text-xs text-slate-400">
          Not in delivery yet — pick a stage to start tracking it, and the
          client&apos;s portal will show where the project is.
        </p>
      )}

      {/* Blocked --------------------------------------------------------- */}
      <Modal
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        title="What are we waiting for?"
        description="While a project is blocked the chaser and the stalled alert stand down, and the days are counted so you can point at them later."
        footer={
          <>
            <Button variant="outline" onClick={() => setBlockOpen(false)}>
              Cancel
            </Button>
            <Button onClick={toggleBlocked}>Mark blocked</Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Waiting on the client's product photos"
          />
        </Field>
      </Modal>

      {/* Tell the client? (0093) ----------------------------------------- */}
      <Modal
        open={!!offerText}
        onClose={() => setOfferText(null)}
        title="Text the client about this?"
        description={
          offerText
            ? `They'll get: "…has moved on — we're now at: ${DELIVERY_STAGE_META[offerText].clientLabel}."`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setOfferText(null)}>
              No, keep it internal
            </Button>
            <Button
              loading={texting}
              onClick={() => offerText && tellClient(offerText)}
            >
              <MessageSquareText className="h-4 w-4" /> Send the text
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          Only worth it when the move means something to them — starting the
          build, or being ready for their review.
        </p>
      </Modal>

      {/* Gate ------------------------------------------------------------ */}
      <Modal
        open={!!gate}
        onClose={() => setGate(null)}
        title="Are you sure?"
        description={gate?.message}
        footer={
          <>
            <Button variant="outline" onClick={() => setGate(null)}>
              Not yet
            </Button>
            <Button
              variant="danger"
              loading={busy !== null}
              onClick={() => gate && move(gate.stage, true)}
            >
              Move anyway
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          You can move it anyway — this is a reminder, not a lock.
        </p>
      </Modal>
    </div>
  );
}
