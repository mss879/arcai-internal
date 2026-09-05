"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Download, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import type { CarouselOption, CarouselPost, CarouselSlide } from "@/lib/types";

import {
  approveCarouselOption,
  listSocialAccounts,
  regenerateCarouselOption,
  scheduleSocialPost,
  sendForClientApproval,
} from "./actions";

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "carousel"
  );
}

/**
 * Bundle one design option into a ZIP: 01.png…N.png in posting order plus
 * caption.txt with the caption + hashtags — ready to upload as an
 * Instagram carousel. jszip is imported on demand so it never weighs down
 * the page bundle.
 */
async function downloadOptionZip(post: CarouselPost, option: CarouselOption) {
  const slides = ((option.slides ?? []) as CarouselSlide[]).filter(
    (s) => s.image_url,
  );
  if (!slides.length) {
    toast.error("No rendered slides to download yet.");
    return;
  }

  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();

  await Promise.all(
    slides.map(async (slide, i) => {
      const res = await fetch(slide.image_url as string);
      if (!res.ok) throw new Error(`Slide ${i + 1} failed to download.`);
      const ext = (slide.image_path ?? "").split(".").pop() || "png";
      zip.file(
        `${String(i + 1).padStart(2, "0")}.${ext}`,
        await res.blob(),
      );
    }),
  );

  const captionParts = [post.caption, (post.hashtags ?? []).join(" ")]
    .map((s) => s?.trim())
    .filter(Boolean);
  if (captionParts.length) {
    zip.file("caption.txt", captionParts.join("\n\n"));
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `carousel-${slugify(post.topic)}-design-${option.variant}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function CarouselReview({
  post,
  options,
  clients,
  onClose,
}: {
  post: CarouselPost;
  options: CarouselOption[];
  /** 0118 — who this could be for, and who it already is for. */
  clients: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [regenId, setRegenId] = React.useState<string | null>(null);

  const captionText = [post.caption, (post.hashtags ?? []).join(" ")]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join("\n\n");

  return (
    <Modal
      open
      onClose={onClose}
      title={post.topic}
      description="Compare the two designs, pick one, then send it to the client or schedule it."
      size="xl"
    >
      <div className="space-y-6">
        {options.map((option) => (
          <OptionCard
            key={option.id}
            post={post}
            option={option}
            chosen={post.chosen_option_id === option.id}
            onRegenerate={() => setRegenId(option.id)}
          />
        ))}

        {/* 0118 — the two things that used to happen outside this app:
            getting the client's yes, and actually posting it. */}
        <PublishBlock post={post} clients={clients} />

        {captionText && (
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Caption + hashtags
              </p>
              <CopyButton value={captionText} />
            </div>
            <p className="whitespace-pre-wrap text-sm text-slate-600">
              {captionText}
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(regenId)}
        onClose={() => setRegenId(null)}
        title="Re-render this design?"
        description="Its slides are re-generated from the same copy with fresh visuals. This uses Gemini credits."
        confirmLabel="Re-render"
        destructive={false}
        onConfirm={async () => {
          if (!regenId) return;
          const res = await regenerateCarouselOption(regenId);
          if (!res.ok) toast.error(res.error);
          else toast.success("Re-rendering — watch the slides fill back in.");
          router.refresh();
        }}
      />
    </Modal>
  );
}

function OptionCard({
  post,
  option,
  chosen,
  onRegenerate,
}: {
  post: CarouselPost;
  option: CarouselOption;
  chosen: boolean;
  onRegenerate: () => void;
}) {
  const router = useRouter();
  const [approving, setApproving] = React.useState(false);
  const [zipping, setZipping] = React.useState(false);

  const slides = (option.slides ?? []) as CarouselSlide[];
  const rendered = slides.filter((s) => s.image_url).length;
  const complete = rendered === slides.length && slides.length > 0;

  async function approve() {
    setApproving(true);
    try {
      const res = await approveCarouselOption(post.id, option.id);
      if (!res.ok) toast.error(res.error);
      else toast.success(`Design ${option.variant} approved.`);
      router.refresh();
    } finally {
      setApproving(false);
    }
  }

  async function download() {
    setZipping(true);
    try {
      await downloadOptionZip(post, option);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setZipping(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-2xl border p-4",
        chosen
          ? "border-emerald-300 bg-emerald-50/40 ring-2 ring-emerald-100"
          : "border-slate-200 bg-white",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800">
            Design {option.variant}
            {chosen && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                <Check className="h-3.5 w-3.5" /> Chosen
              </span>
            )}
          </p>
          {option.concept && (
            <p className="truncate text-xs text-slate-400" title={option.concept}>
              {option.concept}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onRegenerate}
            title="Re-render this design with fresh visuals"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Regenerate
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={download}
            loading={zipping}
            disabled={!complete}
            title={complete ? "Download all slides as a ZIP" : "Still rendering…"}
          >
            {!zipping && <Download className="h-3.5 w-3.5" />}
            Download ZIP
          </Button>
          <Button size="sm" onClick={approve} loading={approving} disabled={chosen}>
            {!approving && !chosen && <Check className="h-3.5 w-3.5" />}
            {chosen ? "Approved" : "Use this design"}
          </Button>
        </div>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {slides.map((slide) => (
          <div key={slide.index} className="w-40 shrink-0 sm:w-48">
            <div className="aspect-[4/5] overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              {slide.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={slide.image_url}
                  alt={slide.headline}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center">
                  <Loader2 className="h-4 w-4 animate-spin text-primary-400" />
                  <p className="text-[11px] font-medium leading-snug text-slate-400">
                    {slide.headline}
                  </p>
                </div>
              )}
            </div>
            <p className="mt-1 truncate text-center text-[11px] text-slate-400">
              {slide.index + 1}. {slide.headline}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Approval and publishing, in the order they actually happen.
 *
 * Both are deliberately gated on a chosen design: there is nothing to show a
 * client and nothing to post until somebody has picked one.
 */
function PublishBlock({
  post,
  clients,
}: {
  post: CarouselPost;
  clients: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [clientId, setClientId] = React.useState(post.client_id ?? "");
  const [accounts, setAccounts] = React.useState<
    { id: string; platform: string; name: string; clientId: string | null }[]
  >([]);
  const [chosenAccounts, setChosenAccounts] = React.useState<string[]>([]);
  const [when, setWhen] = React.useState(post.scheduled_for);
  const [busy, setBusy] = React.useState(false);
  const [link, setLink] = React.useState<string | null>(null);

  React.useEffect(() => {
    void listSocialAccounts().then(setAccounts);
  }, []);

  if (!post.chosen_option_id) {
    return (
      <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
        Pick a design above — then you can send it for approval or schedule it.
      </p>
    );
  }

  const approved = post.client_status === "approved";
  const blocked = Boolean(post.client_id) && !approved;

  async function send() {
    if (!clientId) return;
    setBusy(true);
    const res = await sendForClientApproval(post.id, clientId);
    setBusy(false);
    if (res.ok) {
      setLink(res.url);
      toast.success("Sent. The link is below — paste it into WhatsApp too.");
      router.refresh();
    } else toast.error(res.error);
  }

  async function schedule() {
    setBusy(true);
    const res = await scheduleSocialPost({
      postId: post.id,
      accountIds: chosenAccounts,
      scheduledFor: new Date(when).toISOString(),
    });
    setBusy(false);
    if (res.ok) {
      toast.success(`Queued for ${res.queued} account${res.queued === 1 ? "" : "s"}.`);
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      {/* --- Client approval --- */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Client approval
        </p>
        {approved ? (
          <p className="mt-1 text-sm font-medium text-emerald-600">
            Approved by the client.
          </p>
        ) : post.client_status === "changes_requested" ? (
          <p className="mt-1 text-sm text-amber-700">
            They asked for changes{post.client_feedback ? `: “${post.client_feedback}”` : "."}
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-500">
            {post.client_status === "sent"
              ? "Sent — waiting on them."
              : "Not sent yet."}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-700"
          >
            <option value="">No client — internal</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={send} disabled={!clientId || busy}>
            {post.client_status === "not_sent" ? "Send for approval" : "Send again"}
          </Button>
          {link && <CopyButton value={link} label="Copy the approval link" />}
        </div>
      </div>

      {/* --- Scheduling --- */}
      <div className="border-t border-slate-100 pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Publish
        </p>
        {accounts.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">
            No Instagram or Facebook account connected yet — the ZIP download
            above still works for posting by hand.
          </p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap gap-2">
              {accounts.map((a) => {
                const on = chosenAccounts.includes(a.id);
                return (
                  <button
                    key={a.id}
                    onClick={() =>
                      setChosenAccounts((prev) =>
                        on ? prev.filter((x) => x !== a.id) : [...prev, a.id],
                      )
                    }
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-medium transition",
                      on
                        ? "bg-primary-600 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                    )}
                  >
                    {a.platform === "instagram" ? "IG" : "FB"} · {a.name}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="datetime-local"
                value={when.length > 10 ? when.slice(0, 16) : `${when}T09:00`}
                onChange={(e) => setWhen(e.target.value)}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-700"
              />
              <Button
                size="sm"
                onClick={schedule}
                disabled={busy || blocked || chosenAccounts.length === 0}
              >
                Schedule it
              </Button>
            </div>
            {blocked && (
              <p className="mt-1 text-xs text-amber-600">
                Waiting on the client&apos;s approval — the publisher checks it
                again before it posts, so this stays off until they say yes.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
