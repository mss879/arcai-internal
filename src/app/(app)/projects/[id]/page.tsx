import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ArrowLeft, CalendarRange } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  CommissionsSection,
  type CommissionRow,
} from "@/components/projects/commissions-section";
import {
  PaymentsSection,
  type PaymentRow,
} from "@/components/projects/payments-section";
import { PortalSection } from "./portal-section";
import { PROJECT_STATUS_META, STORAGE_BUCKETS, SERVICE_TYPE_LABELS } from "@/lib/constants";
import { requireProfile } from "@/lib/auth";
import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/utils";
import type { ProjectStatus } from "@/lib/types";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Run the auth check concurrently with the data queries (see dashboard).
  const [profile, projectRes, paymentsRes, commissionsRes, members, docRequestsRes] = await Promise.all([
    requireProfile(),
    (supabase as any)
      .from("projects")
      .select("*, client:clients(id, name, company)")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("payments")
      .select("*")
      .eq("project_id", id)
      .order("paid_at", { ascending: false }),
    supabase
      .from("commissions")
      .select(
        "*, recipient:profiles!commissions_user_id_fkey(id, full_name, username, avatar_url)",
      )
      .eq("project_id", id)
      .order("created_at", { ascending: false }),
    getMembers(),
    (supabase as any)
      .from("project_document_requests")
      .select("*")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
  ]);

  const project = projectRes.data;
  if (!project) notFound();

  // Handle dynamic sharing token generation for legacy data
  let shareToken = project.share_token;
  if (!shareToken) {
    shareToken = crypto.randomUUID();
    await (supabase as any)
      .from("projects")
      .update({ share_token: shareToken })
      .eq("id", id);
  }

  const payments: PaymentRow[] = await Promise.all(
    (paymentsRes.data ?? []).map(async (p) => {
      if (!p.receipt_path) return p;
      const { data } = await supabase.storage
        .from(STORAGE_BUCKETS.receipts)
        .createSignedUrl(p.receipt_path, 3600);
      return { ...p, receiptUrl: data?.signedUrl ?? null };
    }),
  );

  const totalPaid = (paymentsRes.data ?? [])
    .filter((p) => p.status === "paid")
    .reduce((s, p) => s + Number(p.amount), 0);
  const outstanding = project.budget
    ? Math.max(0, Number(project.budget) - totalPaid)
    : 0;

  const client = project.client as unknown as {
    id: string;
    name: string;
    company: string | null;
  } | null;

  return (
    <div className="space-y-6">
      <Link
        href="/projects"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Projects
      </Link>

      {/* Header */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[var(--shadow-card)]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-semibold text-slate-900">
                  {project.name}
                </h1>
                <Badge className={PROJECT_STATUS_META[project.status as ProjectStatus].badge}>
                  {PROJECT_STATUS_META[project.status as ProjectStatus].label}
                </Badge>
                {project.service_type && (
                  <Badge className="bg-primary-50 text-primary-700 ring-primary-200 font-medium">
                    {SERVICE_TYPE_LABELS[project.service_type] || project.service_type}
                  </Badge>
                )}
              </div>
              {client && (
                <p className="mt-1 text-sm text-slate-500">
                  {client.name}
                  {client.company ? ` · ${client.company}` : ""}
                </p>
              )}
              {(project.start_date || project.due_date) && (
                <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-400">
                  <CalendarRange className="h-3.5 w-3.5" />
                  {project.start_date
                    ? format(new Date(project.start_date), "MMM d, yyyy")
                    : "—"}
                  {" → "}
                  {project.due_date
                    ? format(new Date(project.due_date), "MMM d, yyyy")
                    : "—"}
                </p>
              )}
              {project.description && (
                <p className="mt-3 max-w-2xl text-sm text-slate-600">
                  {project.description}
                </p>
              )}
            </div>
          </div>

          {/* Financial Indicators Grid */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-right mt-2 pt-4 border-t border-slate-100">
            <Stat label="Total Value" value={formatCurrency(Number(project.total_value) || 0, project.currency)} />
            <Stat label="Deposit Paid" value={formatCurrency(Number(project.deposit_paid) || 0, project.currency)} accent="emerald" />
            <Stat label="Balance Due" value={formatCurrency(Math.max(0, (Number(project.total_value || 0) - Number(project.deposit_paid || 0))), project.currency)} accent="amber" />
            <Stat label="Internal Budget" value={formatCurrency(Number(project.budget) || 0, project.currency)} />
            <Stat label="Budget Received" value={formatCurrency(totalPaid, project.currency)} />
          </div>
        </div>
      </div>

      {/* Main content split */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <PaymentsSection
            projectId={id}
            currency={project.currency}
            payments={payments}
          />
          <CommissionsSection
            projectId={id}
            currency={project.currency}
            totalValue={Number(project.total_value) || 0}
            isAdmin={profile.role === "admin"}
            members={members}
            commissions={(commissionsRes.data ?? []) as unknown as CommissionRow[]}
          />
        </div>
        <div>
          <PortalSection
            projectId={id}
            shareToken={shareToken}
            requests={docRequestsRes.data || []}
            isProjectCompleted={project.status === "completed"}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "emerald" | "amber";
}) {
  const color =
    accent === "emerald"
      ? "text-emerald-600"
      : accent === "amber"
        ? "text-amber-600"
        : "text-slate-900";
  return (
    <div>
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${color}`}>{value}</p>
    </div>
  );
}
