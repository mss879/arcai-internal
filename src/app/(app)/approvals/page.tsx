import { requireProfile } from "@/lib/auth";
import { listApprovalItems } from "@/lib/approvals";
import { createClient } from "@/lib/supabase/server";

import { ApprovalsView } from "./approvals-view";

export const metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  await requireProfile();
  const supabase = await createClient();
  const items = await listApprovalItems(supabase);

  // The loan action needs the member it belongs to, and the list shape
  // deliberately doesn't carry ids it doesn't display — so it is looked up
  // here rather than widening ApprovalItem for one queue.
  const loanIds = items.filter((i) => i.kind === "loan").map((i) => i.id);
  const { data: loans } = loanIds.length
    ? await supabase.from("member_loans").select("id, user_id").in("id", loanIds)
    : { data: [] };
  const loanOwners = Object.fromEntries(
    (loans ?? []).map((l) => [l.id, l.user_id] as const),
  );

  return <ApprovalsView items={items} loanOwners={loanOwners} />;
}
