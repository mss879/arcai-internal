import { createClient } from "@/lib/supabase/server";

import { ResourcesView } from "./resources-view";

export const metadata = { title: "Resources" };

/**
 * `?folder=<id>` opens that folder (0123). Absent means the top level, which
 * is where every resource saved before folders existed still sits.
 */
export default async function ResourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string }>;
}) {
  const supabase = await createClient();
  const params = await searchParams;
  const folderId = params.folder || null;

  const [foldersRes, resourcesRes, countsRes] = await Promise.all([
    supabase
      .from("resource_folders")
      .select("*")
      .order("name"),
    // Only what is in THIS folder — the whole point of opening one.
    (folderId
      ? supabase
          .from("resources")
          .select(
            "*, uploader:profiles!resources_uploaded_by_fkey(full_name, username, avatar_url)",
          )
          .eq("folder_id", folderId)
      : supabase
          .from("resources")
          .select(
            "*, uploader:profiles!resources_uploaded_by_fkey(full_name, username, avatar_url)",
          )
          .is("folder_id", null)
    ).order("created_at", { ascending: false }),
    // One column, every row: enough to put a count on each folder card
    // without a query per folder.
    supabase.from("resources").select("folder_id"),
  ]);

  const counts: Record<string, number> = {};
  for (const row of countsRes.data ?? []) {
    if (row.folder_id) counts[row.folder_id] = (counts[row.folder_id] ?? 0) + 1;
  }

  const folders = foldersRes.data ?? [];
  const current = folderId
    ? (folders.find((f) => f.id === folderId) ?? null)
    : null;

  return (
    <ResourcesView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resources={(resourcesRes.data ?? []) as any}
      folders={folders}
      counts={counts}
      currentFolder={current}
    />
  );
}
