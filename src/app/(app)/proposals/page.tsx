import { createClient } from "@/lib/supabase/server";
import { pricingAmounts } from "@/lib/proposal-pricing";
import type { Proposal } from "@/lib/types";

import { ProposalsView } from "./proposals-view";

export const metadata = { title: "Proposals" };

export default async function ProposalsPage() {
  const supabase = await createClient();

  const [proposalsRes, clientsRes, priceAmounts] = await Promise.all([
    supabase.from("proposals").select("*").order("created_at", { ascending: false }),
    supabase.from("clients").select("id, name, company").order("name"),
    // What the team charges today, so a new proposal quotes the Pricing page
    // rather than the constants in proposal.ts. Frozen onto the proposal when
    // it's saved, which is what keeps old ones printing their own numbers.
    pricingAmounts(supabase),
  ]);

  return (
    <ProposalsView
      pastProposals={(proposalsRes.data ?? []) as unknown as Proposal[]}
      clients={clientsRes.data ?? []}
      priceAmounts={priceAmounts}
    />
  );
}
