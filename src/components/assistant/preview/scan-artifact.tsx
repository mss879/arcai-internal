"use client";

/**
 * A Find Leads area scan, watched live.
 *
 * Every other artifact is a picture of something already finished. This one
 * is a window onto work still happening: a scan sweeps a town for minutes,
 * far past the sixty seconds an assistant turn is allowed, so the tool that
 * starts one has nothing to report and this panel does the reporting instead.
 *
 * Three things keep it honest and cheap:
 *
 *   • It reads the real rows. `prospect_scans` and `prospect_candidates` are
 *     both in the realtime publication and readable under the caller's own
 *     RLS, so the panel subscribes rather than being told what to think.
 *   • It DRIVES the scan. The engine advances one step per call and is
 *     normally pushed along by the every-minute cron; while a panel is on
 *     screen it also calls `advanceProspecting()` every six seconds, exactly
 *     as the CRM page's own `use-drive-prospecting` does. That is what turns
 *     "eventually" into "while you watch".
 *   • It never lies about the total. Counts come from the scan row; until the
 *     search step commits, they are zero and it says "Searching".
 *
 * Works on both surfaces: white in the classic canvas, dark on the stage.
 */

import * as React from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import {
  CircleAlert,
  Globe,
  Loader2,
  MapPin,
  Phone,
  Star,
} from "lucide-react";

import { advanceProspecting } from "@/app/(app)/crm/prospecting/actions";
import { useArcusRealtime } from "@/components/assistant/use-arcus-realtime";
import { useReducedMotionSafe } from "@/components/assistant/studio-store";
import { createClient } from "@/lib/supabase/client";
import type {
  ProspectCandidateStatus,
  ProspectScanStatus,
  ProspectVerdict,
} from "@/lib/database.types";
import { cn } from "@/lib/utils";
import type { ArtifactOf } from "./artifact-format";

/**
 * The map is a second-level dynamic import: maplibre-gl is a quarter-megabyte
 * of WebGL that must never ride in the main bundle, and most scans are read
 * as a list. It loads the first time someone flips the toggle.
 */
const ScanMap = dynamic(() => import("./scan-map"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full min-h-[280px] place-items-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--stage-accent)]" />
    </div>
  ),
});

/** Same cadence as the prospecting page — one advance at a time, no overlap. */
const POLL_MS = 6000;
/** Candidate rows rendered; a scan is capped at 120 and the rest can scroll. */
const MAX_ROWS = 120;

const PHASES: { key: ProspectScanStatus; label: string }[] = [
  { key: "searching", label: "Search" },
  { key: "qualifying", label: "Qualify" },
  { key: "drafting", label: "Draft" },
  { key: "importing", label: "Import" },
  { key: "done", label: "Done" },
];

const TERMINAL = new Set<ProspectScanStatus>(["done", "error"]);

/**
 * How each verdict reads to us. The point of a scan is finding businesses
 * whose web presence is bad, so "no website" is the *good* result and is
 * coloured as the win it is.
 */
const VERDICT: Record<ProspectVerdict, { label: string; cls: string }> = {
  no_website: {
    label: "No website",
    cls: "bg-primary-500/15 text-primary-300 ring-primary-500/30",
  },
  facebook_only: {
    label: "Facebook only",
    cls: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  },
  bad_website: {
    label: "Weak site",
    cls: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  },
  broken: {
    label: "Broken site",
    cls: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  },
  good_website: {
    label: "Good site",
    cls: "bg-slate-500/15 text-slate-400 ring-slate-500/25",
  },
  duplicate: {
    label: "Already known",
    cls: "bg-slate-500/15 text-slate-400 ring-slate-500/25",
  },
  excluded: {
    label: "Excluded",
    cls: "bg-slate-500/15 text-slate-400 ring-slate-500/25",
  },
  unverified: {
    label: "Unverified",
    cls: "bg-slate-500/15 text-slate-400 ring-slate-500/25",
  },
  pending: {
    label: "Checking…",
    cls: "bg-slate-500/15 text-slate-400 ring-slate-500/25",
  },
};

type ScanRow = {
  id: string;
  status: ProspectScanStatus;
  city: string;
  country: string;
  categories: string[];
  max_results: number;
  min_score: number;
  found: number;
  qualified: number;
  skipped: number;
  imported: number;
  error: string | null;
};

type CandidateRow = {
  id: string;
  name: string;
  category: string;
  address: string;
  phone: string;
  website: string;
  rating: number | null;
  rating_count: number;
  website_verdict: ProspectVerdict;
  score: number | null;
  status: ProspectCandidateStatus;
  lat: number | null;
  lng: number | null;
};

export type ScanArtifactProps = {
  artifact: ArtifactOf<"scan">;
  /** False while the tab is not selected — gates the drive loop. */
  active: boolean;
  stage?: boolean;
  onPrompt?: (text: string) => void;
  onNavigate: (href: string) => void;
};

