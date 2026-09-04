"use client";

import * as React from "react";
import { Check, Eraser, PenLine, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";

/**
 * Type your name, draw your signature, accept — for any document a client
 * signs on a link.
 *
 * The quote page had this and the proposal page needed exactly the same
 * thing: the canvas plumbing (device-pixel scaling, pointer capture, clearing,
 * toDataURL) is fiddly, easy to get subtly wrong on a phone, and there is no
 * reason for two copies of it to exist and drift. What differs between
 * documents is only the wording and which action is called, so both are props.
 *
 * The signature is a PNG data URL, stored as given. It is evidence of what
 * happened, not something to re-render.
 */

export type SignResult = { ok: boolean; error?: string };

export function SignAndAccept({
  defaultName,
  noun,
  acceptLabel,
  onAccept,
  onDeclineClick,
}: {
  defaultName: string;
  /** "quotation", "proposal", "agreement" — used in the copy. */
  noun: string;
  acceptLabel: string;
  onAccept: (input: { signedName: string; signatureData: string }) => Promise<SignResult>;
  onDeclineClick: () => void;
}) {
  const [name, setName] = React.useState(defaultName);
  const [submitting, setSubmitting] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [hasDrawn, setHasDrawn] = React.useState(false);
  const drawing = React.useRef(false);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Without the device-pixel scale the stroke is blurry on every phone.
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
    // Pointer capture, so a stroke that leaves the box doesn't break mid-line.
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

  async function submit() {
    const canvas = canvasRef.current;
    if (!canvas || !hasDrawn) {
      toast.error("Please draw your signature in the box.");
      return;
    }
    setSubmitting(true);
    const res = await onAccept({
      signedName: name,
      signatureData: canvas.toDataURL("image/png"),
    });
    setSubmitting(false);
    if (!res.ok) toast.error(res.error ?? "That didn't go through.");
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl sm:p-8">
      <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
        <PenLine className="h-5 w-5 text-primary-500" />
        Accept &amp; sign
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        Type your full name and draw your signature below to accept this {noun}.
      </p>

      <div className="mt-4 space-y-4">
        <Field label="Full name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your full name"
          />
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
            onClick={submit}
            loading={submitting}
            disabled={!name.trim() || !hasDrawn}
            className="flex-1 sm:flex-none"
          >
            <Check className="h-4 w-4" />
            {acceptLabel}
          </Button>
          <Button variant="ghost" onClick={onDeclineClick} disabled={submitting}>
            <X className="h-4 w-4" />
            Decline
          </Button>
        </div>
        <p className="text-xs text-slate-400">
          By signing you agree to the {noun} total and terms above. A copy is
          recorded with a timestamp for both parties.
        </p>
      </div>
    </div>
  );
}

/** The "why not?" step. Optional reason — a blank one still declines. */
export function DeclineCard({
  noun,
  onDecline,
  onBack,
}: {
  noun: string;
  onDecline: (reason: string) => Promise<SignResult>;
  onBack: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function submit() {
    setSubmitting(true);
    const res = await onDecline(reason);
    setSubmitting(false);
    if (!res.ok) toast.error(res.error ?? "That didn't go through.");
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl sm:p-8">
      <h2 className="text-base font-bold text-slate-900">Decline this {noun}?</h2>
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
            onClick={submit}
            loading={submitting}
            className="bg-rose-600 hover:bg-rose-500"
          >
            Decline {noun}
          </Button>
        </div>
      </div>
    </div>
  );
}
