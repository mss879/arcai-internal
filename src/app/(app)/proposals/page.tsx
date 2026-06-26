import { createClient } from "@/lib/supabase/server";
import type { Proposal } from "@/lib/types";

import { ProposalsView } from "./proposals-view";

export const metadata = { title: "Proposals" };

export default async function ProposalsPage() {
  const supabase = await createClient();

  const [proposalsRes, clientsRes] = await Promise.all([
    supabase.from("proposals").select("*").order("created_at", { ascending: false }),
    supabase.from("clients").select("id, name, company").order("name"),
  ]);

  return (
    <ProposalsView
      pastProposals={(proposalsRes.data ?? []) as unknown as Proposal[]}
      clients={clientsRes.data ?? []}
    />
  );
}
