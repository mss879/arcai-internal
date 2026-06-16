"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ExternalLink,
  FileText,
  FolderOpen,
  ImageIcon,
  Link2,
  MoreVertical,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { uploadFile } from "@/lib/upload";
import { cn, formatBytes } from "@/lib/utils";
import type { MemberLite, Resource } from "@/lib/types";

import { createResource, deleteResource } from "./actions";

type ResourceWithUploader = Resource & {
  uploader?: Pick<MemberLite, "full_name" | "username" | "avatar_url"> | null;
};

export function ResourcesView({
  resources,
}: {
  resources: ResourceWithUploader[];
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Resource | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Resources"
        description="Shared files and links for the whole workspace."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Add resource
          </Button>
        }
      />

      {resources.length === 0 ? (
        <EmptyState
          icon={<FolderOpen className="h-6 w-6" />}
          title="No resources yet"
          description="Upload a PDF or image, or share a link with the team."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add resource
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {resources.map((r) => {
            const isImage = r.file_type?.startsWith("image/");
            const href = r.kind === "link" ? r.link_url : r.file_url;
            return (
              <div
                key={r.id}
                className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-lift)]"
              >
                <div className="relative flex h-32 items-center justify-center bg-slate-50">
                  {isImage && r.file_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.file_url}
                      alt={r.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span
                      className={cn(
                        "grid h-14 w-14 place-items-center rounded-2xl",
                        r.kind === "link"
                          ? "bg-cyan-50 text-cyan-500"
                          : "bg-primary-50 text-primary-500",
                      )}
                    >
                      {r.kind === "link" ? (
                        <Link2 className="h-7 w-7" />
                      ) : isImage ? (
                        <ImageIcon className="h-7 w-7" />
                      ) : (
                        <FileText className="h-7 w-7" />
                      )}
                    </span>
                  )}
                  <Dropdown
                    className="absolute right-2 top-2"
                    trigger={
                      <button className="grid h-8 w-8 place-items-center rounded-lg bg-white/80 text-slate-500 opacity-0 backdrop-blur transition hover:text-slate-800 group-hover:opacity-100">
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    }
                  >
                    <DropdownItem
                      destructive
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setToDelete(r)}
                    >
                      Delete
                    </DropdownItem>
                  </Dropdown>
                </div>

                <div className="flex flex-1 flex-col p-4">
                  <h3 className="truncate font-medium text-slate-900">
                    {r.name}
                  </h3>
                  {r.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                      {r.description}
                    </p>
                  )}
                  <div className="mt-3 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-slate-400">
                      {r.uploader && (
                        <Avatar
                          name={r.uploader.full_name}
                          src={r.uploader.avatar_url}
                          size="xs"
                        />
                      )}
                      {r.kind === "file" ? formatBytes(r.file_size) : "Link"}
                    </span>
                    {href && (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
                      >
                        Open <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AddResourceModal open={adding} onClose={() => setAdding(false)} />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete resource"
        description={`Delete "${toDelete?.name}"?`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteResource(toDelete.id, toDelete.file_path);
          if (res.ok) {
            toast.success("Resource deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );
}

function AddResourceModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = React.useState<"file" | "link">("file");
  const [pending, setPending] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [linkUrl, setLinkUrl] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);

  React.useEffect(() => {
    if (open) {
      setTab("file");
      setName("");
      setDescription("");
      setLinkUrl("");
      setFile(null);
    }
  }, [open]);

  async function submit() {
    setPending(true);
    try {
      if (tab === "file") {
        if (!file) {
          toast.error("Choose a file to upload.");
          return;
        }
        const { path, publicUrl } = await uploadFile(
          STORAGE_BUCKETS.resources,
          file,
        );
        const res = await createResource({
          name: name.trim() || file.name,
          description,
          kind: "file",
          file_url: publicUrl,
          file_path: path,
          file_type: file.type,
          file_size: file.size,
        });
        if (!res.ok) return toast.error(res.error);
      } else {
        const res = await createResource({
          name: name.trim() || linkUrl,
          description,
          kind: "link",
          link_url: linkUrl,
        });
        if (!res.ok) return toast.error(res.error);
      }
      toast.success("Resource added");
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
      title="Add resource"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Add resource
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
          {(["file", "link"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-lg px-4 py-1.5 text-sm font-medium capitalize transition",
                tab === t
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500",
              )}
            >
              {t === "file" ? "Upload file" : "Add link"}
            </button>
          ))}
        </div>

        {tab === "file" ? (
          <Field label="File" required>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-slate-300 px-3.5 py-4 text-sm text-slate-500 hover:border-primary-300 hover:bg-primary-50/40">
              <Upload className="h-4 w-4" />
              {file ? file.name : "PDF, image or document"}
              <input
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f && !name) setName(f.name);
                }}
              />
            </label>
          </Field>
        ) : (
          <Field label="URL" required>
            <Input
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://…"
            />
          </Field>
        )}

        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
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
