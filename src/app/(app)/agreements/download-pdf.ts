/**
 * The draft agreement as a file, straight to the user's machine.
 *
 * Mirrors the proposal's download: fetch the rendered PDF as a blob and click
 * a temporary <a download>. Distinct from `agreementPdfUrl()` in actions.ts,
 * which fetches the SIGNED copy filed in storage — this one renders the draft
 * as it currently stands, so a contract can be read on paper before anyone is
 * asked to sign it.
 */

export type AgreementPdfPayload = {
  kind: string;
  title: string;
  bodyMd: string;
  clientName: string | null;
  /** ISO YYYY-MM-DD. */
  date: string;
};

export async function downloadAgreementPdf(
  payload: AgreementPdfPayload,
): Promise<void> {
  const res = await fetch("/api/agreements/pdf", {
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
    (payload.title || "agreement").replace(/[^a-zA-Z0-9._-]/g, "") || "agreement";

  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
