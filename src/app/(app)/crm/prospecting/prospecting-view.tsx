"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Globe,
  Mail,
  MapPin,
  MessageSquareText,
  Phone,
  Radar,
  RefreshCw,
  Send,
  Star,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import { cn } from "@/lib/utils";
import type {
  ProspectCandidate,
  ProspectScan,
  ProspectScanSchedule,
  ProspectScanStatus,
} from "@/lib/types";

import {
  deleteProspectScan,
  recheckProspect,
  recheckScanAll,
  sendProspectEmail,
  sendProspectSms,
  startProspectScan,
} from "./actions";
import { SchedulesCard } from "./schedules-card";
import { useDriveProspecting } from "./use-drive-prospecting";

export type PipelineOption = {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
};

const COUNTRIES = [
  "Sri Lanka",
  "India",
  "Australia",
  "United Kingdom",
  "New Zealand",
  "Singapore",
  "United Arab Emirates",
  "United States",
  "Canada",
];

const SL_CITIES = [
  "Colombo",
  "Kandy",
  "Galle",
  "Negombo",
  "Gampaha",
  "Nugegoda",
  "Dehiwala-Mount Lavinia",
  "Moratuwa",
  "Kurunegala",
  "Matara",
  "Jaffna",
  "Anuradhapura",
  "Batticaloa",
  "Ratnapura",
];

/** Business types that genuinely need websites — the scan's search queries. */
const CATEGORIES = [
  "Restaurants",
  "Cafes & bakeries",
  "Hotels & guest houses",
  "Salons & spas",
  "Dental clinics",
  "Medical clinics",
  "Law firms",
  "Real estate agencies",
  "Construction companies",
  "Gyms & fitness centers",
  "Car repair & service",
  "Travel agencies",
  "Clothing stores",
  "Furniture stores",
  "Photographers",
  "Event planners",
  "Tuition & training centers",
  "Printing services",
  "Jewellery stores",
  "Pet care & vets",
];

const PHASES: { key: ProspectScanStatus; label: string }[] = [
  { key: "searching", label: "Finding businesses" },
  { key: "qualifying", label: "Checking websites" },
  { key: "drafting", label: "Writing outreach" },
  { key: "importing", label: "Adding to CRM" },
];

