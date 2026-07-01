import { createClient } from "@/lib/supabase/server";
import { isGeminiConfigured } from "@/lib/ai/gemini";
import type { ContentGeneration, ContentReference } from "@/lib/types";

import { ContentView } from "./content-view";

export const metadata = { title: "Content Studio" };

export default async function ContentPage() {
  const supabase = await createClient();

  const [referencesRes, generationsRes] = await Promise.all([
    supabase
      .from("content_references")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase
      .from("content_generations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(120),
  ]);

  return (
    <ContentView
      references={(referencesRes.data ?? []) as ContentReference[]}
      generations={(generationsRes.data ?? []) as ContentGeneration[]}
      geminiReady={isGeminiConfigured()}
    />
  );
}
