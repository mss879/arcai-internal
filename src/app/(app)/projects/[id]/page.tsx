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
import { PROJECT_STATUS_META, STORAGE_BUCKETS } from "@/lib/constants";
import { requireProfile } from "@/lib/auth";
import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/utils";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await requireProfile();
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("*, client:clients(id, name, company)")
    .eq("id", id)
    .maybeSingle();

  if (!project) notFound();

  const [paymentsRes, commissionsRes, members] = await Promise.all([
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
  ]);

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
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold text-slate-900">
                {project.name}
              </h1>
              <Badge className={PROJECT_STATUS_META[project.status].badge}>
                {PROJECT_STATUS_META[project.status].label}
              </Badge>
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

          <div className="grid grid-cols-3 gap-4 text-right">
            <Stat label="Budget" value={formatCurrency(Number(project.budget) || 0, project.currency)} />
            <Stat label="Received" value={formatCurrency(totalPaid, project.currency)} accent="emerald" />
            <Stat label="Outstanding" value={formatCurrency(outstanding, project.currency)} accent="amber" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <PaymentsSection
          projectId={id}
          currency={project.currency}
          payments={payments}
        />
        <CommissionsSection
          projectId={id}
          currency={project.currency}
          isAdmin={profile.role === "admin"}
          members={members}
          commissions={(commissionsRes.data ?? []) as unknown as CommissionRow[]}
        />
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
