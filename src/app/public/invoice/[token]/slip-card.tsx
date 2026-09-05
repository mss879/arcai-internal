"use client";

import { SlipUploadForm } from "@/components/public/slip-upload-form";

import { uploadPaymentSlip } from "./actions";

/** The public invoice page's slip card (0120), bound to its token. */
export function InvoiceSlipCard({ token, pending }: { token: string; pending: boolean }) {
  return (
    <SlipUploadForm
      onUpload={(fd) => uploadPaymentSlip(token, fd)}
      pending={pending}
      copy={{
        title: "Paid by bank transfer?",
        blurb: "Send us the slip or a screenshot of the transfer and we'll mark the invoice paid once it lands.",
        button: "Send the slip",
        pending: "We have your slip — we'll confirm it shortly and let you know.",
        thanks: "Thank you — we've got it. We'll confirm the payment shortly and let you know.",
        noteLabel: "Anything we should know? (optional)",
      }}
    />
  );
}
