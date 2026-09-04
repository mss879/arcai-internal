import { requireProfile } from "@/lib/auth";
import {
  includedLines,
  packageFromLineItems,
  serviceTypeForPackage,
} from "@/lib/package-match";
import { allFinanceProjectCosts } from "@/lib/project-costs";
import type { ProposalSelection } from "@/lib/proposal";
import { packageKeyForSelection } from "@/lib/proposal-pricing";
import { createClient } from "@/lib/supabase/server";

import type { ProjectPrefill } from "@/components/projects/project-form-modal";
import { ProjectsView, type ProjectCard } from "./projects-view";

export const metadata = { title: "Projects" };

type Search = {
  archived?: string;
  /** 0112 — `?new=1` opens the create dialog; `quote=`/`proposal=` prefill it. */
  new?: string;
  quote?: string;
  proposal?: string;
  /** Initial filters, so other pages can link to a slice of the board. */
  service?: string;
  status?: string;
  mode?: string;
};

/**
 * The board's data.
 *
 * Everything a card needs to answer "is this job healthy and is it making
 * money" is aggregated here rather than fetched per card: the workspace is
 * single-tenant and these are small tables, so a handful of flat reads beats
 * N round-trips and lets the filters and sorts run on real numbers.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const supabase = await createClient();
  const params = await searchParams;
  const showArchived = params.archived === "1";

  // Built in two steps so the archive filter reads as what it is.
  let projectQuery = supabase
    .from("projects")
    // company_payments carry the money actually received against a project
    // (0083); `payments` is the project's own ledger (0006). Both count.
    .select(
      "*, client:clients(id, name, company), payments(id, amount, status, paid_at, method, notes), company_payments(id, price_lkr, is_paid, created_at, company_name)",
    );
  // 0090 — the archive is its own view.
  projectQuery = showArchived
    ? projectQuery.not("deleted_at", "is", null)
    : projectQuery.is("deleted_at", null);

  const [
    profile,
    projectsRes,
    clientsRes,
    expensesRes,
    financeCosts,
    membersRes,
    tasksRes,
    assetsRes,
    milestonesRes,
    commissionsRes,
    savedViewsRes,
    settingsRes,
    quoteRes,
    proposalRes,
  ] = await Promise.all([
    requireProfile(),
    projectQuery.order("created_at", { ascending: false }),
    // 0112 — the phone decides whether the create dialog can send the link.
    supabase.from("clients").select("id, name, company, phone").order("name"),
    supabase.from("project_expenses").select("project_id, amount, billable"),
    // 0100 — Finance costs tagged to a project count against its margin too.
    allFinanceProjectCosts(supabase),
    supabase
      .from("project_members")
      .select(
        "project_id, user_id, is_owner, profile:profiles!project_members_user_id_fkey(id, full_name, avatar_url)",
      ),
    supabase
      .from("todos")
      .select("project_id, status, due_date")
      .not("project_id", "is", null),
    supabase
      .from("project_document_requests")
      .select("project_id, status, required"),
    supabase
      .from("project_milestones")
      .select("project_id, status, due_date, kind, client_visible"),
    supabase
      .from("commissions")
      .select("project_id, amount, percentage, basis"),
    // VIEW-2 (0097) — saved filter sets. Scoping happens below rather than in
    // the query: RLS is workspace-wide here, so the private/shared split is
    // applied against the profile we just resolved.
    supabase
      .from("project_views")
      .select("id, name, filters, owner_id, shared")
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    // 0112 — whether a new project texts its client the link by default.
    supabase
      .from("delivery_settings")
      .select("portal_auto_send")
      .eq("id", 1)
      .maybeSingle(),
    params.quote
      ? supabase
          .from("quotes")
          .select(
            "id, quote_number, title, customer_name, lead_id, client_id, items, grand_total, currency",
          )
          .eq("id", params.quote)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    params.proposal
      ? supabase
          .from("proposals")
          .select(
            "id, client_name, project_name, grand_total, selection, lead_id, client_id, quote_id",
          )
          .eq("id", params.proposal)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // A private view is only listed for the person who made it.
  const savedViews = (savedViewsRes.data ?? []).filter(
    (v) => v.shared || !v.owner_id || v.owner_id === profile.id,
  );

  // ---- 0112: start a project from the sale --------------------------------
  // "Start project" on an accepted quote or a proposal lands here with the
  // record's id; the form opens with the client, value, package and the
  // "Included:" lines already in place, and the chain FKs set.
  let prefill: ProjectPrefill | null = null;
  const quote = quoteRes.data;
  if (quote) {
    let clientId = quote.client_id;
    if (!clientId && quote.lead_id) {
      const { data: lead } = await supabase
        .from("leads")
        .select("client_id")
        .eq("id", quote.lead_id)
        .maybeSingle();
      clientId = lead?.client_id ?? null;
    }
    const packageKey = packageFromLineItems(quote.items);
    prefill = {
      sourceLabel: `Quote ${quote.quote_number}`,
      input: {
        name: quote.title?.trim() || `${quote.customer_name} — website`,
        client_id: clientId,
        lead_id: quote.lead_id,
        quote_id: quote.id,
        total_value: Number(quote.grand_total) || 0,
        currency: quote.currency || "LKR",
        description: includedLines(quote.items),
        package_key: packageKey,
        service_type: serviceTypeForPackage(packageKey),
      },
    };
  }
  const proposal = proposalRes.data;
  if (proposal && !prefill) {
    const wanted = proposal.client_name.trim().toLowerCase();
    const byName = proposal.client_id
      ? null
      : (clientsRes.data ?? []).find((c) => c.name.trim().toLowerCase() === wanted);
    const packageKey = packageKeyForSelection(
      proposal.selection as unknown as ProposalSelection,
    );
    prefill = {
      sourceLabel: `Proposal for ${proposal.client_name}`,
      input: {
        name: proposal.project_name,
        client_id: proposal.client_id ?? byName?.id ?? null,
        lead_id: proposal.lead_id,
        quote_id: proposal.quote_id,
        proposal_id: proposal.id,
        total_value: Number(proposal.grand_total) || 0,
        package_key: packageKey,
        service_type: serviceTypeForPackage(packageKey),
      },
    };
  }

  return (
    <ProjectsView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projects={(projectsRes.data ?? []) as any as ProjectCard[]}
      clients={clientsRes.data ?? []}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expenses={[...(expensesRes.data ?? []), ...financeCosts] as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      team={(membersRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tasks={(tasksRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assets={(assetsRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      milestones={(milestonesRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commissions={(commissionsRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      savedViews={savedViews as any}
      isAdmin={profile.role === "admin"}
      showArchived={showArchived}
      prefill={prefill}
      openNew={params.new === "1" || Boolean(prefill)}
      portalAutoSend={settingsRes.data?.portal_auto_send ?? true}
      baseUrl={(process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "")}
      initialFilters={{
        service: params.service,
        status: params.status,
        mode: params.mode,
      }}
    />
  );
}
