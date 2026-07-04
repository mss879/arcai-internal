"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Merge, Users2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { cn, formatCurrency } from "@/lib/utils";
import type { Lead } from "@/lib/types";

import { mergeLeads } from "../actions";

type DupeGroup = { key: string; label: string; leads: Lead[] };

/** Group leads sharing an email, phone or (fallback) exact title. */
function findGroups(leads: Lead[]): DupeGroup[] {
  const groups = new Map<string, { label: string; leads: Lead[] }>();
  const add = (key: string, label: string, lead: Lead) => {
    const g = groups.get(key) ?? { label, leads: [] };
    if (!g.leads.some((l) => l.id === lead.id)) g.leads.push(lead);
    groups.set(key, g);
  };

  for (const lead of leads) {
    const email = lead.contact_email?.toLowerCase().trim();
    const phone = lead.contact_phone?.replace(/[^\d]/g, "");
    if (email) add(`email:${email}`, email, lead);
    if (phone && phone.length > 5) add(`phone:${phone}`, lead.contact_phone!, lead);
    if (!email && (!phone || phone.length <= 5))
      add(`title:${lead.title.toLowerCase().trim()}`, lead.title, lead);
  }

  // Only real duplicates; de-dup groups covering the same lead set.
  const seen = new Set<string>();
  const out: DupeGroup[] = [];
  for (const [key, g] of groups) {
    if (g.leads.length < 2) continue;
    const setKey = g.leads.map((l) => l.id).sort().join("|");
    if (seen.has(setKey)) continue;
    seen.add(setKey);
    out.push({ key, label: g.label, leads: g.leads });
  }
  return out;
}

export function DuplicatesView({ leads }: { leads: Lead[] }) {
  const router = useRouter();
  const groups = React.useMemo(() => findGroups(leads), [leads]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/crm"
          className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:text-slate-800"
          aria-label="Back to CRM"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <PageHeader
          title="Duplicate leads"
          description="Leads sharing an email, phone number or identical title. Pick which one to keep — the rest merge into it (blanks filled, tags combined, history moved)."
        />
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={<Users2 className="h-6 w-6" />}
          title="No duplicates found"
          description="Nice and clean. New duplicates appear here automatically as leads come in."
        />
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <DupeCard
              key={group.key}
              group={group}
              onMerged={() => router.refresh()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DupeCard({ group, onMerged }: { group: DupeGroup; onMerged: () => void }) {
  const [keepId, setKeepId] = React.useState(group.leads[0]?.id ?? "");
  const [merging, setMerging] = React.useState(false);

  async function handleMerge() {
    setMerging(true);
    const res = await mergeLeads(
      keepId,
      group.leads.map((l) => l.id),
    );
    setMerging(false);
    if (res.ok) {
      toast.success("Merged — history, tasks and quotes moved to the kept lead.");
      onMerged();
    } else toast.error(res.error);
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-lg bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-600">
          {group.leads.length} share “{group.label}”
        </span>
        <Button size="sm" className="ml-auto" onClick={handleMerge} loading={merging}>
          <Merge className="h-3.5 w-3.5" />
          Merge into selected
        </Button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {group.leads.map((lead) => (
          <label
            key={lead.id}
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors",
              keepId === lead.id
                ? "border-primary-400 bg-primary-50/50 ring-2 ring-primary-100"
                : "border-slate-200 hover:border-slate-300",
            )}
          >
            <input
              type="radio"
              name={`keep-${group.key}`}
              checked={keepId === lead.id}
              onChange={() => setKeepId(lead.id)}
              className="mt-0.5 h-4 w-4 border-slate-300 text-primary-600"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-slate-800">
                {lead.title}
              </span>
              <span className="block text-xs text-slate-400">
                {[lead.contact_name, lead.contact_email, lead.contact_phone]
                  .filter(Boolean)
                  .join(" · ") || "no contact info"}
              </span>
              <span className="block text-xs text-slate-400">
                {lead.value != null && `${formatCurrency(Number(lead.value), lead.currency)} · `}
                added {new Date(lead.created_at).toLocaleDateString()}
                {keepId === lead.id && (
                  <strong className="text-primary-600"> · keeping this one</strong>
                )}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
