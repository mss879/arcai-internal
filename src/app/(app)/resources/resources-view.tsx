"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronLeft,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  ImageIcon,
  Link2,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { uploadFile } from "@/lib/upload";
import { cn, formatBytes } from "@/lib/utils";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import type { MemberLite, Resource, ResourceFolder } from "@/lib/types";

import {
  createFolder,
  createResources,
  deleteFolder,
  deleteResource,
  moveResources,
  renameFolder,
} from "./actions";

/**
 * The Resources library (0123 added the folders).
 *
 * It was one flat grid of everything the workspace had ever uploaded, newest
 * first. Now a folder is a box you open — `?folder=<id>` on the URL, so the
 * server sends only that folder's contents and a shared link opens where the
 * sender was standing. One level deep on purpose.
 */

type ResourceWithUploader = Resource & {
  uploader?: Pick<MemberLite, "full_name" | "username" | "avatar_url"> | null;
};

export function ResourcesView({
  resources,
  folders,
  counts,
  currentFolder,
}: {
  resources: ResourceWithUploader[];
  folders: ResourceFolder[];
  /** Resource count per folder id, for the folder cards. */
  counts: Record<string, number>;
  currentFolder: ResourceFolder | null;
}) {
  useRealtimeSync("resources");
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [newFolder, setNewFolder] = React.useState(false);
  const [editFolder, setEditFolder] = React.useState<ResourceFolder | null>(null);
  const [folderToDelete, setFolderToDelete] = React.useState<ResourceFolder | null>(
    null,
  );
  const [toDelete, setToDelete] = React.useState<Resource | null>(null);
  const [toMove, setToMove] = React.useState<Resource | null>(null);

  /**
   * Bumped every time a form is opened, and used as its React key.
   *
   * The forms below seed their state straight from their props, so they need
   * to REMOUNT to reset — the alternative is an effect that writes six
   * setStates on open, which is a cascade of renders and leaves "New folder"
   * showing whatever the last folder was called. Keying on the target id
   * alone isn't enough: opening "New folder" twice running is the same key.
   * The key deliberately does not change on close, so the modal keeps its
   * contents while it animates out.
   */
  const [formKey, setFormKey] = React.useState(0);
  const openForm = (open: () => void) => {
    setFormKey((n) => n + 1);
    open();
  };

  const inFolder = Boolean(currentFolder);

  return (
    <div className="space-y-6">
      {inFolder && (
        <Link
          href="/resources"
          className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
        >
          <ChevronLeft className="h-4 w-4" /> All resources
        </Link>
      )}

      <PageHeader
        title={currentFolder ? currentFolder.name : "Resources"}
        description={
          currentFolder
            ? currentFolder.description ||
              "Files and links kept together in this folder."
            : "Shared files and links for the whole workspace."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!inFolder && (
              <Button variant="outline" onClick={() => openForm(() => setNewFolder(true))}>
                <FolderPlus className="h-4 w-4" /> New folder
              </Button>
            )}
            <Button onClick={() => openForm(() => setAdding(true))}>
              <Plus className="h-4 w-4" /> Add resource
            </Button>
          </div>
        }
      />

      {/* ---------- FOLDERS (top level only) ---------- */}
      {!inFolder && folders.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {folders.map((f) => (
            <div
              key={f.id}
              className="group relative rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-lift)]"
            >
              <Link
                href={`/resources?folder=${f.id}`}
                className="flex items-center gap-3 p-4"
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-500">
                  <Folder className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-900">
                    {f.name}
                  </span>
                  <span className="block text-xs text-slate-400">
                    {counts[f.id] ?? 0} {counts[f.id] === 1 ? "item" : "items"}
                  </span>
                </span>
              </Link>
              <Dropdown
                className="absolute right-2 top-2"
                trigger={
                  <button
                    aria-label={`Actions for ${f.name}`}
                    className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-800 group-hover:opacity-100"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                }
              >
                <DropdownItem
                  icon={<Pencil className="h-4 w-4" />}
                  onClick={() => openForm(() => setEditFolder(f))}
                >
                  Rename
                </DropdownItem>
                <DropdownItem
                  destructive
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={() => setFolderToDelete(f)}
                >
                  Delete
                </DropdownItem>
              </Dropdown>
            </div>
          ))}
        </div>
      )}

      {/* ---------- FILES & LINKS ---------- */}
      {resources.length === 0 ? (
        folders.length > 0 && !inFolder ? (
          <p className="text-sm text-slate-400">
            Nothing loose at the top level — everything is filed in a folder.
          </p>
        ) : (
          <EmptyState
            icon={<FolderOpen className="h-6 w-6" />}
            title={inFolder ? "This folder is empty" : "No resources yet"}
            description={
              inFolder
                ? "Add files or a link and they'll be kept in this folder."
                : "Upload a PDF or image, or share a link with the team."
            }
            action={
              <Button onClick={() => openForm(() => setAdding(true))}>
                <Plus className="h-4 w-4" /> Add resource
              </Button>
            }
          />
        )
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
                      icon={<Folder className="h-4 w-4" />}
                      onClick={() => openForm(() => setToMove(r))}
                    >
                      Move to folder
                    </DropdownItem>
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
                  <h3 className="truncate font-medium text-slate-900">{r.name}</h3>
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

      <AddResourceModal
        key={`add-${formKey}`}
        open={adding}
        folders={folders}
        currentFolderId={currentFolder?.id ?? null}
        onClose={() => setAdding(false)}
      />

      <FolderModal
        key={`folder-${formKey}`}
        open={newFolder || Boolean(editFolder)}
        folder={editFolder}
        onClose={() => {
          setNewFolder(false);
          setEditFolder(null);
        }}
      />

      <MoveModal
        key={`move-${formKey}`}
        resource={toMove}
        folders={folders}
        onClose={() => setToMove(null)}
      />

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

      <ConfirmDialog
        open={!!folderToDelete}
        onClose={() => setFolderToDelete(null)}
        title="Delete folder"
        // Says what actually happens: the box goes, the contents don't.
        description={
          folderToDelete
            ? `Delete "${folderToDelete.name}"? The ${counts[folderToDelete.id] ?? 0} item(s) inside are not deleted — they move back to the top level.`
            : undefined
        }
        confirmLabel="Delete folder"
        onConfirm={async () => {
          if (!folderToDelete) return;
          const res = await deleteFolder(folderToDelete.id);
          if (res.ok) {
            toast.success("Folder deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create / rename a folder                                             */
/* ------------------------------------------------------------------ */

function FolderModal({
  open,
  folder,
  onClose,
}: {
  open: boolean;
  folder: ResourceFolder | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = React.useState(folder?.name ?? "");
  const [description, setDescription] = React.useState(folder?.description ?? "");
  const [pending, setPending] = React.useState(false);

  async function submit() {
    setPending(true);
    const res = folder
      ? await renameFolder(folder.id, name, description)
      : await createFolder(name, description);
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(folder ? "Folder renamed" : "Folder created");
    router.refresh();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={folder ? "Rename folder" : "New folder"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {folder ? "Save" : "Create folder"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Folder name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Brand assets"
            autoFocus
          />
        </Field>
        <Field label="Description">
          <Textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What belongs in here"
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Move one resource                                                    */
/* ------------------------------------------------------------------ */

function MoveModal({
  resource,
  folders,
  onClose,
}: {
  resource: Resource | null;
  folders: ResourceFolder[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [target, setTarget] = React.useState(resource?.folder_id ?? "");
  const [pending, setPending] = React.useState(false);

  async function submit() {
    if (!resource) return;
    setPending(true);
    const res = await moveResources([resource.id], target || null);
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(
      target
        ? `Moved to ${folders.find((f) => f.id === target)?.name ?? "folder"}`
        : "Moved to the top level",
    );
    router.refresh();
    onClose();
  }

  return (
    <Modal
      open={Boolean(resource)}
      onClose={onClose}
      title="Move to folder"
      description={resource ? `Where should "${resource.name}" live?` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Move
          </Button>
        </>
      }
    >
      <Field label="Folder">
        <Select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Top level (no folder)</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Add files or a link                                                  */
/* ------------------------------------------------------------------ */

function AddResourceModal({
  open,
  folders,
  currentFolderId,
  onClose,
}: {
  open: boolean;
  folders: ResourceFolder[];
  currentFolderId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = React.useState<"file" | "link">("file");
  const [pending, setPending] = React.useState(false);
  /** "Uploading 3 of 12…" — a twelve-file drop is not an instant operation. */
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(
    null,
  );
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [linkUrl, setLinkUrl] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  // Opened from inside a folder: that's where these are going.
  const [folderId, setFolderId] = React.useState<string>(currentFolderId ?? "");

  /** Add to the selection rather than replacing it, so a second Choose files
   * adds more instead of quietly discarding what was already picked. */
  function addFiles(picked: FileList | null) {
    if (!picked?.length) return;
    const next = Array.from(picked);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...next.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
    if (next.length === 1 && !name) setName(next[0].name);
  }

  async function submit() {
    setPending(true);
    try {
      if (tab === "file") {
        if (!files.length) {
          toast.error("Choose at least one file to upload.");
          return;
        }
        setProgress({ done: 0, total: files.length });
        const inputs = [];
        for (const [i, file] of files.entries()) {
          const { path, publicUrl } = await uploadFile(
            STORAGE_BUCKETS.resources,
            file,
          );
          inputs.push({
            // One file may be renamed; a batch keeps its own filenames,
            // because one name across twelve rows helps nobody.
            name: files.length === 1 ? name.trim() || file.name : file.name,
            description,
            kind: "file" as const,
            file_url: publicUrl,
            file_path: path,
            file_type: file.type,
            file_size: file.size,
            folder_id: folderId || null,
          });
          setProgress({ done: i + 1, total: files.length });
        }
        const res = await createResources(inputs);
        if (!res.ok) return toast.error(res.error);
        toast.success(
          files.length === 1 ? "Resource added" : `${files.length} files added`,
        );
      } else {
        const res = await createResources([
          {
            name: name.trim() || linkUrl,
            description,
            kind: "link",
            link_url: linkUrl,
            folder_id: folderId || null,
          },
        ]);
        if (!res.ok) return toast.error(res.error);
        toast.success("Resource added");
      }
      router.refresh();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setPending(false);
      setProgress(null);
    }
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);

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
            {progress
              ? `Uploading ${progress.done} of ${progress.total}…`
              : tab === "file" && files.length > 1
                ? `Add ${files.length} files`
                : "Add resource"}
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
                tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
              )}
            >
              {t === "file" ? "Upload files" : "Add link"}
            </button>
          ))}
        </div>

        {tab === "file" ? (
          <Field
            label="Files"
            required
            hint="Pick as many as you like — they all land in the same folder."
          >
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-slate-300 px-3.5 py-4 text-sm text-slate-500 hover:border-primary-300 hover:bg-primary-50/40">
              <Upload className="h-4 w-4" />
              {files.length === 0
                ? "PDFs, images or documents"
                : `Add more — ${files.length} selected (${formatBytes(totalBytes)})`}
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files);
                  // Clear, so picking the same file twice still fires onChange.
                  e.target.value = "";
                }}
              />
            </label>
            {files.length > 0 && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {files.map((f, i) => (
                  <li
                    key={`${f.name}:${f.size}`}
                    className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600"
                  >
                    <span className="truncate">{f.name}</span>
                    <span className="flex shrink-0 items-center gap-2 text-slate-400">
                      {formatBytes(f.size)}
                      <button
                        type="button"
                        aria-label={`Remove ${f.name}`}
                        disabled={pending}
                        onClick={() =>
                          setFiles((prev) => prev.filter((_, j) => j !== i))
                        }
                        className="rounded p-0.5 transition-colors hover:bg-slate-200 hover:text-slate-700"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
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

        <Field label="Folder">
          <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">Top level (no folder)</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>

        {/* A single name for a batch would just be twelve identical rows. */}
        {(tab === "link" || files.length <= 1) && (
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <Field
          label="Description"
          hint={
            files.length > 1 ? "Applied to all of the files above." : undefined
          }
        >
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
