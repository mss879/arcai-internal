"use client";

/**
 * Named filter sets, pinned above the board (VIEW-2).
 *
 * "My active builds", "Unpaid deliveries", "Everything at risk" — the three
 * questions that get asked every day and currently have to be re-assembled
 * from six dropdowns each time.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bookmark, BookmarkPlus, Globe, Lock, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";

import {
  deleteProjectView,
  saveProjectView,
  type SavedViewFilters,
} from "@/app/(app)/projects/view-actions";

export type SavedViewRow = {
  id: string;
  name: string;
  filters: SavedViewFilters;
  owner_id: string | null;
  shared: boolean;
};

export function SavedViewsBar({
  views,
  current,
  activeId,
  canSave,
  onApply,
  onClear,
}: {
  views: SavedViewRow[];
  /** The board's live filter state, saved as-is. */
  current: SavedViewFilters;
  /** Which saved view the board is currently showing, if any. */
  activeId: string | null;
  /** False when no filter is set — there'd be nothing to save. */
  canSave: boolean;
  onApply: (view: SavedViewRow) => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [naming, setNaming] = React.useState(false);
  const [name, setName] = React.useState("");
  const [shared, setShared] = React.useState(true);

  async function handleSave() {
    if (!name.trim()) {
      toast.error("Give the view a name.");
      return;
    }
    setSaving(true);
    const res = await saveProjectView({ name, filters: current, shared });
    setSaving(false);
    if (res.ok) {
      toast.success(`Saved "${name.trim()}".`);
      setNaming(false);
      setName("");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function handleDelete(view: SavedViewRow) {
    const res = await deleteProjectView(view.id);
    if (res.ok) {
      if (activeId === view.id) onClear();
      toast.success(`Deleted "${view.name}".`);
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  if (views.length === 0 && !canSave) return null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {views.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <Bookmark className="h-3.5 w-3.5" />
            Views
          </span>
        )}

        {views.map((view) => {
          const active = activeId === view.id;
          return (
            <span
              key={view.id}
              className={cn(
                "group inline-flex items-center gap-1 rounded-full py-1 pl-3 pr-1 text-sm font-medium ring-1 transition",
                active
                  ? "bg-primary-600 text-white ring-primary-600"
                  : "bg-white text-slate-600 ring-slate-200 hover:ring-primary-300",
              )}
            >
              <button
                type="button"
                onClick={() => (active ? onClear() : onApply(view))}
                className="inline-flex items-center gap-1.5"
                title={active ? "Showing this view — click to clear" : "Apply this view"}
              >
                {view.shared ? (
                  <Globe className={cn("h-3 w-3", active ? "opacity-80" : "text-slate-400")} />
                ) : (
                  <Lock className={cn("h-3 w-3", active ? "opacity-80" : "text-slate-400")} />
                )}
                {view.name}
              </button>
              <button
                type="button"
                onClick={() => handleDelete(view)}
                aria-label={`Delete view ${view.name}`}
                title="Delete this view"
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-full opacity-0 transition group-hover:opacity-100",
                  active ? "hover:bg-white/20" : "hover:bg-slate-100",
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}

        {canSave && (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-slate-300 px-3 py-1 text-sm font-medium text-slate-500 transition hover:border-primary-400 hover:text-primary-600"
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
            Save these filters
          </button>
        )}
      </div>

      <Modal
        open={naming}
        onClose={() => setNaming(false)}
        title="Save this view"
        description="The filters and sort on screen right now, under a name you can come back to."
      >
        <div className="space-y-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Everything at risk"
            maxLength={60}
            autoFocus
          />

          <label className="flex items-start gap-2.5 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-primary-600"
            />
            <span>
              <span className="font-medium text-slate-800">Share with the team</span>
              <span className="mt-0.5 block text-xs text-slate-400">
                On by default — a view like &ldquo;Everything at risk&rdquo; is
                only useful if everyone is looking at the same list. Turn it off
                for a view that&apos;s only about your own work.
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setNaming(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              Save view
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
