"use client";

/**
 * The three AI tools that belong to ONE project (AI-3, AI-5, AI-6).
 *
 * The workspace-wide ones — asking questions, the risk ranking, estimates,
 * the lessons queue and the guards — live on /projects/insights. These three
 * only make sense with a project in front of you, so they live here.
 *
 * All three draft. None of them messages the client, bills anything, or
 * decides that a lesson is true.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  BookOpen,
  Camera,
  ScanSearch,
  Sparkles,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import type { ProgressNote } from "@/lib/ai/progress-note";

import {
  checkScope,
  fileProgressNote,
  readScreenshot,
  runPostMortem,
} from "@/app/(app)/projects/ai-actions";

/** Matches the portal upload guard and stays under the server-action limit. */
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export function AiToolsCard({
  projectId,
  aiReady,
  canPostMortem,
  hasClient,
}: {
  projectId: string;
  aiReady: boolean;
  /** Post-mortems need a project that actually finished. */
  canPostMortem: boolean;
  /** Scope-creep reading needs a client with a WhatsApp thread. */
  hasClient: boolean;
}) {
  const router = useRouter();
  const fileRef = React.useRef<HTMLInputElement>(null);

  const [scanning, setScanning] = React.useState(false);
  const [reading, setReading] = React.useState(false);
  const [learning, setLearning] = React.useState(false);
  const [filing, setFiling] = React.useState(false);
  const [draft, setDraft] = React.useState<ProgressNote | null>(null);

  async function handleScope() {
    setScanning(true);
    const res = await checkScope(projectId);
    setScanning(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (res.findings.length === 0) {
      toast.success("Nothing out of scope in the thread.");
      return;
    }
    toast.success(
      `${res.findings.length} possible extra${res.findings.length === 1 ? "" : "s"} filed as change requests — price them on the Client tab.`,
    );
    router.refresh();
  }

  async function handleScreenshot(file: File) {
    if (file.size > MAX_SCREENSHOT_BYTES) {
      toast.error("That image is over 8MB — take a smaller screenshot.");
      return;
    }
    setReading(true);
    setDraft(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(file);
      });
      const res = await readScreenshot(projectId, dataUrl);
      if (res.ok) setDraft(res.note);
      else toast.error(res.error);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleFile() {
    if (!draft) return;
    setFiling(true);
    const res = await fileProgressNote(projectId, {
      headline: draft.headline,
      clientUpdate: draft.client_update,
      internalNote: draft.internal_note,
    });
    setFiling(false);
    if (res.ok) {
      toast.success("Filed to the project.");
      setDraft(null);
      router.refresh();
    } else toast.error(res.error);
  }

  async function handlePostMortem() {
    setLearning(true);
    const res = await runPostMortem(projectId);
    setLearning(false);
    if (res.ok) {
      toast.success("Post-mortem done — keep or dismiss the lessons on Insights.");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-2.5 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-fuchsia-50 text-fuchsia-600">
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">AI tools</h2>
          <p className="text-xs text-slate-400">
            Everything here drafts — nothing is sent, billed or decided for you.
          </p>
        </div>
        <Link
          href="/projects/insights"
          className="shrink-0 text-xs font-medium text-primary-600 hover:underline"
        >
          Insights →
        </Link>
      </div>

      {!aiReady ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">
          Add an <code className="text-slate-500">OPENAI_API_KEY</code> to switch
          these on.
        </p>
      ) : (
        <div className="divide-y divide-slate-100">
          {/* AI-5 */}
          <div className="px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                  <Camera className="h-4 w-4 text-slate-400" />
                  Screenshot → progress note
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Drop what you just built. Get a client update and an internal
                  note, both editable before anything is filed.
                </p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleScreenshot(file);
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileRef.current?.click()}
                loading={reading}
              >
                <Upload className="h-4 w-4" /> Choose image
              </Button>
            </div>

            {draft && (
              <div className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                {draft.headline && (
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {draft.headline}
                  </p>
                )}
                <div>
                  <label className="text-xs font-medium text-slate-600">
                    For the client
                  </label>
                  <Textarea
                    value={draft.client_update}
                    onChange={(e) =>
                      setDraft({ ...draft, client_update: e.target.value })
                    }
                    rows={3}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600">
                    Internal note
                  </label>
                  <Textarea
                    value={draft.internal_note}
                    onChange={(e) =>
                      setDraft({ ...draft, internal_note: e.target.value })
                    }
                    rows={2}
                    className="mt-1"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                    Discard
                  </Button>
                  <Button size="sm" onClick={handleFile} loading={filing}>
                    File both
                  </Button>
                </div>
                <p className="text-[11px] text-slate-400">
                  Filed as project comments. Sending the client update is still
                  your call — copy it into WhatsApp or the Client tab.
                </p>
              </div>
            )}
          </div>

          {/* AI-3 */}
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                <ScanSearch className="h-4 w-4 text-slate-400" />
                Check for scope creep
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {hasClient
                  ? "Reads the client's WhatsApp against the agreed scope and files anything extra as a change request to price."
                  : "Needs a client with a WhatsApp thread attached to this project."}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleScope}
              loading={scanning}
              disabled={!hasClient}
            >
              Read the thread
            </Button>
          </div>

          {/* AI-6 */}
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                <BookOpen className="h-4 w-4 text-slate-400" />
                Post-mortem
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {canPostMortem
                  ? "Where the time went, where the margin leaked, what to quote differently — against what your other projects of this type actually did."
                  : "Available once the project is completed or delivered."}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handlePostMortem}
              loading={learning}
              disabled={!canPostMortem}
            >
              What did we learn?
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
