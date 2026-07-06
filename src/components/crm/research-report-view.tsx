"use client";

import * as React from "react";
import {
  BadgeCheck,
  Building2,
  ExternalLink,
  Globe,
  Link2,
  Lightbulb,
  MessageCircleQuestion,
  Newspaper,
  ShieldAlert,
  Swords,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  parseResearchReport,
  parseResearchSources,
  type MatchConfidence,
} from "@/lib/research-report";
import type { LeadResearch } from "@/lib/types";

/** Section heading with icon, matching the lead-detail card headings. */
function SectionTitle({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-400">{icon}</span>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {children}
      </h4>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-slate-700">{value}</dd>
    </div>
  );
}

/**
 * Tells the rep, up front, whether we're confident this report is about the
 * right company. A "low" match is a prominent warning to add/verify the
 * website; high/medium is a quiet reassuring line.
 */
function ConfidenceBanner({
  confidence,
  verification,
}: {
  confidence: MatchConfidence;
  verification: string;
}) {
  if (!confidence) return null;

  if (confidence === "low") {
    return (
      <div className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="text-sm text-amber-800">
          <span className="font-semibold">May be the wrong company.</span>{" "}
          {verification ||
            "Couldn't confirm this is the intended business — add or fix the company website on the lead, then re-run."}
        </div>
      </div>
    );
  }

  const isHigh = confidence === "high";
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs",
        isHigh ? "text-emerald-600" : "text-slate-500",
      )}
      title={verification || undefined}
    >
      <BadgeCheck
        className={cn("h-3.5 w-3.5", isHigh ? "text-emerald-500" : "text-slate-400")}
      />
      <span className="font-medium">
        {isHigh ? "Identity confirmed" : "Likely match"}
      </span>
      {verification && (
        <span className="truncate text-slate-400">· {verification}</span>
      )}
    </div>
  );
}

/**
 * Renders a stored `lead_research` report. Presentational and reusable
 * across the lead-detail side card and the standalone research page.
 * `compact` tightens spacing for the narrow side column.
 */
export function ResearchReportView({
  research,
  compact = false,
}: {
  research: LeadResearch;
  compact?: boolean;
}) {
  const report = React.useMemo(
    () => parseResearchReport(research.report),
    [research.report],
  );
  const sources = React.useMemo(
    () => parseResearchSources(research.sources),
    [research.sources],
  );

  const website = report.website;
  const linkedin = report.linkedin_url;

  return (
    <div className={cn("space-y-4", compact && "space-y-3.5")}>
      {/* Identity confidence — is this even the right company? */}
      <ConfidenceBanner
        confidence={report.match_confidence}
        verification={report.verification}
      />

      {/* Quick links + provenance */}
      <div className="flex flex-wrap items-center gap-2">
        {website && (
          <a
            href={website}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
          >
            <Globe className="h-3.5 w-3.5" />
            Website
            <ExternalLink className="h-3 w-3 text-slate-400" />
          </a>
        )}
        {linkedin && (
          <a
            href={linkedin}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#0a66c2]/20 bg-[#0a66c2]/5 px-2.5 py-1 text-xs font-medium text-[#0a66c2] transition hover:bg-[#0a66c2]/10"
          >
            <Link2 className="h-3.5 w-3.5" />
            LinkedIn
            <ExternalLink className="h-3 w-3 opacity-60" />
          </a>
        )}
        {report.generated_by === "basic" && (
          <Badge className="block max-w-full whitespace-normal bg-amber-50 text-amber-700 ring-amber-200">
            Basic report — add an OpenAI key for full analysis
          </Badge>
        )}
      </div>

      {/* Overview */}
      {report.overview && (
        <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">
          {report.overview}
        </p>
      )}

      {/* Fact grid */}
      {(report.industry ||
        report.headquarters ||
        report.company_size ||
        report.founded) && (
        <dl
          className={cn(
            "grid gap-3 rounded-xl bg-slate-50 p-3",
            compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4",
          )}
        >
          <Fact label="Industry" value={report.industry} />
          <Fact label="HQ" value={report.headquarters} />
          <Fact label="Size" value={report.company_size} />
          <Fact label="Founded" value={report.founded} />
        </dl>
      )}

      {/* Products / services */}
      {report.products_services.length > 0 && (
        <div>
          <SectionTitle icon={<Building2 className="h-3.5 w-3.5" />}>
            Products &amp; services
          </SectionTitle>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {report.products_services.map((p, i) => (
              <span
                key={i}
                className="rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-600"
              >
                {p}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Competitors */}
      {report.competitors.length > 0 && (
        <div>
          <SectionTitle icon={<Swords className="h-3.5 w-3.5" />}>
            Competitors
          </SectionTitle>
          <ul className="mt-2 space-y-1.5">
            {report.competitors.map((c, i) => (
              <li key={i} className="break-words text-sm text-slate-700">
                <span className="font-medium text-slate-900">{c.name}</span>
                {c.note && <span className="text-slate-500"> — {c.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recent news */}
      {report.recent_news.length > 0 && (
        <div>
          <SectionTitle icon={<Newspaper className="h-3.5 w-3.5" />}>
            Recent news
          </SectionTitle>
          <ul className="mt-2 space-y-2">
            {report.recent_news.map((n, i) => (
              <li key={i} className="text-sm">
                {n.url ? (
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-words font-medium text-slate-900 underline-offset-2 hover:underline"
                  >
                    {n.title}
                  </a>
                ) : (
                  <span className="break-words font-medium text-slate-900">{n.title}</span>
                )}
                {n.summary && (
                  <p className="break-words text-slate-500">{n.summary}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Pain points */}
      {report.pain_points.length > 0 && (
        <div>
          <SectionTitle icon={<TriangleAlert className="h-3.5 w-3.5" />}>
            Likely pain points
          </SectionTitle>
          <ul className="mt-2 space-y-1">
            {report.pain_points.map((p, i) => (
              <li
                key={i}
                className="flex gap-2 text-sm text-slate-700"
              >
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" />
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Talking points — the sales gold, highlighted */}
      {report.talking_points.length > 0 && (
        <div className="rounded-xl border border-primary-100 bg-primary-50/50 p-3">
          <SectionTitle icon={<Lightbulb className="h-3.5 w-3.5 text-primary-500" />}>
            <span className="text-primary-600">Talking points</span>
          </SectionTitle>
          <ul className="mt-2 space-y-1.5">
            {report.talking_points.map((t, i) => (
              <li key={i} className="flex gap-2 text-sm text-slate-700">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary-400" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Discovery questions */}
      {report.discovery_questions.length > 0 && (
        <div>
          <SectionTitle
            icon={<MessageCircleQuestion className="h-3.5 w-3.5" />}
          >
            Discovery questions
          </SectionTitle>
          <ul className="mt-2 space-y-1.5">
            {report.discovery_questions.map((q, i) => (
              <li key={i} className="flex gap-2 text-sm text-slate-700">
                <span className="font-semibold text-slate-300">{i + 1}.</span>
                {q}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sources */}
      {sources.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-wider text-slate-400 transition hover:text-slate-600">
            {sources.length} source{sources.length === 1 ? "" : "s"}
            <span className="ml-1 text-slate-300 group-open:hidden">▸</span>
            <span className="ml-1 hidden text-slate-300 group-open:inline">▾</span>
          </summary>
          <ul className="mt-2 space-y-1">
            {sources.map((s, i) => (
              <li key={i} className="truncate">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-slate-500 underline-offset-2 hover:text-primary-600 hover:underline"
                  title={s.url}
                >
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
