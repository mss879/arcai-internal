"use client";

import * as React from "react";
import {
  BadgeCheck,
  Building2,
  Clock,
  Download,
  ExternalLink,
  Gauge,
  Globe,
  LayoutGrid,
  Link2,
  Lightbulb,
  Loader2,
  Mail,
  MapPin,
  MessageCircleQuestion,
  Newspaper,
  Palette,
  Phone,
  Server,
  Share2,
  ShieldAlert,
  Star,
  Swords,
  TrendingUp,
  TriangleAlert,
  Type,
  Users,
  Wrench,
} from "lucide-react";

import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  parseResearchReport,
  parseResearchSources,
  type MatchConfidence,
  type ResearchReport,
} from "@/lib/research-report";
import {
  grabLeadBranding,
  runLeadWebsiteAudit,
} from "@/app/(app)/crm/research/actions";
import type { LeadResearch } from "@/lib/types";

/**
 * Explain WHY a report is basic. Only a truly missing key should tell the user
 * to add one — a present-but-rejected key, an unavailable model, or a timeout
 * gets the real reason so they fix the right thing.
 */
function basicReportMessage(reason: string): string {
  if (!reason || reason === "no_key")
    return "Basic report — add an OpenAI key for full analysis";
  if (reason === "no_context")
    return "Basic report — not enough website content was found to analyze";
  return `AI analysis failed — ${reason}. Re-run to try again.`;
}

/**
 * An empty-state card with a button that fetches an on-demand section (branding
 * / website audit) and attaches it to the report. Kept out of the initial pass
 * so the first report stays fast + focused on the company; the result lands via
 * realtime sync + router.refresh once the action commits.
 */
function OnDemandCard({
  icon,
  title,
  description,
  cta,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  cta: string;
  action: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const [pending, startTransition] = React.useTransition();
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-3">
      <SectionTitle icon={icon}>{title}</SectionTitle>
      <p className="mt-1.5 text-xs text-slate-500">{description}</p>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await action();
            if (!res.ok) toast.error(res.error ?? "Something went wrong.");
          })
        }
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
        {pending ? "Working…" : cta}
      </button>
    </div>
  );
}

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
 * Readable-contrast text colour for a swatch. Handles the same colour shapes
 * the report coercer admits: #rgb / #rrggbb / #rrggbbaa and rgb()/rgba().
 */
function readableOn(color: string): string {
  let r: number;
  let g: number;
  let b: number;
  let code = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color)?.[1] ?? "";
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color);
  if (code) {
    if (code.length === 3) code = code.replace(/(.)/g, "$1$1"); // #abc → aabbcc
    if (code.length === 8) code = code.slice(0, 6); // drop alpha
    r = parseInt(code.slice(0, 2), 16);
    g = parseInt(code.slice(2, 4), 16);
    b = parseInt(code.slice(4, 6), 16);
  } else if (rgb) {
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  } else {
    return "#0f172a";
  }
  // Perceived luminance → pick dark or light text.
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0f172a" : "#ffffff";
}

