import type { PricingOverrides } from "@/lib/pricing-catalog";

/**
 * Generate the pricing PDF on the server and save it to the user's machine.
 * Fetches the rendered file as a blob and clicks a temporary <a download>.
 * Mirrors the proposal/invoice download flow.
 */
export async function downloadPricingPdf(
  overrides: PricingOverrides,
): Promise<void> {
  const res = await fetch("/api/pricing/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides }),
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
  const a = document.createElement("a");
  a.href = url;
  a.download = "ARC-AI-Pricing.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
