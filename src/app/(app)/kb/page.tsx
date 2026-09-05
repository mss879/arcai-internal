import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { KbView, type KbPageRow } from "./kb-view";

export const metadata = { title: "Knowledge" };

export default async function KbPage() {
  await requireProfile();
  const supabase = await createClient();

  const { data } = await supabase
    .from("kb_pages")
    .select("id, slug, title, body_md, category, tags, visibility, updated_at")
    .order("category")
    .order("title")
    .limit(500);

  return <KbView pages={(data ?? []) as KbPageRow[]} />;
}