const STATUS_META: Record<ProspectScanStatus, { label: string; badge: string }> = {
  pending: { label: "Queued", badge: "bg-slate-100 text-slate-600 ring-slate-200" },
  searching: { label: "Finding businesses…", badge: "bg-sky-50 text-sky-700 ring-sky-200" },
  qualifying: { label: "Checking websites…", badge: "bg-sky-50 text-sky-700 ring-sky-200" },
  drafting: { label: "Writing outreach…", badge: "bg-violet-50 text-violet-700 ring-violet-200" },
  importing: { label: "Adding to CRM…", badge: "bg-violet-50 text-violet-700 ring-violet-200" },
  done: { label: "Done", badge: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  error: { label: "Failed", badge: "bg-rose-50 text-rose-700 ring-rose-200" },
};

const VERDICT_META: Record<string, { label: string; badge: string }> = {
  no_website: { label: "No website", badge: "bg-rose-50 text-rose-700 ring-rose-200" },
  facebook_only: { label: "Social page only", badge: "bg-amber-50 text-amber-700 ring-amber-200" },
  bad_website: { label: "Weak website", badge: "bg-orange-50 text-orange-700 ring-orange-200" },
  broken: { label: "Site down", badge: "bg-rose-50 text-rose-700 ring-rose-200" },
  good_website: { label: "Good website", badge: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  excluded: { label: "Not a fit", badge: "bg-slate-100 text-slate-500 ring-slate-200" },
  duplicate: { label: "Already in CRM", badge: "bg-slate-100 text-slate-500 ring-slate-200" },
  unverified: { label: "Couldn't verify", badge: "bg-slate-100 text-slate-500 ring-slate-200" },
  pending: { label: "Checking…", badge: "bg-slate-100 text-slate-500 ring-slate-200" },
};

const IN_PROGRESS: ProspectScanStatus[] = [
  "pending",
  "searching",
  "qualifying",
  "drafting",
  "importing",
];

export function ProspectingView({
  scans,
  selectedId,
  candidates,
  pipelines,
  schedules,
  configured,
  placesConfigured,
  smsConfigured,
  emailConfigured,
}: {
  scans: ProspectScan[];
  selectedId: string | null;
  candidates: ProspectCandidate[];
  pipelines: PipelineOption[];
  schedules: ProspectScanSchedule[];
  configured: boolean;
  placesConfigured: boolean;
  smsConfigured: boolean;
  emailConfigured: boolean;
}) {
  useRealtimeSyncTables(["prospect_scans", "prospect_candidates"]);

  const selected = scans.find((s) => s.id === selectedId) ?? null;
  const anyRunning = scans.some((s) => IN_PROGRESS.includes(s.status));
  useDriveProspecting(anyRunning);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
          <Radar className="h-5 w-5 text-primary-500" />
          Find Leads
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Scan an area for businesses with no website or a weak one, and get
          them in your CRM with a ready-to-send pitch.
        </p>
      </div>

      {!placesConfigured && (
        <div className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>
            <span className="font-semibold">GOOGLE_PLACES_API_KEY is not set</span>{" "}
            — scans can only find businesses that already have (weak) websites.
            Add the key to also discover businesses with <em>no</em> website at
            all (those are invisible to web search).
          </span>
        </div>
      )}

      <Launcher pipelines={pipelines} configured={configured} />

      <SchedulesCard schedules={schedules} />

      {scans.length > 0 && (
        <ScanList scans={scans} selectedId={selectedId} />
      )}

      {selected && (
        <ScanResults
          scan={selected}
          candidates={candidates}
          smsConfigured={smsConfigured}
          emailConfigured={emailConfigured}
        />
      )}
    </div>
  );
}

// ---- launcher -----------------------------------------------------------------

function Launcher({
  pipelines,
  configured,
}: {
  pipelines: PipelineOption[];
  configured: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [country, setCountry] = React.useState("Sri Lanka");
  const [city, setCity] = React.useState("Colombo");
  const [cats, setCats] = React.useState<string[]>(["Restaurants", "Salons & spas"]);
  const [maxResults, setMaxResults] = React.useState(40);
  const [minScore, setMinScore] = React.useState(60);
  const [pipelineId, setPipelineId] = React.useState(pipelines[0]?.id ?? "");
  const [stageId, setStageId] = React.useState(pipelines[0]?.stages[0]?.id ?? "");
  const [fireAutomations, setFireAutomations] = React.useState(false);

  const stages = pipelines.find((p) => p.id === pipelineId)?.stages ?? [];

  function toggleCat(c: string) {
    setCats((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  }

  function launch() {
    if (!configured) {
      toast.error(
        "Add GOOGLE_PLACES_API_KEY and FIRECRAWL_API_KEY to .env.local first.",
      );
      return;
    }
    if (!city.trim()) {
      toast.error("Pick a city or area.");
      return;
    }
    if (!cats.length) {
      toast.error("Pick at least one business category.");
      return;
    }
    startTransition(async () => {
      const res = await startProspectScan({
        country,
        city: city.trim(),
        categories: cats,
        max_results: maxResults,
        min_score: minScore,
        fire_automations: fireAutomations,
        pipeline_id: pipelineId || null,
        stage_id: stageId || null,
      });
      if (res.ok) {
        toast.success("Scan started — leads will appear as they're found.");
        router.push(`/crm/prospecting?scan=${res.id}`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Country">
          <Select value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="City / area">
          <Input
            list="prospect-cities"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Colombo"
          />
          {country === "Sri Lanka" && (
            <datalist id="prospect-cities">
              {SL_CITIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          )}
        </Field>
        <Field label="How many businesses">
          <Select
            value={maxResults}
            onChange={(e) => setMaxResults(Number(e.target.value))}
          >
            <option value={20}>Up to 20</option>
            <option value={40}>Up to 40</option>
            <option value={60}>Up to 60</option>
            <option value={100}>Up to 100</option>
          </Select>
        </Field>
        <Field
          label="Lead strictness"
          hint="How bad a website must be to count as a lead."
        >
          <Select
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
          >
            <option value={50}>Strict — only clearly bad sites</option>
            <option value={60}>Balanced (recommended)</option>
            <option value={70}>Aggressive — mediocre sites too</option>
          </Select>
        </Field>
      </div>

      <Field label={`Business types · ${cats.length} selected`} className="mt-4">
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => {
            const active = cats.includes(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => toggleCat(c)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition",
                  active
                    ? "border-primary-300 bg-primary-50 text-primary-700 ring-1 ring-primary-100"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50",
                )}
              >
                {c}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        {pipelines.length > 0 && (
          <>
            <Field label="Add leads to" className="w-44">
              <Select
                value={pipelineId}
                onChange={(e) => {
                  setPipelineId(e.target.value);
                  setStageId(
                    pipelines.find((p) => p.id === e.target.value)?.stages[0]?.id ??
                      "",
                  );
                }}
              >
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Stage" className="w-40">
              <Select value={stageId} onChange={(e) => setStageId(e.target.value)}>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        <label className="mb-2.5 inline-flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={fireAutomations}
            onChange={(e) => setFireAutomations(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-200"
          />
          Run new-lead automations on imported leads
        </label>
        <div className="ml-auto">
          <Button onClick={launch} loading={pending}>
            <Radar className="h-4 w-4" /> Find leads
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- scan history ---------------------------------------------------------------

function ScanList({
  scans,
  selectedId,
}: {
  scans: ProspectScan[];
  selectedId: string | null;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-wrap gap-2">
      {scans.map((s) => {
        const meta = STATUS_META[s.status];
        const active = s.id === selectedId;
        return (
          <button
            key={s.id}
            onClick={() => router.push(`/crm/prospecting?scan=${s.id}`)}
            className={cn(
              "flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition",
              active
                ? "border-primary-300 bg-primary-50/60 ring-1 ring-primary-100"
                : "border-slate-200 bg-white hover:bg-slate-50",
            )}
          >
            <MapPin className="h-3.5 w-3.5 text-slate-400" />
            <span className="font-medium text-slate-800">{s.city}</span>
            <Badge className={meta.badge}>{meta.label}</Badge>
            <span className="text-xs text-slate-400">
              {formatDistanceToNow(new Date(s.created_at), { addSuffix: true })}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---- results --------------------------------------------------------------------

function ScanResults({
  scan,
  candidates,
  smsConfigured,
  emailConfigured,
}: {
  scan: ProspectScan;
  candidates: ProspectCandidate[];
  smsConfigured: boolean;
  emailConfigured: boolean;
}) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmRecheck, setConfirmRecheck] = React.useState(false);
  const [recheckPending, startRecheck] = React.useTransition();
  const [showSkipped, setShowSkipped] = React.useState(false);
  const running = IN_PROGRESS.includes(scan.status);
  const phaseIndex = PHASES.findIndex((p) => p.key === scan.status);

  // Every verdict that came from a scrape/search and could therefore be wrong.
  const recheckableCount = candidates.filter((c) =>
    ["no_website", "facebook_only", "bad_website", "broken", "good_website", "unverified"].includes(
      c.website_verdict,
    ),
  ).length;

  function recheckAll() {
    startRecheck(async () => {
      const res = await recheckScanAll(scan.id);
      if (res.ok) {
        toast.success(
          `Re-checking ${res.queued} businesses — verdicts update live as each finishes.`,
        );
        setConfirmRecheck(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  const qualified = candidates.filter((c) =>
    ["qualified", "imported", "emailed"].includes(c.status),
  );
  const skipped = candidates.filter((c) => c.status === "skipped");

  return (
    <div className="space-y-4">
      {/* Header + progress */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {scan.city}, {scan.country}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {scan.categories.join(" · ") || "All businesses"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={STATUS_META[scan.status].badge}>
              {STATUS_META[scan.status].label}
            </Badge>
            {!running && recheckableCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmRecheck(true)}
                disabled={recheckPending}
              >
                <RefreshCw
                  className={cn("h-3.5 w-3.5", recheckPending && "animate-spin")}
                />
                Re-check all ({recheckableCount})
              </Button>
            )}
            <button
              onClick={() => setConfirmDelete(true)}
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-500"
              aria-label="Delete scan"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {running && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              {PHASES.map((p, i) => (
                <span
                  key={p.key}
                  className={cn(
                    i <= phaseIndex && "text-primary-600 font-semibold",
                  )}
                >
                  {p.label}
                </span>
              ))}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary-400 to-primary-600 transition-all duration-700"
                style={{
                  width: `${Math.max(8, ((phaseIndex + 1) / (PHASES.length + 1)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {scan.status === "error" && scan.error && (
          <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {scan.error}
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Businesses found", value: scan.found },
            { label: "Leads qualified", value: scan.qualified },
            { label: "Skipped", value: scan.skipped },
            { label: "Added to CRM", value: scan.imported },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5"
            >
              <p className="text-lg font-bold tabular-nums text-slate-800">
                {s.value}
              </p>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {s.label}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Qualified leads */}
      {qualified.length === 0 && !running ? (
        <EmptyState
          icon={<Radar className="h-6 w-6" />}
          title="No leads qualified in this scan"
          description="Every business found either has a decent website or wasn't a fit. Try more categories, a wider area, or the Aggressive strictness."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {qualified.map((c) => (
            <CandidateCard
              key={c.id}
              candidate={c}
              smsConfigured={smsConfigured}
              emailConfigured={emailConfigured}
            />
          ))}
        </div>
      )}

      {/* Skipped, collapsed — transparency into what was filtered and why */}
      {skipped.length > 0 && (
        <div className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <button
            onClick={() => setShowSkipped((v) => !v)}
            className="flex w-full items-center justify-between px-5 py-3.5 text-sm font-medium text-slate-600"
          >
            <span>Skipped businesses ({skipped.length})</span>
            <ChevronDown
              className={cn("h-4 w-4 transition-transform", showSkipped && "rotate-180")}
            />
          </button>
          {showSkipped && (
            <div className="space-y-1.5 border-t border-slate-100 px-5 py-3">
              {skipped.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-slate-700">{c.name}</span>
                  <Badge className={VERDICT_META[c.website_verdict]?.badge ?? ""}>
                    {VERDICT_META[c.website_verdict]?.label ?? c.website_verdict}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                    {c.reason}
                  </span>
                  {/* Scrape-dependent verdicts can be wrong — allow a re-run.
                      Duplicates and deny-list exclusions aren't scrape calls. */}
                  {["good_website", "unverified", "broken", "bad_website"].includes(
                    c.website_verdict,
                  ) && <RecheckButton candidateId={c.id} compact />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRecheck}
        onClose={() => setConfirmRecheck(false)}
        title={`Re-check ${recheckableCount} businesses?`}
        description="Every website verdict is re-verified with a fresh scrape plus a direct visit. Changed verdicts get new pitches, notes on their leads, and newly-qualified businesses are imported. Runs in the background — verdicts update live."
        confirmLabel="Re-check all"
        destructive={false}
        onConfirm={recheckAll}
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this scan?"
        description="The scan and its prospect list are removed. Leads already added to the CRM stay."
        onConfirm={async () => {
          const res = await deleteProspectScan(scan.id);
          if (res.ok) {
            toast.success("Scan deleted");
            router.push("/crm/prospecting");
            router.refresh();
          } else {
            toast.error(res.error);
          }
        }}
      />
    </div>
  );
}

// ---- re-check ----------------------------------------------------------------------

/**
 * Re-runs the full verification ladder for one prospect (fresh scrape with
 * retry + direct HTTP probe) — the one-click fix for a doubted verdict.
 */
function RecheckButton({
  candidateId,
  compact = false,
}: {
  candidateId: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [checking, startChecking] = React.useTransition();

  function run() {
    startChecking(async () => {
      const res = await recheckProspect(candidateId);
      if (res.ok) {
        const label = VERDICT_META[res.verdict]?.label ?? res.verdict;
        toast.success(`Re-checked — verdict: ${label}`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  if (compact) {
    return (
      <button
        onClick={run}
        disabled={checking}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
        title="Re-check this business"
        aria-label="Re-check this business"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />
      </button>
    );
  }
  return (
    <Button size="sm" variant="outline" onClick={run} disabled={checking}>
      <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />
      {checking ? "Checking…" : "Re-check"}
    </Button>
  );
}

// ---- candidate card ---------------------------------------------------------------

function CandidateCard({
  candidate: c,
  smsConfigured,
  emailConfigured,
}: {
  candidate: ProspectCandidate;
  smsConfigured: boolean;
  emailConfigured: boolean;
}) {
  const router = useRouter();
  const [showDraft, setShowDraft] = React.useState(false);
  const [sending, startSending] = React.useTransition();
  const verdict = VERDICT_META[c.website_verdict] ?? VERDICT_META.pending;
  const email = c.emails[0];

  function sendEmail() {
    startSending(async () => {
      const res = await sendProspectEmail(c.id);
      if (res.ok) {
        toast.success(`Email sent to ${c.name}`);
        setShowDraft(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function sendSmsNow() {
    startSending(async () => {
      const res = await sendProspectSms(c.id);
      if (res.ok) {
        toast.success(`SMS sent to ${c.name}`);
        setShowDraft(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="flex flex-col rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{c.name}</p>
          <p className="mt-0.5 text-xs text-slate-400">
            {c.category}
            {c.rating ? (
              <span className="ml-2 inline-flex items-center gap-0.5 text-amber-600">
                <Star className="h-3 w-3 fill-current" />
                {c.rating} ({c.rating_count})
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge className={verdict.badge}>{verdict.label}</Badge>
          {c.score !== null && (
            <Badge className="bg-slate-100 text-slate-600 ring-slate-200">
              {c.score}/100
            </Badge>
          )}
          {c.status === "emailed" && (
            <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
              Contacted
            </Badge>
          )}
        </div>
      </div>

      {c.issues.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {c.issues.slice(0, 3).map((issue, i) => (
            <li key={i} className="flex gap-1.5 text-xs text-slate-500">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-orange-400" />
              {issue}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        {c.website && (
          <a
            href={c.website}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary-600 hover:underline"
          >
            <Globe className="h-3 w-3" />
            {c.website.replace(/^https?:\/\/(www\.)?/, "").slice(0, 30)}
          </a>
        )}
        {email && (
          <span className="inline-flex items-center gap-1">
            <Mail className="h-3 w-3" /> {email}
          </span>
        )}
        {c.phone && (
          <span className="inline-flex items-center gap-1">
            <Phone className="h-3 w-3" /> {c.phone}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
        <Button size="sm" variant="secondary" onClick={() => setShowDraft(true)}>
          <Mail className="h-3.5 w-3.5" /> View pitch
        </Button>
        {c.lead_id && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => router.push(`/crm/lead/${c.lead_id}`)}
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open lead
          </Button>
        )}
        <RecheckButton candidateId={c.id} />
      </div>

      <Modal
        open={showDraft}
        onClose={() => setShowDraft(false)}
        title={`Pitch for ${c.name}`}
        description={c.draft_subject || undefined}
        size="lg"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setShowDraft(false)}
              disabled={sending}
            >
              Close
            </Button>
            {c.draft_sms && (
              <Button
                variant="secondary"
                onClick={sendSmsNow}
                loading={sending}
                disabled={!smsConfigured || !c.phone}
                title={
                  !c.phone
                    ? "No phone number found"
                    : !smsConfigured
                      ? "Notify.lk keys not configured"
                      : undefined
                }
              >
                <MessageSquareText className="h-4 w-4" /> Send SMS
              </Button>
            )}
            <Button
              onClick={sendEmail}
              loading={sending}
              disabled={!emailConfigured || !email || !c.draft_body}
              title={
                !email
                  ? "No email address found"
                  : !emailConfigured
                    ? "RESEND_API_KEY not configured"
                    : undefined
              }
            >
              <Send className="h-4 w-4" /> Send email{email ? ` to ${email}` : ""}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {c.draft_body ? (
            <div className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-700">
              {c.draft_body}
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              The pitch is still being written — check back in a moment.
            </p>
          )}
          {c.draft_sms && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                SMS version
              </p>
              <div className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                {c.draft_sms}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
