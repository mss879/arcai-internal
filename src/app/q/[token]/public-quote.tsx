"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Eraser, PenLine, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn, formatCurrency } from "@/lib/utils";
import type { Quote } from "@/lib/types";

import { acceptQuote, declineQuote } from "./actions";

export function PublicQuote({
  quote,
  company,
}: {
  quote: Quote;
  company: {
    name: string;
    phones: string;
    email: string;
    website: string;
    addressLines: string[];
  };
}) {
  const [status, setStatus] = React.useState(quote.status);
  const [showDecline, setShowDecline] = React.useState(false);

  const expired =
    quote.valid_until && new Date(quote.valid_until) < new Date() && status !== "accepted";

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Header card */}
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
          <div className="bg-gradient-to-br from-primary-500 to-primary-700 px-6 py-6 text-white sm:px-10">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-lg font-bold tracking-tight">{company.name}</p>
                <p className="mt-0.5 text-xs text-white/70">
                  {company.addressLines.join(" · ")}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wider text-white/70">Quotation</p>
                <p className="text-lg font-bold">{quote.quote_number}</p>
              </div>
            </div>
          </div>

          <div className="space-y-6 px-6 py-6 sm:px-10 sm:py-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Prepared for
                </p>
                <p className="mt-1 text-base font-semibold text-slate-900">
                  {quote.customer_name}
                </p>
                {quote.title && <p className="text-sm text-slate-500">{quote.title}</p>}
              </div>
              <div className="text-right text-sm text-slate-500">
                <p>Date: {new Date(quote.created_at).toLocaleDateString()}</p>
                {quote.valid_until && (
                  <p className={cn(expired && "font-semibold text-rose-500")}>
                    Valid until: {new Date(quote.valid_until).toLocaleDateString()}
                  </p>
                )}
              </div>
            </div>

            {/* Items table */}
            <div className="overflow-hidden rounded-2xl border border-slate-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-400">
                    <th className="px-4 py-3 font-semibold">Item</th>
                    <th className="px-4 py-3 text-right font-semibold">Qty</th>
                    <th className="px-4 py-3 text-right font-semibold">Rate</th>
                    <th className="px-4 py-3 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {quote.items.map((it, i) => (
                    <tr key={i}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-800">{it.item}</p>
                        {it.description && (
                          <p className="text-xs text-slate-400">{it.description}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-600">{it.qty || "1"}</td>
                      <td className="px-4 py-3 text-right text-slate-600">
                        {formatCurrency(Number(it.rate) || 0, quote.currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-slate-800">
                        {formatCurrency(Number(it.total) || 0, quote.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="ml-auto w-full max-w-xs space-y-1.5 text-sm">
              <div className="flex justify-between text-slate-500">
                <span>Subtotal</span>
                <span>{formatCurrency(Number(quote.subtotal), quote.currency)}</span>
              </div>
              {Number(quote.discount) > 0 && (
                <div className="flex justify-between text-slate-500">
                  <span>Discount</span>
                  <span>-{formatCurrency(Number(quote.discount), quote.currency)}</span>
                </div>
              )}
              {Number(quote.tax_rate) > 0 && (
                <div className="flex justify-between text-slate-500">
                  <span>Tax ({Number(quote.tax_rate)}%)</span>
                  <span>{formatCurrency(Number(quote.tax_amount), quote.currency)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
                <span>Total</span>
                <span>{formatCurrency(Number(quote.grand_total), quote.currency)}</span>
              </div>
            </div>

            {(quote.notes || quote.terms) && (
              <div className="grid gap-4 sm:grid-cols-2">
                {quote.notes && (
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Notes
                    </p>
                    <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{quote.notes}</p>
                  </div>
                )}
                {quote.terms && (
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Terms
                    </p>
                    <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{quote.terms}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Action card */}
        {status === "accepted" ? (
          <div className="rounded-3xl border border-emerald-200 bg-emerald-50 px-6 py-8 text-center shadow-sm">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-500 text-white">
              <Check className="h-6 w-6" />
            </div>
            <h2 className="mt-3 text-lg font-bold text-emerald-800">Quotation accepted</h2>
            <p className="mt-1 text-sm text-emerald-700">
              {quote.signed_name ? `Signed by ${quote.signed_name}. ` : ""}
              Thank you! Our team will be in touch with the invoice and next steps.
            </p>
          </div>
        ) : status === "declined" ? (
          <div className="rounded-3xl border border-slate-200 bg-white px-6 py-8 text-center shadow-sm">
            <h2 className="text-lg font-bold text-slate-700">Quotation declined</h2>
            <p className="mt-1 text-sm text-slate-500">
              Changed your mind? Contact us at {company.email} or {company.phones}.
            </p>
          </div>
        ) : expired ? (
          <div className="rounded-3xl border border-amber-200 bg-amber-50 px-6 py-8 text-center shadow-sm">
            <h2 className="text-lg font-bold text-amber-800">This quotation has expired</h2>
            <p className="mt-1 text-sm text-amber-700">
              Contact us at {company.email} and we&apos;ll refresh it for you.
            </p>
          </div>
        ) : showDecline ? (
          <DeclineCard
            token={quote.share_token}
            onDeclined={() => setStatus("declined")}
            onBack={() => setShowDecline(false)}
          />
        ) : (
          <AcceptCard
            token={quote.share_token}
            customerName={quote.customer_name}
            onAccepted={() => setStatus("accepted")}
            onDecline={() => setShowDecline(true)}
          />
        )}

        <p className="pb-6 text-center text-xs text-slate-400">
          {company.name} · {company.email} · {company.phones}
        </p>
      </div>
    </div>
  );
}

// ---- Accept with e-signature -------------------------------------------------

function AcceptCard({
  token,
  customerName,
  onAccepted,
  onDecline,
}: {
  token: string;
  customerName: string;
  onAccepted: () => void;
  onDecline: () => void;
}) {
  const [name, setName] = React.useState(customerName);
  const [submitting, setSubmitting] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [hasDrawn, setHasDrawn] = React.useState(false);
  const drawing = React.useRef(false);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(scale, scale);
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
  }, []);

  function pointFrom(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handleDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pointFrom(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function handleMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pointFrom(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasDrawn(true);
  }

  function handleUp() {
    drawing.current = false;
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setHasDrawn(false);
    }
  }

  async function handleAccept() {
    const canvas = canvasRef.current;
    if (!canvas || !hasDrawn) {
      toast.error("Please draw your signature in the box.");
      return;
    }
    setSubmitting(true);
    const res = await acceptQuote({
      token,
      signedName: name,
      signatureData: canvas.toDataURL("image/png"),
    });
    setSubmitting(false);
    if (res.ok) {
      toast.success("Quotation accepted — thank you!");
      onAccepted();
    } else toast.error(res.error);
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl sm:p-8">
      <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
        <PenLine className="h-5 w-5 text-primary-500" />
        Accept & sign
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        Type your full name and draw your signature below to accept this quotation.
      </p>

      <div className="mt-4 space-y-4">
        <Field label="Full name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name" />
        </Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">
              Signature <span className="text-rose-500">*</span>
            </span>
            <button
              type="button"
              onClick={clearSignature}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-600"
            >
              <Eraser className="h-3.5 w-3.5" />
              Clear
            </button>
          </div>
          <canvas
            ref={canvasRef}
            onPointerDown={handleDown}
            onPointerMove={handleMove}
            onPointerUp={handleUp}
            onPointerLeave={handleUp}
            className="h-36 w-full touch-none rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={handleAccept}
            loading={submitting}
            disabled={!name.trim() || !hasDrawn}
            className="flex-1 sm:flex-none"
          >
            <Check className="h-4 w-4" />
            Accept quotation
          </Button>
          <Button variant="ghost" onClick={onDecline} disabled={submitting}>
            <X className="h-4 w-4" />
            Decline
          </Button>
        </div>
        <p className="text-xs text-slate-400">
          By signing you agree to the quotation total and terms above. A copy is recorded with a
          timestamp for both parties.
        </p>
      </div>
    </div>
  );
}

function DeclineCard({
  token,
  onDeclined,
  onBack,
}: {
  token: string;
  onDeclined: () => void;
  onBack: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function handleDecline() {
    setSubmitting(true);
    const res = await declineQuote({ token, reason });
    setSubmitting(false);
    if (res.ok) onDeclined();
    else toast.error(res.error);
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl sm:p-8">
      <h2 className="text-base font-bold text-slate-900">Decline this quotation?</h2>
      <p className="mt-1 text-sm text-slate-500">
        Let us know why (optional) — it helps us come back with a better fit.
      </p>
      <div className="mt-4 space-y-4">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. budget, timing, went another way…"
        />
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={onBack} disabled={submitting}>
            Go back
          </Button>
          <Button
            onClick={handleDecline}
            loading={submitting}
            className="bg-rose-600 hover:bg-rose-500"
          >
            Decline quotation
          </Button>
        </div>
      </div>
    </div>
  );
}
