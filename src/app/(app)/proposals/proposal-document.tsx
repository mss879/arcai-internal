"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import {
  PROPOSAL_COMPANY,
  PROPOSAL_SIGNOFF,
  buildPricing,
  money,
  type ProposalContent,
  type ProposalSelection,
} from "@/lib/proposal";

/**
 * On-screen mirror of the printed proposal, laid out as discrete A4 pages so
 * the user can see exactly what sits on each page. Read-only — editing happens
 * in the form; this updates live. Page numbers match the PDF (cover = page 1,
 * and subsequent content pages contain logically grouped sections to fit perfectly).
 */
export function ProposalDocument({
  clientName,
  projectName,
  displayDate,
  selection,
  content,
}: {
  clientName: string;
  projectName: string;
  displayDate: string;
  selection: ProposalSelection;
  content: ProposalContent;
}) {
  const pricing = buildPricing(selection);

  // 1. Build individual sections as React nodes
  const overviewSec = content.overview ? {
    title: "Overview",
    body: (
      <div className="space-y-2.5 text-[14.5px]">
        {content.overview.split("\n\n").map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    ),
  } : null;

  const objectivesSec = content.objectives.length ? {
    title: "Objectives",
    body: (
      <div className="space-y-4">
        {content.objectives.map((g, i) => (
          <div key={i} className="space-y-1.5">
            <p className="text-[15.5px] font-bold text-neutral-900">{g.group}</p>
            <Bullets items={g.items} />
          </div>
        ))}
      </div>
    ),
  } : null;

  const structSec = content.websiteStructure.length ? {
    title: "Website Structure",
    body: (
      <div className="space-y-3">
        {content.websiteStructure.map((p, i) => (
          <div key={i} className="text-[14.5px]">
            <p className="text-[15.5px] font-bold text-neutral-900">{p.page}</p>
            <p className="mt-0.5 text-neutral-600">{p.description}</p>
          </div>
        ))}
      </div>
    ),
  } : null;

  const featuresSec = content.keyFeatures.length ? {
    title: "Key Features",
    body: (
      <div className="space-y-4">
        {content.keyFeatures.map((f, i) => (
          <div key={i} className="space-y-1.5">
            <p className="text-[15.5px] font-bold text-neutral-900">{f.heading}</p>
            {f.intro && <p className="text-[14.5px] text-neutral-600">{f.intro}</p>}
            <Bullets items={f.bullets} />
          </div>
        ))}
      </div>
    ),
  } : null;

  const eduSec = (content.educational.intro || content.educational.bullets.length || content.educational.aiAgent) ? {
    title: "Educational Strategy",
    body: (
      <div className="space-y-3">
        {content.educational.intro && (
          <p className="text-[14.5px] text-neutral-600">{content.educational.intro}</p>
        )}
        <Bullets items={content.educational.bullets} />
        {content.educational.aiAgent && (
          <div className="pt-2 space-y-1.5">
            <p className="text-[15.5px] font-bold text-neutral-900">
              AI Customer Support Agent
            </p>
            {content.educational.aiAgent.intro && (
              <p className="text-[14.5px] text-neutral-600">{content.educational.aiAgent.intro}</p>
            )}
            <Bullets items={content.educational.aiAgent.capabilities} />
            {content.educational.aiAgent.note && (
              <p className="mt-1 text-[11.5px] text-neutral-500">
                {content.educational.aiAgent.note}
              </p>
            )}
          </div>
        )}
      </div>
    ),
  } : null;

  const seoSec = (content.seo.bullets.length || content.seo.whyDedicated) ? {
    title: "SEO Optimization",
    body: (
      <div className="space-y-3">
        <Bullets items={content.seo.bullets} />
        {content.seo.whyDedicated && (
          <div className="space-y-1">
            <p className="text-[15.5px] font-bold text-neutral-900">
              Why Dedicated Pages Matter
            </p>
            <p className="text-[14.5px] text-neutral-600">{content.seo.whyDedicated}</p>
          </div>
        )}
      </div>
    ),
  } : null;

  const timelineSec = content.timeline.length ? {
    title: "Timeline & Key Dates",
    body: (
      <div className="space-y-3.5">
        {content.timeline.map((s, i) => (
          <div key={i} className="flex gap-4 items-start">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded bg-neutral-900 text-xs font-bold text-white">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div>
              <p className="text-[15.5px] font-bold text-neutral-900">{s.title}</p>
              <p className="text-[14.5px] text-neutral-600">{s.description}</p>
              <p className="text-[10.5px] font-bold uppercase tracking-wide text-neutral-400 mt-0.5">
                {s.duration}
              </p>
            </div>
          </div>
        ))}
      </div>
    ),
  } : null;

  const pricingSec = {
    title: "Investment",
    body: (
      <div>
        <div className="divide-y divide-neutral-200">
          {pricing.lineItems.map((l, i) => (
            <div key={i} className="flex justify-between py-2.5 text-[14.5px]">
              <span>{l.label}</span>
              <span className="font-bold text-neutral-900">{money(l.amount)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-between rounded-lg bg-indigo-50 px-4 py-2.5 text-[15.5px]">
          <span className="font-bold text-indigo-700">ONE-TIME TOTAL</span>
          <span className="font-bold text-indigo-700">
            {money(pricing.oneTimeTotal)}
          </span>
        </div>
        {pricing.recurringNotes.length > 0 && (
          <p className="mt-2.5 text-[11.5px] text-neutral-500">
            Recurring / external: {pricing.recurringNotes.join(" · ")}
          </p>
        )}
      </div>
    ),
  };

  const termsSec = (content.paymentTerms.length || content.hosting.hosting) ? {
    title: "Terms of Payment",
    body: (
      <div className="space-y-3">
        <Bullets items={content.paymentTerms} />
        <div className="space-y-1">
          <p className="text-[15.5px] font-bold text-neutral-900">
            Hosting, Domain &amp; Third-Party Costs
          </p>
          {content.hosting.hosting && <p className="text-[14.5px] text-neutral-600">{content.hosting.hosting}</p>}
          {content.hosting.storage && <p className="text-[14.5px] text-neutral-600">{content.hosting.storage}</p>}
          {content.hosting.domain && <p className="text-[14.5px] text-neutral-600">{content.hosting.domain}</p>}
        </div>
      </div>
    ),
  } : null;

  const maintSec = content.maintenance.length ? {
    title: "Maintenance & Support",
    body: <Bullets items={content.maintenance} />,
  } : null;

  const qualitySec = {
    title: "Quality Standards",
    body: (
      <div className="space-y-4">
        <Bullets items={content.quality.bullets} />
        {content.quality.assumptions.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[15.5px] font-bold text-neutral-900">
              Assumptions &amp; Exclusions
            </p>
            <Bullets items={content.quality.assumptions} />
          </div>
        )}
        {content.quality.nextSteps.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[15.5px] font-bold text-neutral-900">Next Steps</p>
            <Bullets items={content.quality.nextSteps} />
          </div>
        )}
        <div className="pt-2 text-[14.5px]">
          <p className="font-bold text-neutral-900">Prepared by</p>
          <p className="font-bold text-neutral-900">{PROPOSAL_SIGNOFF.preparedBy}</p>
          <p className="text-neutral-500">Email — {PROPOSAL_SIGNOFF.email}</p>
        </div>
      </div>
    ),
  };

  // Group sections logically into distinct pages to optimize space and show exact A4 size
  const pageGroups: { sections: { title: string; body: React.ReactNode }[] }[] = [];

  // Page 2: Overview & Objectives
  const p2Secs = [overviewSec, objectivesSec].filter(Boolean) as { title: string; body: React.ReactNode }[];
  if (p2Secs.length) pageGroups.push({ sections: p2Secs });

  // Page 3: Website Structure & Key Features
  const p3Secs = [structSec, featuresSec].filter(Boolean) as { title: string; body: React.ReactNode }[];
  if (p3Secs.length) pageGroups.push({ sections: p3Secs });

  // Page 4: Educational Strategy & SEO Optimization
  const p4Secs = [eduSec, seoSec].filter(Boolean) as { title: string; body: React.ReactNode }[];
  if (p4Secs.length) pageGroups.push({ sections: p4Secs });

  // Page 5: Timeline & Key Dates
  const p5Secs = [timelineSec].filter(Boolean) as { title: string; body: React.ReactNode }[];
  if (p5Secs.length) pageGroups.push({ sections: p5Secs });

  // Page 6: Investment, Terms of Payment & Maintenance Support
  const p6Secs = [pricingSec, termsSec, maintSec].filter(Boolean) as { title: string; body: React.ReactNode }[];
  if (p6Secs.length) pageGroups.push({ sections: p6Secs });

  // Page 7: Quality Standards
  const p7Secs = [qualitySec].filter(Boolean) as { title: string; body: React.ReactNode }[];
  if (p7Secs.length) pageGroups.push({ sections: p7Secs });

  // Sequential numbering based on all visible sections
  const allActiveSections = pageGroups.flatMap(pg => pg.sections);
  const getSectionNumber = (title: string) => {
    const idx = allActiveSections.findIndex(s => s.title === title);
    return idx !== -1 ? idx + 1 : 1;
  };

  return (
    <div className="space-y-7">
      {/* Page 1 — Cover */}
      <PageSheet pageNo={1}>
        <div
          className="relative flex h-full min-h-[1123px] flex-col justify-between px-12 py-14 text-white"
          style={{
            backgroundImage:
              "linear-gradient(115deg, #05060f 0%, #0b1437 45%, #2f2fc0 100%)",
          }}
        >
          <div className="flex items-start justify-between">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/new-logo.png"
              alt="ARC AI"
              className="h-12 w-auto object-contain"
            />
            <div className="text-right">
              <p className="text-[10px] font-bold tracking-widest text-teal-300">
                CLIENT NAME
              </p>
              <p className="mb-2 font-bold">{clientName || "—"}</p>
              <p className="text-[10px] font-bold tracking-widest text-teal-300">
                PROJECT NAME
              </p>
              <p className="font-bold">{projectName || "—"}</p>
            </div>
          </div>

          <div>
            <h1 className="text-7xl font-black leading-none">Project</h1>
            <h1 className="text-7xl font-black leading-none">Proposal</h1>
            <p className="mt-4 text-slate-300">{displayDate}</p>
          </div>

          <div className="flex gap-8 text-[11px]">
            <div>
              <p className="mb-1 font-bold tracking-widest text-teal-300">ADDRESS</p>
              {PROPOSAL_COMPANY.addressLines.map((l) => (
                <p key={l} className="text-slate-200">
                  {l}
                </p>
              ))}
            </div>
            <div>
              <p className="mb-1 font-bold tracking-widest text-teal-300">PHONE</p>
              <p className="text-slate-200">{PROPOSAL_COMPANY.phones}</p>
            </div>
            <div>
              <p className="mb-1 font-bold tracking-widest text-teal-300">WEB</p>
              <p className="text-slate-200">{PROPOSAL_COMPANY.email}</p>
              <p className="text-slate-200">{PROPOSAL_COMPANY.website}</p>
            </div>
          </div>
        </div>
      </PageSheet>

      {/* Pages mapped to logically grouped sheets */}
      {pageGroups.map((page, i) => (
        <PageSheet key={i} pageNo={i + 2}>
          <div className="relative min-h-[1123px] bg-white px-12 pb-28 pt-16 text-[15px] leading-relaxed text-neutral-700">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/proposal/shield.png"
              alt=""
              className="absolute right-8 top-6 h-12 w-12 object-contain"
            />
            <div className="space-y-8">
              {page.sections.map((s, j) => (
                <div key={j} className="group/section">
                  <div className="flex items-end gap-2">
                    <span className="text-[28px] font-black leading-none text-neutral-300">
                      {String(getSectionNumber(s.title)).padStart(2, "0")}
                    </span>
                    <h2 className="text-2xl font-bold leading-none text-neutral-900">{s.title}</h2>
                  </div>
                  <div className="my-3 border-b border-neutral-200" />
                  {s.body}
                </div>
              ))}
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/proposal/footer-band.png"
              alt=""
              className="absolute bottom-0 left-0 w-full"
            />
          </div>
        </PageSheet>
      ))}
    </div>
  );
}

function PageSheet({
  pageNo,
  children,
}: {
  pageNo: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-center gap-2">
        <span className="h-px w-8 bg-slate-200" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Page {pageNo}
        </span>
        <span className="h-px w-8 bg-slate-200" />
      </div>
      <div
        className={cn(
          "mx-auto w-[794px] max-w-full overflow-hidden rounded-xl shadow-[var(--shadow-lift)] ring-1 ring-slate-200",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-[14.5px]">
          <span className="font-bold text-indigo-600">•</span>
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}
