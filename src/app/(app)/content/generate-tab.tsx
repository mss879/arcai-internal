"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Download,
  Images,
  Loader2,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_QUALITY,
  IMAGE_QUALITIES,
  MAX_GENERATIONS,
  type AspectRatio,
  type ImageQuality,
} from "@/lib/content";
import type { ContentGeneration, ContentReference } from "@/lib/types";

import { generateContent } from "./actions";

async function downloadImage(url: string, filename: string) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function GenerateTab({
  references,
  geminiReady,
  onManageReferences,
}: {
  references: ContentReference[];
  geminiReady: boolean;
  onManageReferences: () => void;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = React.useState("");
  const [quality, setQuality] = React.useState<ImageQuality>(DEFAULT_QUALITY);
  const [aspect, setAspect] = React.useState<AspectRatio>(DEFAULT_ASPECT_RATIO);
  const [count, setCount] = React.useState(1);
  const [pending, setPending] = React.useState(false);
  const [results, setResults] = React.useState<ContentGeneration[]>([]);

  async function run() {
    if (!prompt.trim()) {
      toast.error("Describe what you want to create.");
      return;
    }
    setPending(true);
    setResults([]);
    try {
      const res = await generateContent({
        prompt,
        aspectRatio: aspect,
        imageSize: quality,
        count,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setResults(res.generations);
      toast.success(
        res.note ?? `Generated ${res.generations.length} image${res.generations.length > 1 ? "s" : ""}`,
      );
      // Refresh so the History tab + counts pick up the new rows.
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Generation failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      {/* ---- Controls ---- */}
      <div className="space-y-5 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        {!geminiReady && (
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Add <code className="font-mono text-xs">GEMINI_API_KEY</code> to
              your <code className="font-mono text-xs">.env.local</code> and
              restart the dev server to enable generation.
            </span>
          </div>
        )}

        <Field label="Prompt" required>
          <Textarea
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A sleek hero image for our AI automation service — deep navy gradient, abstract circuitry, our logo bottom-right."
            disabled={pending}
          />
        </Field>

        {/* Quality */}
        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">Quality</p>
          <div className="grid grid-cols-3 gap-2">
            {IMAGE_QUALITIES.map((q) => (
              <OptionCard
                key={q.value}
                active={quality === q.value}
                onClick={() => setQuality(q.value)}
                disabled={pending}
                title={q.label}
                hint={q.value}
              />
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-400">
            {IMAGE_QUALITIES.find((q) => q.value === quality)?.hint}
          </p>
        </div>

        {/* Size / aspect ratio */}
        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">Size</p>
          <div className="flex flex-wrap gap-2">
            {ASPECT_RATIOS.map((a) => (
              <button
                key={a.value}
                type="button"
                disabled={pending}
                onClick={() => setAspect(a.value)}
                title={a.hint}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50",
                  aspect === a.value
                    ? "border-primary-400 bg-primary-50 text-primary-700 ring-2 ring-primary-100"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                )}
              >
                {a.label}
                <span className="ml-1.5 text-[11px] text-slate-400">
                  {a.value}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Number of generations */}
        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">
            Number of variations
          </p>
          <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
            {Array.from({ length: MAX_GENERATIONS }, (_, i) => i + 1).map(
              (n) => (
                <button
                  key={n}
                  type="button"
                  disabled={pending}
                  onClick={() => setCount(n)}
                  className={cn(
                    "h-9 w-11 rounded-lg text-sm font-semibold transition disabled:opacity-50",
                    count === n
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-700",
                  )}
                >
                  {n}
                </button>
              ),
            )}
          </div>
        </div>

        {/* Reference note */}
        <button
          type="button"
          onClick={onManageReferences}
          className="flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-3 text-left text-sm text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
        >
          <Images className="h-4 w-4 shrink-0 text-primary-500" />
          {references.length > 0 ? (
            <span>
              Guided by{" "}
              <span className="font-semibold text-slate-800">
                {references.length} reference
                {references.length > 1 ? "s" : ""}
              </span>{" "}
              from your library.
            </span>
          ) : (
            <span>
              No references yet — add brand designs to guide every generation.
            </span>
          )}
        </button>

        <Button
          onClick={run}
          loading={pending}
          disabled={!geminiReady}
          className="w-full"
          size="lg"
        >
          {!pending && <Sparkles className="h-4 w-4" />}
          {pending ? "Generating…" : `Generate ${count > 1 ? `${count} images` : "image"}`}
        </Button>
      </div>

      {/* ---- Results ---- */}
      <div>
        {pending ? (
          <div className="grid h-full min-h-[320px] place-items-center rounded-2xl border border-dashed border-slate-200 bg-white/60">
            <div className="flex flex-col items-center gap-3 text-slate-500">
              <Loader2 className="h-7 w-7 animate-spin text-primary-500" />
              <p className="text-sm font-medium">
                Creating {count} {count > 1 ? "variations" : "image"} with Gemini…
              </p>
              <p className="text-xs text-slate-400">
                Higher quality takes longer.
              </p>
            </div>
          </div>
        ) : results.length > 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              Saved to{" "}
              <span className="font-medium text-slate-700">History</span>. Hover
              an image to download.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {results.map((g) => (
                <div
                  key={g.id}
                  className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-[var(--shadow-card)]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={g.image_url}
                    alt={g.prompt}
                    className="h-full w-full object-contain"
                  />
                  <button
                    onClick={() =>
                      downloadImage(g.image_url, `arc-${g.id.slice(0, 8)}.png`)
                    }
                    className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-lg bg-white/90 px-2.5 py-1.5 text-xs font-semibold text-slate-700 opacity-0 shadow backdrop-blur transition hover:bg-white group-hover:opacity-100"
                  >
                    <Download className="h-3.5 w-3.5" /> Download
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid h-full min-h-[320px] place-items-center rounded-2xl border border-dashed border-slate-200 bg-white/60 text-center">
            <div className="flex flex-col items-center gap-2 px-6 text-slate-400">
              <Sparkles className="h-8 w-8 text-primary-300" />
              <p className="text-sm font-medium text-slate-500">
                Your generated images will appear here.
              </p>
              <p className="text-xs">
                Write a prompt, pick quality &amp; size, then hit Generate.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OptionCard({
  active,
  onClick,
  disabled,
  title,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col items-center rounded-xl border px-2 py-2.5 transition disabled:opacity-50",
        active
          ? "border-primary-400 bg-primary-50 ring-2 ring-primary-100"
          : "border-slate-200 bg-white hover:border-slate-300",
      )}
    >
      <span
        className={cn(
          "text-sm font-semibold",
          active ? "text-primary-700" : "text-slate-700",
        )}
      >
        {title}
      </span>
      <span className="text-[11px] text-slate-400">{hint}</span>
    </button>
  );
}
