"use client";

import * as React from "react";
import { FilePlus2, History } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Database } from "@/lib/database.types";

import { NoticeGenerator } from "./notice-generator";
import { PastNotices } from "./past-notices";

export type SavedNotice = Database["public"]["Tables"]["notices"]["Row"];

/** The client-directory rows the send dialog picks a recipient from. */
export type ClientLite = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
};

/** The exact document handed to the PDF renderer / emailer. */
export type NoticePayload = {
  notice_number: string;
  notice_date: string;
  to_name: string;
  to_details: string;
  subject: string;
  body: string;
};

type Tab = "create" | "past";

export function NoticesView({
  pastNotices,
  clients,
  initialTab = "create",
}: {
  pastNotices: SavedNotice[];
  clients: ClientLite[];
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
          active={tab === "past"}
          onClick={() => setTab("past")}
          icon={<History className="h-4 w-4" />}
        >
          Past notices
          {pastNotices.length > 0 && (
            <TabCount active={tab === "past"} count={pastNotices.length} />
          )}
        </TabButton>
      </div>

      {tab === "create" ? (
        <NoticeGenerator pastNotices={pastNotices} clients={clients} />
      ) : (
        <PastNotices notices={pastNotices} clients={clients} />
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
