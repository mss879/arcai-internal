"use client";

/**
 * The strip across the top of the stage — the nameplate: wordmark, status,
 * clock. The working detail (tool log, wake state) lives in the system rail,
 * where the reference art puts it; two copies of the same signal is noise.
 *
 * Memoised, and its props deliberately exclude `level` — see the note in
 * `command-view.tsx`. The clock's one-second interval lives INSIDE this
 * component so the tick re-renders a nameplate, not a stage.
 */

import * as React from "react";
import { Hand, MonitorCog } from "lucide-react";

import type { Status } from "@/components/assistant/use-voice-chat";
import { useReducedMotionSafe } from "@/components/assistant/studio-store";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<Status, string> = {
  idle: "Online",
  listening: "Listening",
  thinking: "Working",
  speaking: "Speaking",
};

const STATUS_DOT: Record<Status, string> = {
  idle: "bg-emerald-400",
  listening: "bg-primary-400",
  thinking: "bg-amber-400",
  speaking: "bg-sky-400",
};

function Clock() {
  // null until mounted: the server has no idea what time it is where the
  // user is, and rendering one on the server is a hydration mismatch.
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!now) return null;
  return (
    <span className="hud-mono tabular-nums text-[12px] tracking-widest text-[var(--stage-dim)]">
      {now.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
    </span>
  );
}

function CommandHudImpl({
  status,
  personaName,
  isTerminal,
  interactive,
}: {
  status: Status;
  personaName: string;
  isTerminal?: boolean;
  /** Interactivity mode armed — the hand is an input device right now. */
  interactive?: boolean;
}) {
  const reduced = useReducedMotionSafe();
  // A.R.C.U.S — the reference's letter-spaced nameplate.
  const wordmark = personaName
    .toUpperCase()
    .split("")
    .join(".");

  return (
    <div className="flex h-12 shrink-0 items-center gap-4 px-4">
      <span className="hud-panel hud-panel--tight px-3 py-1">
        <span className="hud-title text-[11px]">{wordmark}</span>
      </span>

      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            STATUS_DOT[status],
            status !== "idle" && !reduced && "animate-pulse",
          )}
        />
        <span className="hud-mono text-[10px] uppercase tracking-[0.24em] text-[var(--stage-dim)]">
          {STATUS_LABEL[status]}
        </span>
      </span>

      {/* The angular divider from the reference header. */}
      <span
        aria-hidden
        className="h-px flex-1"
        style={{
          background:
            "linear-gradient(90deg, rgb(249 115 22 / 0.4), rgb(249 115 22 / 0.06))",
        }}
      />

      {interactive && (
        <span
          title="Interactivity mode — camera tracks your hand; the feed is never displayed"
          className="hud-mono flex items-center gap-1.5 text-[9px] uppercase tracking-[0.2em] text-emerald-300"
        >
          <Hand className="h-3 w-3" />
          Interactive
        </span>
      )}
      {isTerminal && (
        <span
          title="This machine is the Arcus terminal"
          className="hud-mono flex items-center gap-1.5 text-[9px] uppercase tracking-[0.2em] text-[var(--stage-faint)]"
        >
          <MonitorCog className="h-3 w-3" />
          Terminal
        </span>
      )}
      <Clock />
    </div>
  );
}

export const CommandHud = React.memo(CommandHudImpl);
