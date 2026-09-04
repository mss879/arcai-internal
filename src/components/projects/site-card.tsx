"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import { ExternalLink, Globe, Megaphone, Rocket, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import type { ProjectProgress } from "@/lib/project-progress";
import { cn } from "@/lib/utils";
import {
  launchProjectSite,
  setProgressOverride,
  setSiteUrls,
  updateClientNote,
} from "@/app/(app)/projects/actions";

/**
 * The website itself, as the client will meet it (0112).
 *
 * Progress is the number the portal shows — computed from the stage and the
 * client-visible milestones (src/lib/project-progress.ts), or the team's
 * manual override. The preview link is what the client can look at before
 * launch; Launch records the live address, stamps the date and moves the
 * stage to Delivered through the usual gates. The client note is the one
 * line the client reads first on their portal.
 */
export function SiteCard({
  projectId,
  progress,
  override,
  previewUrl,
  liveUrl,
  launchedAt,
  clientNote,
  clientNoteAt,
}: {
  projectId: string;
  progress: ProjectProgress;
  override: number | null;
  previewUrl: string | null;
  liveUrl: string | null;
  launchedAt: string | null;
  clientNote: string | null;
  clientNoteAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = React.useState(
    override === null ? "" : String(override),
  );
  const [preview, setPreview] = React.useState(previewUrl ?? "");
  const [live, setLive] = React.useState(liveUrl ?? "");
  const [note, setNote] = React.useState(clientNote ?? "");
  const [confirmLaunch, setConfirmLaunch] = React.useState(false);

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (res.ok) {
      toast.success(done);
      router.refresh();
    } else toast.error(res.error ?? "Something went wrong.");
  }

  async function launch() {
    setConfirmLaunch(false);
    setBusy("launch");
    const res = await launchProjectSite(projectId, { liveUrl: live });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (res.warning) toast.warning(res.warning, { duration: 8000 });
    else toast.success("Site launched 🚀 — stage moved to Delivered");
    router.refresh();
  }

  const percent = progress.percent;

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Website build</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            What the client sees on their portal.
          </p>
        </div>
        {liveUrl ? (
          <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">
            <Rocket className="h-3 w-3" /> Live
          </Badge>
        ) : (
          <Badge className="bg-primary-50 text-primary-600 ring-primary-200">
            {progress.bandLabel}
          </Badge>
        )}
      </div>

      {/* Progress */}
      <div className="mt-4">
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              percent >= 100 ? "bg-emerald-500" : "bg-primary-500",
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-1.5 flex items-center justify-between text-xs text-slate-400">
          <span className="font-semibold text-slate-700">{percent}% built</span>
          <span>
            {progress.source === "override"
              ? "set by the team"
              : progress.milestonesTotal
                ? `${progress.milestonesDone}/${progress.milestonesTotal} milestones · ${progress.bandLabel}`
                : `from the stage · add client-visible milestones to move it`}
          </span>
        </p>
        <div className="mt-2 flex items-center gap-1.5">
          <Input
            type="number"
            min={0}
            max={100}
            inputMode="numeric"
            value={overrideDraft}
            placeholder="auto"
            onChange={(e) => setOverrideDraft(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
            className="w-24"
          />
          <Button
            size="sm"
            variant="outline"
            loading={busy === "override"}
            onClick={() =>
              run(
                "override",
                () =>
                  setProgressOverride(
                    projectId,
                    overrideDraft.trim() === "" ? null : Number(overrideDraft),
                  ),
                overrideDraft.trim() === "" ? "Back to automatic progress" : "Progress set",
              )
            }
          >
            Set %
          </Button>
          {override !== null && (
            <button
              type="button"
              title="Back to automatic"
              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-primary-600"
              onClick={() => {
                setOverrideDraft("");
                void run("override", () => setProgressOverride(projectId, null), "Back to automatic progress");
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" /> auto
            </button>
          )}
        </div>
      </div>

      {/* Links */}
      <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
        <Field label="Preview link" hint="A staging address the client can look at before launch. Never one that carries a password.">
          <div className="flex gap-1.5">
            <Input
              value={preview}
              onChange={(e) => setPreview(e.target.value)}
              placeholder="https://preview.example.com"
            />
            <Button
              size="sm"
              variant="outline"
              loading={busy === "preview"}
              onClick={() =>
                run("preview", () => setSiteUrls(projectId, { previewUrl: preview }), "Preview link saved")
              }
            >
              Save
            </Button>
          </div>
        </Field>
        <Field
          label="Live site"
          hint={
            launchedAt
              ? `Launched ${format(new Date(launchedAt), "d MMM yyyy")}`
              : "Launching records the address and the date, and moves the stage to Delivered."
          }
        >
          <div className="flex gap-1.5">
            <Input
              value={live}
              onChange={(e) => setLive(e.target.value)}
              placeholder="https://www.client.lk"
            />
            {liveUrl ? (
              <Button
                size="sm"
                variant="outline"
                loading={busy === "live"}
                onClick={() =>
                  run("live", () => setSiteUrls(projectId, { liveUrl: live }), "Live address saved")
                }
              >
                Save
              </Button>
            ) : (
              <Button
                size="sm"
                loading={busy === "launch"}
                disabled={!live.trim()}
                onClick={() => setConfirmLaunch(true)}
              >
                <Rocket className="h-4 w-4" /> Launch
              </Button>
            )}
          </div>
        </Field>
        {(liveUrl || previewUrl) && (
          <a
            href={liveUrl || previewUrl || "#"}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 hover:underline"
          >
            <Globe className="h-3.5 w-3.5" />
            {liveUrl ? "Open the live site" : "Open the preview"}
            <ExternalLink className="h-3 w-3 opacity-60" />
          </a>
        )}
      </div>

      {/* Client note */}
      <div className="mt-4 border-t border-slate-100 pt-4">
        <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
          <Megaphone className="h-3.5 w-3.5 text-primary-500" /> Latest update for the client
        </p>
        <Field
          hint={
            clientNoteAt
              ? `Last updated ${format(new Date(clientNoteAt), "d MMM yyyy")} · shown at the top of their portal`
              : "One or two lines about what's happening now. Shown at the top of their portal."
          }
        >
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 600))}
            placeholder="Homepage design is in review — we'll share the preview link on Thursday."
          />
        </Field>
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            loading={busy === "note"}
            disabled={(note.trim() || "") === (clientNote ?? "")}
            onClick={() =>
              run("note", () => updateClientNote(projectId, note), note.trim() ? "Client update posted" : "Client update cleared")
            }
          >
            Update
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmLaunch}
        onClose={() => setConfirmLaunch(false)}
        title="Launch the site"
        description={`Record ${live.trim()} as live, stamp today as the launch date, and move the project to Delivered (the deposit and launch-checklist gates still apply).`}
        confirmLabel="Launch"
        onConfirm={launch}
      />
    </section>
  );
}
