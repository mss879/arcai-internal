export type NoticePdfPayload = {
  notice_number: string;
  notice_date: string; // ISO YYYY-MM-DD
  to_name: string;
  to_details: string;
  subject: string;
  body: string;
};

/**
 * Generate the notice PDF on the server and save it straight to the user's
 * machine — the notice twin of downloadInvoicePdf. We fetch the rendered file
 * as a blob and click a temporary <a> with a `download` attribute: no print
 * dialog, no extra clicks.
 */
export async function downloadNoticePdf(
  payload: NoticePdfPayload,
): Promise<void> {
  const res = await fetch("/api/notices/pdf", {
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
  const safeNumber =
    (payload.notice_number || "notice").replace(/[^a-zA-Z0-9._-]/g, "") ||
    "notice";

  const a = document.createElement("a");
  a.href = url;
  a.download = `Notice-${safeNumber}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
