"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CarouselOption, CarouselPost, CarouselSlide } from "@/lib/types";

import { createCarouselPost, deleteCarouselPost, generateCarouselNow } from "./actions";
import { CarouselReview } from "./carousel-review";
import { useDriveCarousels } from "./use-drive-carousels";

/** yyyy-mm-dd for <input type="date"> defaults (local, not UTC). */
function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slideProgress(options: CarouselOption[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const option of options) {
    const slides = (option.slides ?? []) as CarouselSlide[];
    total += slides.length;
    done += slides.filter((s) => s.image_url).length;
  }
  return { done, total };
}

export function CalendarTab({
  posts,
  options,
  carouselReady,
}: {
  posts: CarouselPost[];
  options: CarouselOption[];
  carouselReady: boolean;
}) {
  const router = useRouter();

  const optionsByPost = React.useMemo(() => {
    const map = new Map<string, CarouselOption[]>();
    for (const option of options) {
      const list = map.get(option.post_id) ?? [];
      list.push(option);
      map.set(option.post_id, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.variant - b.variant);
    return map;
  }, [options]);

  // Keep in-progress posts moving while the page is open (local-dev cron
  // substitute; production also has the minute-tick).
  const generating = posts.some(
    (p) => p.status === "copywriting" || p.status === "rendering",
  );
  useDriveCarousels(generating);

  // ---- Add form ----
  const [topic, setTopic] = React.useState("");
  const [date, setDate] = React.useState(() =>
    toDateInput(new Date(Date.now() + 7 * 86_400_000)),
  );
  const [notes, setNotes] = React.useState("");
  const [adding, setAdding] = React.useState(false);

  async function add() {
    if (!topic.trim()) {
      toast.error("What should the carousel be about?");
      return;
    }
    setAdding(true);
    try {
      const res = await createCarouselPost({
        topic,
        scheduled_for: date,
        notes,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setTopic("");
      setNotes("");
      toast.success("Added to the calendar — designs will be ready 3 days before the post date.");
      router.refresh();
    } finally {
      setAdding(false);
    }
  }

  // ---- Review modal + delete confirm ----
  const [reviewId, setReviewId] = React.useState<string | null>(null);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);

  const reviewPost = posts.find((p) => p.id === reviewId) ?? null;

  const today = toDateInput(new Date());
  const upcoming = posts
    .filter((p) => p.scheduled_for >= today)
    .sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
  const earlier = posts
    .filter((p) => p.scheduled_for < today)
    .sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for));

  return (
    <div className="space-y-6">
      {!carouselReady && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Carousel generation needs both{" "}
            <code className="font-mono text-xs">OPENAI_API_KEY</code> (copy) and{" "}
            <code className="font-mono text-xs">GEMINI_API_KEY</code> (designs)
            in your environment.
          </span>
        </div>
      )}

      {/* ---- Plan a carousel ---- */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-primary-500" />
          <h2 className="text-sm font-semibold text-slate-800">
            Plan a carousel
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_170px]">
          <Field label="Topic" required>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. 5 signs your business website is losing you customers"
              disabled={adding}
            />
          </Field>
          <Field label="Post date" required>
            <Input
              type="date"
              value={date}
              min={today}
              onChange={(e) => setDate(e.target.value)}
              disabled={adding}
            />
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Notes for the AI (optional)">
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Angle, audience, offer to mention, things to avoid…"
              disabled={adding}
            />
          </Field>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-400">
            2 design options are generated automatically 3 days before the post
            date — or hit Generate now on any topic.
          </p>
          <Button onClick={add} loading={adding}>
            {!adding && <Plus className="h-4 w-4" />}
            Add to calendar
          </Button>
        </div>
      </div>

      {/* ---- Posts ---- */}
      {posts.length === 0 ? (
        <div className="grid min-h-[220px] place-items-center rounded-2xl border border-dashed border-slate-200 bg-white/60 text-center">
          <div className="flex flex-col items-center gap-2 px-6 text-slate-400">
            <CalendarDays className="h-8 w-8 text-primary-300" />
            <p className="text-sm font-medium text-slate-500">
              No carousels planned yet.
            </p>
            <p className="text-xs">
              Type a topic and a post date above — the designs will be waiting
              for you.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <PostSection
            title="Upcoming"
            posts={upcoming}
            optionsByPost={optionsByPost}
            carouselReady={carouselReady}
            onReview={setReviewId}
            onDelete={setDeleteId}
          />
          <PostSection
            title="Earlier"
            posts={earlier}
            optionsByPost={optionsByPost}
            carouselReady={carouselReady}
            onReview={setReviewId}
            onDelete={setDeleteId}
          />
        </div>
      )}

      {reviewPost && (
        <CarouselReview
          post={reviewPost}
          options={optionsByPost.get(reviewPost.id) ?? []}
          onClose={() => setReviewId(null)}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteId)}
        onClose={() => setDeleteId(null)}
        title="Delete this carousel?"
        description="The topic, both design options and every rendered slide will be removed."
        onConfirm={async () => {
          if (!deleteId) return;
          const res = await deleteCarouselPost(deleteId);
          if (!res.ok) toast.error(res.error);
          else toast.success("Carousel deleted.");
          router.refresh();
        }}
      />
    </div>
  );
}

