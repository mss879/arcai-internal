import type { ProposalContent, ProposalSelection } from "@/lib/proposal";

export type ProposalPdfPayload = {
  client_name: string;
  project_name: string;
  proposal_date: string; // ISO YYYY-MM-DD
  selection: ProposalSelection;
  content: ProposalContent;
};

/**
 * Generate the proposal PDF on the server and save it straight to the user's
 * machine — fetch the rendered file as a blob and click a temporary <a> with a
 * `download` attribute. Mirrors the invoice download flow.
 */
export async function downloadProposalPdf(
  payload: ProposalPdfPayload,
): Promise<void> {
  const res = await fetch("/api/proposals/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let message = "Couldn't generate the PDF.";
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // non-JSON error body — keep the default message
    }
    throw new Error(message);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const safe =
    (payload.client_name || "proposal").replace(/[^a-zA-Z0-9._-]/g, "") ||
    "proposal";

  const a = document.createElement("a");
  a.href = url;
  a.download = `Proposal-${safe}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