export function ScanArtifact({
  artifact,
  active,
  stage,
  onPrompt,
  onNavigate,
}: ScanArtifactProps): React.ReactElement {
  const scanId = artifact.scanId;
  const reduced = useReducedMotionSafe();

  // Seeded from the snapshot so the panel paints before the first query
  // returns — a scan that appears blank for a second reads as broken.
  const [scan, setScan] = React.useState<ScanRow>(() => ({
    id: scanId,
    ...artifact.snapshot,
    error: artifact.snapshot.error ?? null,
  }));
  const [candidates, setCandidates] = React.useState<CandidateRow[]>([]);
  const [missing, setMissing] = React.useState(false);
  const [view, setView] = React.useState<"list" | "map">("list");
  const [centre, setCentre] = React.useState<{ lat: number; lng: number } | null>(
    null,
  );

  const load = React.useCallback(async () => {
    try {
      const supabase = createClient();
      const [scanRes, candRes] = await Promise.all([
        supabase
          .from("prospect_scans")
          .select(
            "id, status, city, country, categories, max_results, min_score, found, qualified, skipped, imported, error, analysis",
          )
          .eq("id", scanId)
          .maybeSingle(),
        supabase
          .from("prospect_candidates")
          .select(
            "id, name, category, address, phone, website, rating, rating_count, website_verdict, score, status, lat, lng",
          )
          .eq("scan_id", scanId)
          .order("score", { ascending: false, nullsFirst: false })
          .limit(MAX_ROWS),
      ]);
      if (scanRes.data) {
        const { analysis, ...row } = scanRes.data as ScanRow & {
          analysis?: { centre?: { lat?: number; lng?: number } } | null;
        };
        setScan(row as ScanRow);
        const c = analysis?.centre;
        if (typeof c?.lat === "number" && typeof c?.lng === "number") {
          setCentre({ lat: c.lat, lng: c.lng });
        }
        setMissing(false);
      } else if (scanRes.error === null) {
        // The row is gone — deleted from the CRM page while this panel was
        // open. Say so rather than showing a frozen snapshot forever.
        setMissing(true);
      }
      setCandidates((candRes.data ?? []) as CandidateRow[]);
    } catch {
      // A failed poll is not worth an error state; the next one is 6s away.
    }
  }, [scanId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Both tables are realtime-published (0044). The hook subscribes per table
  // and filters nothing server-side, so the scan id is checked here.
  const onScanChange = React.useCallback(
    (payload: { new?: unknown }) => {
      const row = payload.new as { id?: string } | undefined;
      if (row?.id === scanId) void load();
    },
    [scanId, load],
  );
  const onCandidateChange = React.useCallback(
    (payload: { new?: unknown }) => {
      const row = payload.new as { scan_id?: string } | undefined;
      if (row?.scan_id === scanId) void load();
    },
    [scanId, load],
  );

  useArcusRealtime("prospect_scans", onScanChange, active);
  useArcusRealtime("prospect_candidates", onCandidateChange, active);

  // Drive the scan while it is on screen. Non-overlapping and visibility-gated
  // for the same reason the CRM page's version is: a queued pile of advances
  // against a 45s lease accomplishes nothing except burning Places quota.
  const running = !TERMINAL.has(scan.status) && !missing;
  React.useEffect(() => {
    if (!active || !running) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        await advanceProspecting();
      } catch {
        // The cron is the backstop; a failed nudge changes nothing.
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = window.setInterval(() => {
      if (!cancelled) void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, running]);

  const phaseIndex = PHASES.findIndex((p) => p.key === scan.status);
  const dim = stage ? "text-[var(--stage-faint)]" : "text-slate-400";
  const body = stage ? "text-[var(--stage-text)]" : "text-slate-900";
  const border = stage ? "border-[var(--stage-border)]" : "border-slate-200/80";
  const panel = stage ? "bg-[var(--stage-panel)]" : "bg-white";

  if (missing) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <CircleAlert className={cn("mx-auto h-6 w-6", dim)} />
          <p className={cn("mt-2 text-[13px]", body)}>
            This scan no longer exists — it was deleted from Find Leads.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {/* Phase stepper + view toggle */}
      <div className="flex items-center gap-1.5">
        <ViewToggle
          view={view}
          onChange={setView}
          mappable={candidates.some((c) => c.lat != null && c.lng != null)}
          stage={stage}
        />
        {PHASES.map((phase, i) => {
          const reached = phaseIndex >= i && scan.status !== "error";
          const current = phaseIndex === i && running;
          return (
            <React.Fragment key={phase.key}>
              {i > 0 && (
                <span
                  aria-hidden
                  className={cn(
                    "h-px flex-1",
                    reached
                      ? "bg-primary-500/60"
                      : stage
                        ? "bg-white/10"
                        : "bg-slate-200",
                  )}
                />
              )}
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors",
                  current
                    ? "bg-primary-500/15 text-primary-300 ring-primary-500/40"
                    : reached
                      ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25"
                      : stage
                        ? "text-[var(--stage-faint)] ring-white/10"
                        : "text-slate-400 ring-slate-200",
                )}
              >
                {current && <Loader2 className="h-3 w-3 animate-spin" />}
                {phase.label}
              </span>
            </React.Fragment>
          );
        })}
      </div>

      {scan.status === "error" && scan.error && (
        <p className="flex items-start gap-1.5 rounded-xl bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300 ring-1 ring-inset ring-rose-500/25">
          <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          {scan.error}
        </p>
      )}

      {/* Counters */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: "Found", value: scan.found },
          { label: "Qualified", value: scan.qualified },
          { label: "Skipped", value: scan.skipped },
          { label: "Imported", value: scan.imported },
        ].map((tile) => (
          <div
            key={tile.label}
            className={cn("rounded-xl border p-2.5", border, panel)}
          >
            <p className={cn("text-[10px] uppercase tracking-wide", dim)}>
              {tile.label}
            </p>
            <p className={cn("mt-0.5 text-xl font-semibold tabular-nums", body)}>
              {tile.value}
            </p>
          </div>
        ))}
      </div>

      {/* Candidates — as a list, or on the map. */}
      {view === "map" ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--stage-border)]">
          <ScanMap candidates={candidates} centre={centre} />
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {candidates.length === 0 ? (
          <p className={cn("py-10 text-center text-[13px]", dim)}>
            {running
              ? `Sweeping ${scan.city} for ${scan.categories.join(", ")}…`
              : "Nothing came back for this sweep."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            <AnimatePresence initial={false}>
              {candidates.map((c) => {
                const verdict = VERDICT[c.website_verdict] ?? VERDICT.pending;
                return (
                  <motion.li
                    key={c.id}
                    layout={!reduced}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18 }}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border px-3 py-2",
                      border,
                      panel,
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className={cn("truncate text-[13px] font-medium", body)}>
                        {c.name}
                      </p>
                      <p
                        className={cn(
                          "mt-0.5 flex items-center gap-2.5 text-[11px]",
                          dim,
                        )}
                      >
                        {c.address && (
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <MapPin className="h-3 w-3 shrink-0" />
                            <span className="truncate">{c.address}</span>
                          </span>
                        )}
                        {c.phone && (
                          <span className="inline-flex shrink-0 items-center gap-1">
                            <Phone className="h-3 w-3" />
                            {c.phone}
                          </span>
                        )}
                        {c.rating != null && (
                          <span className="inline-flex shrink-0 items-center gap-1">
                            <Star className="h-3 w-3" />
                            {c.rating} ({c.rating_count})
                          </span>
                        )}
                        {c.website && (
                          <span className="inline-flex shrink-0 items-center gap-1">
                            <Globe className="h-3 w-3" />
                          </span>
                        )}
                      </p>
                    </div>
                    {c.score != null && (
                      <span
                        className={cn(
                          "shrink-0 text-[12px] font-semibold tabular-nums",
                          body,
                        )}
                      >
                        {c.score}
                      </span>
                    )}
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                        verdict.cls,
                      )}
                    >
                      {verdict.label}
                    </span>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>
      )}

      {/* What to do next, once there is something to do it with. */}
      {!running && candidates.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {scan.imported > 0 ? (
            <ActionChip
              stage={stage}
              onClick={() => onNavigate("/crm")}
              label={`See the ${scan.imported} new leads`}
            />
          ) : (
            onPrompt && (
              <ActionChip
                stage={stage}
                onClick={() =>
                  onPrompt(
                    `Import the qualified leads from the ${scan.city} scan`,
                  )
                }
                label="Import the qualified leads"
              />
            )
          )}
          {onPrompt && (
            <ActionChip
              stage={stage}
              onClick={() =>
                onPrompt(`Draft outreach for the ${scan.city} scan leads`)
              }
              label="Draft outreach"
            />
          )}
          <ActionChip
            stage={stage}
            onClick={() => onNavigate(`/crm/prospecting?scan=${scanId}`)}
            label="Open the full scan"
          />
        </div>
      )}
    </div>
  );
}