function PostSection({
  title,
  posts,
  optionsByPost,
  carouselReady,
  onReview,
  onDelete,
}: {
  title: string;
  posts: CarouselPost[];
  optionsByPost: Map<string, CarouselOption[]>;
  carouselReady: boolean;
  onReview: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (posts.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </h3>
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
        {posts.map((post, i) => (
          <PostRow
            key={post.id}
            post={post}
            options={optionsByPost.get(post.id) ?? []}
            carouselReady={carouselReady}
            first={i === 0}
            onReview={() => onReview(post.id)}
            onDelete={() => onDelete(post.id)}
          />
        ))}
      </div>
    </div>
  );
}

function PostRow({
  post,
  options,
  carouselReady,
  first,
  onReview,
  onDelete,
}: {
  post: CarouselPost;
  options: CarouselOption[];
  carouselReady: boolean;
  first: boolean;
  onReview: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [starting, setStarting] = React.useState(false);

  async function start() {
    setStarting(true);
    try {
      const res = await generateCarouselNow(post.id);
      if (!res.ok) toast.error(res.error);
      else toast.success("Generating — the designs land here when ready.");
      router.refresh();
    } finally {
      setStarting(false);
    }
  }

  const generating =
    post.status === "copywriting" || post.status === "rendering";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5",
        !first && "border-t border-slate-100",
      )}
    >
      <div className="w-20 shrink-0 text-center">
        <p className="text-[11px] font-semibold uppercase text-slate-400">
          {format(new Date(`${post.scheduled_for}T00:00:00`), "EEE")}
        </p>
        <p className="text-sm font-bold text-slate-800">
          {format(new Date(`${post.scheduled_for}T00:00:00`), "MMM d")}
        </p>
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-800">
          {post.topic}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <StatusChip post={post} options={options} />
          {post.status === "error" && post.error && (
            <span className="truncate text-xs text-rose-500" title={post.error}>
              {post.error}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {post.status === "planned" && (
          <Button
            size="sm"
            variant="outline"
            onClick={start}
            loading={starting}
            disabled={!carouselReady}
          >
            {!starting && <Sparkles className="h-3.5 w-3.5" />}
            Generate now
          </Button>
        )}
        {post.status === "error" && (
          <Button size="sm" variant="outline" onClick={start} loading={starting}>
            Retry
          </Button>
        )}
        {generating && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-500" />
            Working…
          </span>
        )}
        {(post.status === "ready" || post.status === "approved") && (
          <Button size="sm" onClick={onReview}>
            {post.status === "ready" ? "Review designs" : "View design"}
          </Button>
        )}
        <button
          onClick={onDelete}
          className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
          aria-label="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function StatusChip({
  post,
  options,
}: {
  post: CarouselPost;
  options: CarouselOption[];
}) {
  if (post.status === "planned") {
    return <Badge dot="bg-slate-400">Planned</Badge>;
  }
  if (post.status === "copywriting") {
    return (
      <Badge className="bg-sky-50 text-sky-700 ring-sky-200" dot="bg-sky-500">
        Writing copy…
      </Badge>
    );
  }
  if (post.status === "rendering") {
    const { done, total } = slideProgress(options);
    return (
      <Badge
        className="bg-amber-50 text-amber-700 ring-amber-200"
        dot="bg-amber-500"
      >
        Designing {total > 0 ? `${done}/${total} slides` : "…"}
      </Badge>
    );
  }
  if (post.status === "ready") {
    return (
      <Badge
        className="bg-emerald-50 text-emerald-700 ring-emerald-200"
        dot="bg-emerald-500"
      >
        2 designs ready
      </Badge>
    );
  }
  if (post.status === "approved") {
    return (
      <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
        <Check className="h-3 w-3" /> Approved
      </Badge>
    );
  }
  return (
    <Badge className="bg-rose-50 text-rose-600 ring-rose-200" dot="bg-rose-500">
      Failed
    </Badge>
  );
}
