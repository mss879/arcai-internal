"use client";

import * as React from "react";
import { CheckCircle2, Loader2, Upload } from "lucide-react";

import type { ActionResult } from "@/lib/types";

/**
 * "I've paid — here's the slip" (0120).
 *
 * The same form on the public invoice page and the project portal. It only
 * uploads; a person on the team confirms the money before the invoice reads
 * paid, and this form says so rather than pretending the tap settled it.
 */

export function SlipUploadForm({
  onUpload,
  pending,
  copy,
}: {
  /** The server action, bound by the caller to its token. */
  onUpload: (formData: FormData) => Promise<ActionResult>;
  /** A slip is already waiting — say so instead of asking for another. */
  pending: boolean;
  copy: {
    title: string;
    blurb: string;
    button: string;
    pending: string;
    thanks: string;
    noteLabel: string;
  };
}) {
  const [file, setFile] = React.useState<File | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(pending);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("file", file);
    if (note.trim()) fd.set("note", note.trim());
    const res = await onUpload(fd);
    setBusy(false);
    if (res.ok) {
      setDone(true);
      setFile(null);
      setNote("");
    } else setError(res.error);
  }

  return (
    <div className="rounded-3xl border border-white/30 bg-white/80 p-6 shadow-lg backdrop-blur-xl">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {copy.title}
      </p>
      {done ? (
        <p className="mt-2 flex items-start gap-2 text-sm text-emerald-700">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          {pending && !file ? copy.pending : copy.thanks}
        </p>
      ) : (
        <form onSubmit={submit} className="mt-2 space-y-3">
          <p className="text-sm text-slate-600">{copy.blurb}</p>
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white/70 px-4 py-4 text-sm text-slate-600 transition hover:border-primary-400 hover:text-primary-700">
            <Upload className="h-4 w-4" />
            <span className="truncate">{file ? file.name : "JPG, PNG or PDF · up to 10MB"}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={copy.noteLabel}
            className="w-full rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-primary-400 focus:outline-none"
            maxLength={200}
          />
          {error && <p className="text-xs text-rose-600">{error}</p>}
          <button
            type="submit"
            disabled={!file || busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {copy.button}
          </button>
        </form>
      )}
    </div>
  );
}
