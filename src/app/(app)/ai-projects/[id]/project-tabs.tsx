"use client";

/**
 * The AI project, in eight views (0126).
 *
 * Every panel is rendered on the server and handed in as a prop; this
 * component only decides which one is on screen, and keeps them all mounted
 * so flipping tabs never throws away a half-filled form. Same shape as the
 * project page's tabs.
 */

import * as React from "react";
import {
  BarChart3,
  BookOpen,
  Bot,
  Code2,
  FileText,
  LayoutDashboard,
  MessagesSquare,
  Plug,
  UserPlus,
} from "lucide-react";

import { cn } from "@/lib/utils";

export type AiTab =
  | "overview"
  | "knowledge"
  | "agent"
  | "deploy"
  | "backend"
  | "analytics"
  | "invoices"
  | "conversations"
  | "leads";

const TABS: readonly AiTab[] = [
  "overview",
  "knowledge",
  "agent",
  "deploy",
  "backend",
  "analytics",
  "invoices",
  "conversations",
  "leads",
];

export function isAiTab(value: string | null | undefined): value is AiTab {
  return typeof value === "string" && (TABS as readonly string[]).includes(value);
}

export function AiProjectTabs({
  overview,
  knowledge,
  agent,
  deploy,
  backend,
  analytics,
  invoices,
  conversations,
  leads,
  knowledgeBadge,
  leadsBadge,
  backendBadge,
  initialTab,
}: {
  overview: React.ReactNode;
  knowledge: React.ReactNode;
  agent: React.ReactNode;
  deploy: React.ReactNode;
  backend: React.ReactNode;
  analytics: React.ReactNode;
  invoices: React.ReactNode;
  conversations: React.ReactNode;
  leads: React.ReactNode;
  /** Deliveries that gave up, or tools that are failing. */
  backendBadge?: string;
  /** Sources still pending or failed. */
  knowledgeBadge?: string;
  /** Leads nobody has looked at. */
  leadsBadge?: string;
  initialTab?: string;
}) {
  const [tab, setTab] = React.useState<AiTab>(isAiTab(initialTab) ? initialTab : "overview");

  const items: { key: AiTab; label: string; icon: React.ReactNode; badge?: string; tone?: "amber" | "sky" | "rose" }[] = [
    { key: "overview", label: "Overview", icon: <LayoutDashboard className="h-4 w-4" /> },
    { key: "knowledge", label: "Knowledge", icon: <BookOpen className="h-4 w-4" />, badge: knowledgeBadge, tone: "amber" },
    { key: "agent", label: "Agent", icon: <Bot className="h-4 w-4" /> },
    { key: "deploy", label: "Deploy", icon: <Code2 className="h-4 w-4" /> },
    { key: "backend", label: "Backend", icon: <Plug className="h-4 w-4" />, badge: backendBadge, tone: "rose" },
    { key: "analytics", label: "Analytics", icon: <BarChart3 className="h-4 w-4" /> },
    { key: "invoices", label: "Invoices", icon: <FileText className="h-4 w-4" /> },
    { key: "conversations", label: "Conversations", icon: <MessagesSquare className="h-4 w-4" /> },
    { key: "leads", label: "Leads", icon: <UserPlus className="h-4 w-4" />, badge: leadsBadge, tone: "sky" },
  ];

  return (
    <div className="space-y-6">
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="inline-flex min-w-max rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
                tab === item.key ? "bg-primary-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100",
              )}
            >
              {item.icon}
              {item.label}
              {item.badge && (
                <span
                  className={cn(
                    "ml-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
                    tab === item.key
                      ? "bg-white/20 text-white"
                      : item.tone === "sky"
                        ? "bg-sky-50 text-sky-700"
                        : item.tone === "rose"
                          ? "bg-rose-50 text-rose-700"
                          : "bg-amber-50 text-amber-700",
                  )}
                >
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className={tab === "overview" ? undefined : "hidden"}>{overview}</div>
      <div className={tab === "knowledge" ? undefined : "hidden"}>{knowledge}</div>
      <div className={tab === "agent" ? undefined : "hidden"}>{agent}</div>
      <div className={tab === "deploy" ? undefined : "hidden"}>{deploy}</div>
      <div className={tab === "backend" ? undefined : "hidden"}>{backend}</div>
      <div className={tab === "analytics" ? undefined : "hidden"}>{analytics}</div>
      <div className={tab === "invoices" ? undefined : "hidden"}>{invoices}</div>
      <div className={tab === "conversations" ? undefined : "hidden"}>{conversations}</div>
      <div className={tab === "leads" ? undefined : "hidden"}>{leads}</div>
    </div>
  );
}
