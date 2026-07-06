"use client";

import * as React from "react";
import {
  BellRing,
  History,
  Megaphone,
  MessageSquareText,
  Wallet,
  Workflow,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { cn, formatCurrency } from "@/lib/utils";
import type {
  Client,
  Invoice,
  SmsMessage,
  SmsWorkflow,
  SmsWorkflowRun,
  SmsWorkflowStep,
} from "@/lib/types";

import { tickSmsAutomation } from "./actions";
import { SendTab } from "./send-tab";
import { RemindersTab } from "./reminders-tab";
import { PromotionsTab } from "./promotions-tab";
import { AutomationTab } from "./automation-tab";
import { HistoryTab } from "./history-tab";

type Tab = "send" | "reminders" | "promotions" | "automation" | "history";

/** How often the open page checks for due automation timers. */
const TICK_INTERVAL_MS = 30_000;

export function SmsView({
  clients,
  messages,
  invoices,
  workflows,
  steps,
  runs,
  smsReady,
  senderId,
  accountBalance,
}: {
  clients: Client[];
  messages: SmsMessage[];
  invoices: Invoice[];
  workflows: SmsWorkflow[];
  steps: SmsWorkflowStep[];
  runs: SmsWorkflowRun[];
  smsReady: boolean;
  senderId: string;
  accountBalance: number | null;
}) {
  useRealtimeSync("sms_messages");
  useRealtimeSync("sms_workflows");
  useRealtimeSync("sms_workflow_runs");
  const [tab, setTab] = React.useState<Tab>("send");

  // Drive the automation timers while the page is open. The cron route
  // (/api/sms/automation/tick) covers the rest in production.
  React.useEffect(() => {
    if (!smsReady) return;
    let cancelled = false;
    const tick = () => {
      // Skip ticks in background tabs — the cron route covers those.
      if (!cancelled && document.visibilityState === "visible")
        void tickSmsAutomation().catch(() => {});
    };
    tick();
    const interval = setInterval(tick, TICK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [smsReady]);

  const runningRuns = runs.filter((r) => r.status === "running").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="SMS"
        description="Send texts to clients via Notify.lk — one-off messages, payment reminders and timed automations."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="bg-slate-100 text-slate-600 ring-slate-200">
              Sender: {senderId}
            </Badge>
            {accountBalance !== null && (
              <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">
                <Wallet className="h-3.5 w-3.5" />
                Balance {formatCurrency(accountBalance)}
              </Badge>
            )}
          </div>
        }
      />

      {!smsReady && (
        <Alert variant="info">
          <strong>Notify.lk isn&apos;t connected yet.</strong> Add your{" "}
          <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">NOTIFYLK_USER_ID</code>,{" "}
          <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">NOTIFYLK_API_KEY</code> and{" "}
          <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">NOTIFYLK_SENDER_ID</code>{" "}
          to <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">.env.local</code> (from
          your Notify.lk settings page), then restart the dev server. Until then sends will fail.
        </Alert>
      )}

      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton
          active={tab === "send"}
          onClick={() => setTab("send")}
          icon={<MessageSquareText className="h-4 w-4" />}
        >
          Send SMS
        </TabButton>
        <TabButton
          active={tab === "reminders"}
          onClick={() => setTab("reminders")}
          icon={<BellRing className="h-4 w-4" />}
        >
          Payment Reminders
        </TabButton>
        <TabButton
          active={tab === "promotions"}
          onClick={() => setTab("promotions")}
          icon={<Megaphone className="h-4 w-4" />}
        >
          Promotions
        </TabButton>
        <TabButton
          active={tab === "automation"}
          onClick={() => setTab("automation")}
          icon={<Workflow className="h-4 w-4" />}
          count={runningRuns}
        >
          SMS Automation
        </TabButton>
        <TabButton
          active={tab === "history"}
          onClick={() => setTab("history")}
          icon={<History className="h-4 w-4" />}
          count={messages.length}
        >
          History
        </TabButton>
      </div>

      {tab === "send" && (
        <SendTab clients={clients} messages={messages} smsReady={smsReady} />
      )}
      {tab === "reminders" && (
        <RemindersTab
          clients={clients}
          invoices={invoices}
          messages={messages}
          smsReady={smsReady}
        />
      )}
      {tab === "promotions" && (
        <PromotionsTab clients={clients} messages={messages} smsReady={smsReady} />
      )}
      {tab === "automation" && (
        <AutomationTab
          clients={clients}
          workflows={workflows}
          steps={steps}
          runs={runs}
          smsReady={smsReady}
        />
      )}
      {tab === "history" && <HistoryTab messages={messages} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  count?: number;
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
      {typeof count === "number" && count > 0 && (
        <span
          className={cn(
            "ml-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
            active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