function ActionChip({
  label,
  onClick,
  stage,
}: {
  label: string;
  onClick: () => void;
  stage?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
        stage
          ? "border-[var(--stage-border-strong)] bg-[var(--stage-panel)] text-[var(--stage-text)] hover:bg-[var(--stage-panel-hover)]"
          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      {label}
    </button>
  );
}

function ViewToggle({
  view,
  onChange,
  mappable,
  stage,
}: {
  view: "list" | "map";
  onChange: (v: "list" | "map") => void;
  /** False until at least one candidate has coordinates. */
  mappable: boolean;
  stage?: boolean;
}) {
  return (
    <div
      className={cn(
        "mr-1 flex shrink-0 items-center rounded-lg border p-0.5",
        stage ? "border-[var(--stage-border)]" : "border-slate-200",
      )}
    >
      {(["list", "map"] as const).map((v) => (
        <button
          key={v}
          type="button"
          disabled={v === "map" && !mappable}
          title={
            v === "map" && !mappable
              ? "No coordinates yet — scans from before migration 0104 have none"
              : undefined
          }
          onClick={() => onChange(v)}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            view === v
              ? "bg-primary-500/20 text-primary-300"
              : stage
                ? "text-[var(--stage-faint)] hover:text-[var(--stage-text)]"
                : "text-slate-400 hover:text-slate-700",
          )}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
