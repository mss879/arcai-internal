import { createClient } from "@/lib/supabase/client";

/** Upload a file to a storage bucket from the browser. */
export async function uploadFile(
  bucket: string,
  file: File,
  prefix = "",
): Promise<{ path: string; publicUrl: string }> {
  const supabase = createClient();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${prefix ? `${prefix}/` : ""}${crypto.randomUUID()}-${safeName}`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, file, { upsert: false, cacheControl: "3600" });
  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return { path, publicUrl: data.publicUrl };
}
