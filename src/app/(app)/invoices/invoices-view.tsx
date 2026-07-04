"use client";

import * as React from "react";
import { FilePlus2, FileSignature, History } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Database } from "@/lib/database.types";
import type { Quote } from "@/lib/types";

import { InvoiceGenerator } from "./invoice-generator";
import { PastInvoices } from "./past-invoices";
import { QuotesSection, type ClientLite, type LeadLite } from "./quotes-section";

export type SavedInvoice = Database["public"]["Tables"]["invoices"]["Row"];

type Tab = "create" | "quotes" | "past";

export function InvoicesView({
  pastInvoices,
  quotes,
  clients,
  leads,
  initialTab = "create",
}: {
  pastInvoices: SavedInvoice[];
  quotes: Quote[];
  clients: ClientLite[];
  leads: LeadLite[];
  initialTab?: Tab;
}) {
  const [tab, setTab] = React.useState<Tab>(initialTab);

  return (
    <div className="space-y-6">
      <div className="no-print inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton
          active={tab === "create"}
          onClick={() => setTab("create")}
          icon={<FilePlus2 className="h-4 w-4" />}
        >
          Create
        </TabButton>
        <TabButton
          active={tab === "quotes"}
          onClick={() => setTab("quotes")}
          icon={<FileSignature className="h-4 w-4" />}
        >
          Quotes
          {quotes.length > 0 && <TabCount active={tab === "quotes"} count={quotes.length} />}
        </TabButton>
        <TabButton
          active={tab === "past"}
          onClick={() => setTab("past")}
          icon={<History className="h-4 w-4" />}
        >
          Past invoices
          {pastInvoices.length > 0 && (
            <TabCount active={tab === "past"} count={pastInvoices.length} />
          )}
        </TabButton>
      </div>

      {tab === "create" ? (
        <InvoiceGenerator pastInvoices={pastInvoices} quotes={quotes} />
      ) : tab === "quotes" ? (
        <QuotesSection quotes={quotes} clients={clients} leads={leads} />
      ) : (
        <PastInvoices invoices={pastInvoices} />
      )}
    </div>
  );
}

function TabCount({ active, count }: { active: boolean; count: number }) {
  return (
    <span
      className={cn(
        "ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
        active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500",
      )}
    >
      {count}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
        active
          ? "bg-primary-600 text-white shadow-sm"
          : "text-slate-600 hover:bg-slate-100",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
