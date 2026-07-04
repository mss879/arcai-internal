import { createClient } from "@/lib/supabase/server";
import { getSmsAccountStatus, isSmsConfigured, smsSenderId } from "@/lib/sms";
import type {
  Client,
  Invoice,
  SmsMessage,
  SmsWorkflow,
  SmsWorkflowRun,
  SmsWorkflowStep,
} from "@/lib/types";

import { SmsView } from "./sms-view";

export const metadata = { title: "SMS" };

export default async function SmsPage() {
  const supabase = await createClient();

  const [clientsRes, messagesRes, invoicesRes, workflowsRes, stepsRes, runsRes, status] =
    await Promise.all([
      supabase
        .from("clients")
        .select("id, name, company, email, phone, city, status, notes, created_by, created_at")
        .order("name", { ascending: true }),
      supabase
        .from("sms_messages")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("invoices")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(60),
      supabase
        .from("sms_workflows")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("sms_workflow_steps")
        .select("*")
        .order("position", { ascending: true }),
      supabase
        .from("sms_workflow_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100),
      getSmsAccountStatus(),
    ]);

  return (
    <SmsView
      clients={(clientsRes.data ?? []) as Client[]}
      messages={(messagesRes.data ?? []) as SmsMessage[]}
      invoices={(invoicesRes.data ?? []) as Invoice[]}
      workflows={(workflowsRes.data ?? []) as SmsWorkflow[]}
      steps={(stepsRes.data ?? []) as SmsWorkflowStep[]}
      runs={(runsRes.data ?? []) as SmsWorkflowRun[]}
      smsReady={isSmsConfigured()}
      senderId={smsSenderId()}
      accountBalance={status?.balance ?? null}
    />
  );
}
