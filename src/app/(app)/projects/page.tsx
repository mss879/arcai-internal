import { createClient } from "@/lib/supabase/server";

import { ProjectsView } from "./projects-view";

export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const supabase = await createClient();

  const [projectsRes, clientsRes] = await Promise.all([
    supabase
      .from("projects")
      // company_payments carry the money actually received against a project
      // (0083) — the card subtracts the PAID ones to show the real balance.
      .select(
        "*, client:clients(id, name, company), payments(amount, status), company_payments(id, price_lkr, is_paid, status)",
      )
      .order("created_at", { ascending: false }),
    supabase.from("clients").select("id, name, company").order("name"),
  ]);

  return (
    <ProjectsView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projects={(projectsRes.data ?? []) as any}
      clients={clientsRes.data ?? []}
    />
  );
}
