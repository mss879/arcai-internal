"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Images, Plus, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import type { ContentReference } from "@/lib/types";

import { addReference, deleteReference } from "./actions";

export function ReferencesTab({
  references,
}: {
  references: ContentReference[];
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<ContentReference | null>(null);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-slate-500">
          Upload designs, brand assets or style examples once. Every generation
          in the <span className="font-medium text-slate-700">Generate</span>{" "}
          tab is automatically guided by these references.
        </p>
        <Button onClick={() => setAdding(true)} className="shrink-0">
          <Plus className="h-4 w-4" /> Add reference
        </Button>
      </div>

      {references.length === 0 ? (
        <EmptyState
          icon={<Images className="h-6 w-6" />}
          title="No references yet"
          description="Add brand designs or style examples so generations match your look."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add reference
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {references.map((r) => (
            <div
              key={r.id}
              className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-lift)]"
            >
              <div className="relative aspect-square bg-slate-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.image_url}
                  alt={r.name || "Reference"}
                  className="h-full w-full object-cover"
                />
                <button
                  onClick={() => setToDelete(r)}
                  aria-label="Delete reference"
                  className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-lg bg-white/85 text-slate-500 opacity-0 backdrop-blur transition hover:text-rose-600 group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {(r.name || r.description) && (
                <div className="p-3">
                  {r.name && (
                    <h3 className="truncate text-sm font-medium text-slate-900">
                      {r.name}
                    </h3>
                  )}
                  {r.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                      {r.description}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <AddReferenceModal open={adding} onClose={() => setAdding(false)} />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete reference"
        description={`Remove "${toDelete?.name || "this reference"}" from your library?`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteReference(toDelete.id, toDelete.image_path);
          if (res.ok) {
            toast.success("Reference deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );
}

function AddReferenceModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setFile(null);
      setPreview(null);
    }
  }, [open]);

  React.useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function submit() {
    if (!file) {
      toast.error("Choose an image to upload.");
      return;
    }
    if (!file.type.startsWith("image/")) {
      toast.error("References must be image files.");
      return;
    }
    setPending(true);
    try {
      const { path, publicUrl } = await uploadFile(
        STORAGE_BUCKETS.contentReferences,
        file,
      );
      const res = await addReference({
        name: name.trim() || file.name,
        description,
        image_url: publicUrl,
        image_path: path,
        mime_type: file.type,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Reference added");
      router.refresh();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add reference"
      description="Upload a design or style example to guide generations."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Add reference
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Image" required>
          <label
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 px-3.5 py-6 text-sm text-slate-500 hover:border-primary-300 hover:bg-primary-50/40",
              preview && "py-3",
            )}
          >
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt="Preview"
                className="max-h-44 rounded-lg object-contain"
              />
            ) : (
              <>
                <Upload className="h-5 w-5" />
                <span>PNG, JPG or WebP</span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !name) setName(f.name.replace(/\.[^.]+$/, ""));
              }}
            />
          </label>
        </Field>

        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Brand gradient style"
          />
        </Field>
        <Field label="Notes" hint="Optional — what this reference is for.">
          <Textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