/** The prospect's visual brand — colour swatches, fonts, logo, personality. */
function BrandSection({
  brand,
  researchId,
}: {
  brand: ResearchReport["brand"];
  researchId: string;
}) {
  const has =
    brand.colors.length > 0 ||
    brand.fonts.length > 0 ||
    brand.logo ||
    brand.style_notes;
  if (!has)
    return (
      <OnDemandCard
        icon={<Palette className="h-3.5 w-3.5" />}
        title="Brand system"
        description="Pull the site's colours, fonts, logo and design personality."
        cta="Grab branding"
        action={() => grabLeadBranding(researchId)}
      />
    );

  return (
    <div className="rounded-xl border border-slate-200/80 bg-white p-3">
      <SectionTitle icon={<Palette className="h-3.5 w-3.5" />}>
        Brand system
      </SectionTitle>

      {brand.colors.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {brand.colors.map((c, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-1.5 py-1"
              title={`${c.name}: ${c.hex}`}
            >
              <span
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[9px] font-bold uppercase"
                style={{ backgroundColor: c.hex, color: readableOn(c.hex) }}
              >
                {c.name.slice(0, 1)}
              </span>
              <span className="font-mono text-[11px] text-slate-500">{c.hex}</span>
            </div>
          ))}
        </div>
      )}

      <dl className="mt-2.5 space-y-1.5 text-sm">
        {brand.fonts.length > 0 && (
          <div className="flex gap-2">
            <dt className="flex shrink-0 items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              <Type className="h-3 w-3" /> Fonts
            </dt>
            <dd className="min-w-0 break-words text-slate-700">
              {brand.fonts.join(", ")}
            </dd>
          </div>
        )}
        {brand.spacing && (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Spacing
            </dt>
            <dd className="min-w-0 break-words text-slate-700">{brand.spacing}</dd>
          </div>
        )}
        {brand.logo && (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Logo
            </dt>
            <dd className="min-w-0">
              <div className="inline-flex flex-col items-start gap-1">
                <div className="grid place-items-center rounded-lg border border-slate-200 bg-[repeating-conic-gradient(#f1f5f9_0%_25%,#fff_0%_50%)] bg-[length:12px_12px] p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={brand.logo}
                    alt="Company logo"
                    className="max-h-16 max-w-[180px] object-contain"
                  />
                </div>
                <a
                  href={brand.logo}
                  download
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-primary-600 hover:underline"
                >
                  <Download className="h-3 w-3" /> Download logo
                </a>
              </div>
            </dd>
          </div>
        )}
      </dl>

      {brand.style_notes && (
        <p className="mt-2 break-words text-sm text-slate-600">{brand.style_notes}</p>
      )}
    </div>
  );
}

