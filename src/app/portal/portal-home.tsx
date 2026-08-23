"use client";

/**
 * The client's own dashboard (BIG-1, 0099).
 *
 * Written for the person paying, not the team: client-facing stage names
 * (`clientLabel`, written in 0084 and unused until LOOP-2), no internal
 * jargon, no margin, no health score, no risk note.
 */

import * as React from "react";
import Link from "next/link";
import { format, parseISO } from "date-fns";
import {
  ArrowUpRight,
  FileText,
  LogOut,
  OctagonPause,
  Receipt,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DELIVERY_STAGES, DELIVERY_STAGE_META } from "@/lib/constants";
import type { DeliveryStage } from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";

import { signOutClient } from "./actions";

export type PortalProject = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  stage: DeliveryStage | null;
  stageChangedAt: string | null;
  startDate: string | null;
  dueDate: string | null;
  currency: string;
  totalValue: number;
  received: number;
  balance: number;
  blocked: boolean;
  portalLink: string | null;
};

export type PortalInvoice = {
  id: string;
  number: string;
  date: string;
  total: number;
  due: number;
  paid: boolean;
  link: string | null;
};

export type PortalQuote = {
  id: string;
  number: string;
  title: string;
  total: number;
  currency: string;
  status: string;
  link: string | null;
  validUntil: string | null;
};

