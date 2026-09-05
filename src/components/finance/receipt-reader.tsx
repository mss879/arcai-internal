"use client";

import * as React from "react";
import { Camera, Loader2 } from "lucide-react";

import { readReceipt } from "@/app/(app)/projects/actions";
import type { ParsedReceipt } from "@/lib/ai/receipt";
import { cn } from "@/lib/utils";

/**
 * "Read from a receipt" for any expense form (T4.9).
 *
 * The project expense form has read supplier bills into its fields since
 * MON-8; the company ledger's form typed everything by hand. Same reader,
 * lifted out: the image goes straight from the file input to
 * `readReceipt()` as a data URL, so a bill the model cannot read never
 * leaves anything behind in storage, and nothing is saved — the parsed
 * fields are handed back for the form to fill its blanks with.
 */
export function ReceiptReader({
  onParsed,
  className,
}: {
  onParsed: (parsed: ParsedReceipt) => void;
  className?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [reading, setReading] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);

  async function read(file: File) {
    setReading(true);
    setNote(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Couldn't open that file."));
        reader.readAsDataURL(file);
      });
      const res = await readReceipt(dataUrl);
      if (!res.ok) {
        setNote(res.error);
        return;
      }
      onParsed(res.parsed);
      setNote(
        res.parsed.confidence === "high"
          ? "Filled in from the receipt — check the total before saving."
          : "Read it, but the image was hard to make out. Check every field.",
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't read that one.");
    } finally {
      setReading(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-3 py-2.5",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={reading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:opacity-60"
        >
          {reading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Camera className="h-3.5 w-3.5" />
          )}
          {reading ? "Reading the receipt…" : "Read from a receipt"}
        </button>
        <span className="text-[11px] text-slate-400">
          A photo or screenshot. Blank fields are filled; nothing is saved until you do.
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = "";
            if (picked) void read(picked);
          }}
        />
      </div>
      {note && <p className="mt-1.5 text-[11px] text-slate-500">{note}</p>}
    </div>
  );
}