/** The prospect's web presence — pages, CTAs, and the agency's gap list. */
function WebPresenceSection({
  web,
}: {
  web: ResearchReport["web_presence"];
}) {
  const has =
    web.pages.length > 0 ||
    web.ctas.length > 0 ||
    web.gaps.length > 0 ||
    web.notes;
  if (!has) return null;

  return (
    <div>
      <SectionTitle icon={<LayoutGrid className="h-3.5 w-3.5" />}>
        Web presence
      </SectionTitle>
      {web.notes && (
        <p className="mt-2 break-words text-sm text-slate-600">{web.notes}</p>
      )}
      {web.pages.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {web.pages.map((p, i) => (
            <span
              key={i}
              className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
            >
              {p}
            </span>
          ))}
        </div>
      )}
      {web.ctas.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          <span className="font-semibold text-slate-600">CTAs:</span>{" "}
          {web.ctas.join(" · ")}
        </p>
      )}
      {web.gaps.length > 0 && (
        <ul className="mt-2 space-y-1">
          {web.gaps.map((g, i) => (
            <li key={i} className="flex gap-2 break-words text-sm text-slate-700">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-rose-300" />
              {g}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Traffic-light colour for a 0-100 score. */
function scoreTone(score: number): { text: string; bar: string; ring: string } {
  if (score >= 80)
    return {
      text: "text-emerald-600",
      bar: "bg-emerald-500",
      ring: "border-emerald-200 bg-emerald-50",
    };
  if (score >= 50)
    return {
      text: "text-amber-600",
      bar: "bg-amber-500",
      ring: "border-amber-200 bg-amber-50",
    };
  return {
    text: "text-rose-600",
    bar: "bg-rose-500",
    ring: "border-rose-200 bg-rose-50",
  };
}

/**
 * The website scorecard — an overall 0-100, labelled sub-scores, the domain
 * facts, and the concrete "what we'd fix" list. This is the agency's pitch.
 */
function ScorecardSection({
  audit,
  domain,
  researchId,
}: {
  audit: ResearchReport["audit"];
  domain: ResearchReport["domain_info"];
  researchId: string;
}) {
  // Audit + domain facts are fetched together on demand; show the button until
  // they exist.
  if (!audit)
    return (
      <OnDemandCard
        icon={<Gauge className="h-3.5 w-3.5" />}
        title="Website scorecard"
        description="Run a mobile performance + SEO + domain audit — the agency's pitch fuel."
        cta="Run website audit"
        action={() => runLeadWebsiteAudit(researchId)}
      />
    );

  return (
    <div className="rounded-xl border border-slate-200/80 bg-white p-3">
      <SectionTitle icon={<Gauge className="h-3.5 w-3.5" />}>
        Website scorecard
      </SectionTitle>

      {audit && (
        <>
          <div className="mt-2 flex items-center gap-3">
            <div
              className={cn(
                "grid h-14 w-14 shrink-0 place-items-center rounded-xl border text-lg font-bold",
                scoreTone(audit.overall).ring,
                scoreTone(audit.overall).text,
              )}
            >
              {audit.overall}
            </div>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-800">
                {audit.overall >= 85
                  ? "Strong"
                  : audit.overall >= 70
                    ? "Decent"
                    : audit.overall >= 50
                      ? "Needs work"
                      : "Big opportunity"}
                {audit.measured === "limited" && (
                  <span
                    className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                    title="Google PageSpeed didn't run, so performance & accessibility weren't measured — the score is capped."
                  >
                    Limited audit
                  </span>
                )}
              </p>
              {audit.measured_url && (
                <a
                  href={audit.measured_url}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-xs text-slate-400 hover:underline"
                >
                  {audit.measured_url}
                </a>
              )}
            </div>
          </div>

          {audit.scores.length > 0 && (
            <div className="mt-3 space-y-2">
              {audit.scores.map((s, i) => (
                <div key={i}>
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-600">{s.label}</span>
                    <span className={cn("font-semibold", scoreTone(s.score).text)}>
                      {s.score}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={cn("h-full rounded-full", scoreTone(s.score).bar)}
                      style={{ width: `${s.score}%` }}
                    />
                  </div>
                  {s.note && (
                    <p className="mt-0.5 text-[11px] text-slate-400">{s.note}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {audit.metrics.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {audit.metrics.map((m, i) => (
                <span
                  key={i}
                  className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
                >
                  {m.label}: <span className="font-medium text-slate-700">{m.value}</span>
                </span>
              ))}
            </div>
          )}

          {audit.issues.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                <Wrench className="h-3 w-3" /> What we&apos;d fix
              </div>
              <ul className="mt-1.5 space-y-1">
                {audit.issues.map((g, i) => (
                  <li
                    key={i}
                    className="flex gap-2 break-words text-sm text-slate-700"
                  >
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-400" />
                    {g}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {domain && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">
          {domain.registered && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3 text-slate-400" />
              Registered {domain.registered}
              {domain.age_years > 0 && ` · ${domain.age_years} yr`}
            </span>
          )}
          {domain.registrar && (
            <span className="truncate">{domain.registrar}</span>
          )}
          {domain.hosting && (
            <span className="inline-flex items-center gap-1">
              <Server className="h-3 w-3 text-slate-400" />
              {domain.hosting}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1 font-medium",
              domain.ssl ? "text-emerald-600" : "text-rose-600",
            )}
          >
            {domain.ssl ? "HTTPS" : "No HTTPS"}
          </span>
        </div>
      )}
    </div>
  );
}

/** Google/online reputation — rating, review count, and the recurring themes. */
function ReputationSection({
  reputation,
}: {
  reputation: ResearchReport["reputation"];
}) {
  if (!reputation) return null;
  const { rating, reviews, source, summary, positives, negatives } = reputation;

  return (
    <div>
      <SectionTitle icon={<Star className="h-3.5 w-3.5" />}>Reputation</SectionTitle>
      {(rating > 0 || reviews > 0) && (
        <div className="mt-2 flex items-center gap-2">
          {rating > 0 && (
            <span className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-1 text-sm font-semibold text-amber-700">
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
              {rating.toFixed(1)}
            </span>
          )}
          <span className="text-xs text-slate-500">
            {reviews > 0 && `${reviews} reviews`}
            {reviews > 0 && source && " · "}
            {source}
          </span>
        </div>
      )}
      {summary && <p className="mt-2 break-words text-sm text-slate-600">{summary}</p>}
      {(positives.length > 0 || negatives.length > 0) && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {positives.length > 0 && (
            <ul className="space-y-1">
              {positives.map((p, i) => (
                <li key={i} className="flex gap-1.5 break-words text-sm text-slate-700">
                  <span className="text-emerald-500">+</span>
                  {p}
                </li>
              ))}
            </ul>
          )}
          {negatives.length > 0 && (
            <ul className="space-y-1">
              {negatives.map((n, i) => (
                <li key={i} className="flex gap-1.5 break-words text-sm text-slate-700">
                  <span className="text-rose-500">−</span>
                  {n}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Ready-to-use contact channels scraped from the site. */
function ContactSection({ contact }: { contact: ResearchReport["contact"] }) {
  const has =
    contact.emails.length > 0 ||
    contact.phones.length > 0 ||
    contact.whatsapp ||
    contact.address ||
    contact.hours;
  if (!has) return null;

  return (
    <div>
      <SectionTitle icon={<Phone className="h-3.5 w-3.5" />}>Contact</SectionTitle>
      <div className="mt-2 space-y-1.5 text-sm">
        {contact.emails.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            {contact.emails.map((e, i) => (
              <a
                key={i}
                href={`mailto:${e}`}
                className="break-all text-primary-600 hover:underline"
              >
                {e}
              </a>
            ))}
          </div>
        )}
        {contact.phones.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            {contact.phones.map((p, i) => (
              <a
                key={i}
                href={`tel:${p.replace(/\s+/g, "")}`}
                className="text-slate-700 hover:underline"
              >
                {p}
              </a>
            ))}
          </div>
        )}
        {contact.whatsapp && (
          <div className="flex items-center gap-2">
            <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <a
              href={contact.whatsapp}
              target="_blank"
              rel="noreferrer"
              className="text-emerald-700 hover:underline"
            >
              WhatsApp
            </a>
          </div>
        )}
        {contact.address && (
          <div className="flex gap-2">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="break-words text-slate-600">{contact.address}</span>
          </div>
        )}
        {contact.hours && (
          <div className="flex gap-2">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="break-words text-slate-600">{contact.hours}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Decision-makers to reach out to, with LinkedIn links. */
function KeyPeopleSection({ people }: { people: ResearchReport["key_people"] }) {
  if (!people.length) return null;
  return (
    <div>
      <SectionTitle icon={<Users className="h-3.5 w-3.5" />}>
        Key people
      </SectionTitle>
      <ul className="mt-2 space-y-1.5">
        {people.map((p, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            {p.linkedin_url ? (
              <a
                href={p.linkedin_url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-[#0a66c2] hover:underline"
              >
                {p.name}
              </a>
            ) : (
              <span className="font-medium text-slate-900">{p.name}</span>
            )}
            {p.role && <span className="text-slate-500">— {p.role}</span>}
          </li>
        ))}
      </ul>
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
            {basicReportMessage(report.basic_reason)}
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

      {/* Website scorecard — the agency's core pitch fuel */}
      <ScorecardSection
        audit={report.audit}
        domain={report.domain_info}
        researchId={research.id}
      />

      {/* Reputation — Google/online rating + themes */}
      <ReputationSection reputation={report.reputation} />

      {/* Contact + decision-makers — ready-to-use outreach info */}
      <ContactSection contact={report.contact} />
      <KeyPeopleSection people={report.key_people} />

      {/* Brand system — the agency-facing highlight */}
      <BrandSection brand={report.brand} researchId={research.id} />

      {/* Social profiles */}
      {report.social_links.length > 0 && (
        <div>
          <SectionTitle icon={<Share2 className="h-3.5 w-3.5" />}>
            Social profiles
          </SectionTitle>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {report.social_links.map((s, i) => (
              <a
                key={i}
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
              >
                {s.platform}
                <ExternalLink className="h-3 w-3 text-slate-400" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Web presence — pages, CTAs, gaps */}
      <WebPresenceSection web={report.web_presence} />

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
                {c.url ? (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-slate-900 underline-offset-2 hover:underline"
                  >
                    {c.name}
                  </a>
                ) : (
                  <span className="font-medium text-slate-900">{c.name}</span>
                )}
                {c.note && <span className="text-slate-500"> — {c.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Competitor gaps — how rivals are winning (the pitch) */}
      {report.competitor_gaps.length > 0 && (
        <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-3">
          <SectionTitle icon={<TrendingUp className="h-3.5 w-3.5 text-amber-600" />}>
            <span className="text-amber-700">How competitors are winning</span>
          </SectionTitle>
          <ul className="mt-2 space-y-1.5">
            {report.competitor_gaps.map((g, i) => (
              <li key={i} className="flex gap-2 break-words text-sm text-slate-700">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-400" />
                {g}
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
