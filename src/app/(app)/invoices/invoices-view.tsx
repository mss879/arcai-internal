"use client";

import * as React from "react";
import { FilePlus2, History } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Database } from "@/lib/database.types";

import { InvoiceGenerator } from "./invoice-generator";
import { PastInvoices } from "./past-invoices";

export type SavedInvoice = Database["public"]["Tables"]["invoices"]["Row"];

export function InvoicesView({
  pastInvoices,
}: {
  pastInvoices: SavedInvoice[];
}) {
  const [tab, setTab] = React.useState<"create" | "past">("create");

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
          active={tab === "past"}
          onClick={() => setTab("past")}
          icon={<History className="h-4 w-4" />}
        >
          Past invoices
          {pastInvoices.length > 0 && (
            <span
              className={cn(
                "ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
                tab === "past"
                  ? "bg-white/20 text-white"
                  : "bg-slate-100 text-slate-500",
              )}
            >
              {pastInvoices.length}
            </span>
          )}
        </TabButton>
      </div>

      {tab === "create" ? (
        <InvoiceGenerator />
      ) : (
        <PastInvoices invoices={pastInvoices} />
      )}
    </div>
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