export function PortalHome({
  clientName,
  company,
  projects,
  invoices,
  quotes,
}: {
  clientName: string;
  company: string | null;
  projects: PortalProject[];
  invoices: PortalInvoice[];
  quotes: PortalQuote[];
  appUrl: string;
}) {
  const [signingOut, setSigningOut] = React.useState(false);

  const owed = projects.reduce((sum, p) => sum + p.balance, 0);
  const currency = projects[0]?.currency ?? "LKR";
  const live = projects.filter((p) =>
    ["planning", "active", "on_hold"].includes(p.status),
  );

  return (
    <main className="min-h-dvh bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-4">
          <div className="min-w-0">
            <p className="text-lg font-extrabold tracking-tight text-slate-900">
              ARC AI
            </p>
            <p className="truncate text-xs text-slate-500">
              {company ? `${clientName} · ${company}` : clientName}
            </p>
          </div>
          <form
            action={async () => {
              setSigningOut(true);
              await signOutClient();
            }}
          >
            <Button type="submit" variant="ghost" size="sm" loading={signingOut}>
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </form>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {/* The two numbers a client actually wants */}
        <div className="grid grid-cols-2 gap-3">
          <Tile
            label="Projects with us"
            value={String(live.length)}
            hint={
              projects.length > live.length
                ? `${projects.length - live.length} finished`
                : "All active"
            }
          />
          <Tile
            label="Outstanding"
            value={formatCurrency(owed, currency)}
            hint={owed > 0 ? "Across all your projects" : "Nothing due — thank you"}
            tone={owed > 0 ? "amber" : "good"}
          />
        </div>

        {/* Projects */}
        <section>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Your projects
          </h2>
          {projects.length === 0 ? (
            <p className="rounded-2xl border border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-400">
              Nothing here yet. Once we start work it will show up on this page.
            </p>
          ) : (
            <ul className="space-y-3">
              {projects.map((p) => (
                <li
                  key={p.id}
                  className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900">
                        {p.name}
                      </h3>
                      {p.description && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                          {p.description}
                        </p>
                      )}
                    </div>
                    {p.blocked && (
                      <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                        <OctagonPause className="h-3 w-3" />
                        Waiting on you
                      </Badge>
                    )}
                  </div>

                  {p.stage && <Stepper stage={p.stage} />}

                  <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                        {p.balance > 0 ? "Still to pay" : "Paid in full"}
                      </p>
                      <p
                        className={cn(
                          "text-lg font-bold tabular-nums",
                          p.balance > 0 ? "text-amber-600" : "text-emerald-600",
                        )}
                      >
                        {p.balance > 0
                          ? formatCurrency(p.balance, p.currency)
                          : formatCurrency(p.received, p.currency)}
                      </p>
                      {p.totalValue > 0 && (
                        <p className="text-[11px] text-slate-400">
                          {formatCurrency(p.received, p.currency)} of{" "}
                          {formatCurrency(p.totalValue, p.currency)} received
                        </p>
                      )}
                    </div>

                    {p.portalLink && (
                      <Link
                        href={p.portalLink}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-primary-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-primary-700"
                      >
                        Open project <ArrowUpRight className="h-4 w-4" />
                      </Link>
                    )}
                  </div>

                  {p.dueDate && (
                    <p className="mt-2 text-[11px] text-slate-400">
                      Expected to finish {format(parseISO(p.dueDate), "d MMMM yyyy")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Invoices */}
        {invoices.length > 0 && (
          <Section title="Invoices" icon={<Receipt className="h-4 w-4" />}>
            {invoices.map((i) => (
              <Row
                key={i.id}
                href={i.link}
                title={i.number}
                subtitle={format(parseISO(i.date), "d MMM yyyy")}
                right={formatCurrency(i.total, currency)}
                badge={
                  i.paid ? (
                    <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
                      Paid
                    </Badge>
                  ) : i.due > 0 ? (
                    <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                      {formatCurrency(i.due, currency)} due
                    </Badge>
                  ) : null
                }
              />
            ))}
          </Section>
        )}

        {/* Quotes */}
        {quotes.length > 0 && (
          <Section title="Quotations" icon={<FileText className="h-4 w-4" />}>
            {quotes.map((q) => (
              <Row
                key={q.id}
                href={q.link}
                title={q.title || q.number}
                subtitle={
                  q.validUntil
                    ? `Valid until ${format(parseISO(q.validUntil), "d MMM yyyy")}`
                    : q.number
                }
                right={formatCurrency(q.total, q.currency)}
                badge={
                  q.status === "accepted" ? (
                    <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
                      Accepted
                    </Badge>
                  ) : (
                    <Badge className="bg-sky-50 text-sky-700 ring-sky-200">
                      Awaiting you
                    </Badge>
                  )
                }
              />
            ))}
          </Section>
        )}

        <p className="pb-6 text-center text-xs text-slate-400">
          Questions about any of this? Just reply on WhatsApp — we&apos;re there.
        </p>
      </div>
    </main>
  );
}

/**
 * The six dots, in the client's own words.
 *
 * `clientLabel` was written into DELIVERY_STAGE_META in 0084 and read by
 * nothing until LOOP-2. "Building your project" is what a client should see;
 * "In build" is what the team calls it.
 */
function Stepper({ stage }: { stage: DeliveryStage }) {
  const index = DELIVERY_STAGES.indexOf(stage);
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1">
        {DELIVERY_STAGES.map((s, i) => (
          <div
            key={s}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              i <= index ? "bg-primary-500" : "bg-slate-200",
            )}
            title={DELIVERY_STAGE_META[s].clientLabel}
          />
        ))}
      </div>
      <p className="mt-1.5 text-xs font-medium text-primary-700">
        {DELIVERY_STAGE_META[stage].clientLabel}
      </p>
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "amber" | "good";
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-xl font-extrabold tabular-nums",
          tone === "amber"
            ? "text-amber-600"
            : tone === "good"
              ? "text-emerald-600"
              : "text-slate-900",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
        {icon}
        {title}
      </h2>
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {children}
      </ul>
    </section>
  );
}

function Row({
  href,
  title,
  subtitle,
  right,
  badge,
}: {
  href: string | null;
  title: string;
  subtitle: string;
  right: string;
  badge?: React.ReactNode;
}) {
  const inner = (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-800">{title}</p>
        <p className="truncate text-xs text-slate-400">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {badge}
        <span className="text-sm font-semibold tabular-nums text-slate-700">
          {right}
        </span>
      </div>
    </div>
  );

  return (
    <li>
      {href ? (
        <Link href={href} className="block transition hover:bg-slate-50">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </li>
  );
}
