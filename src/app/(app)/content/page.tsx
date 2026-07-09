import { createClient } from "@/lib/supabase/server";
import { isGeminiConfigured } from "@/lib/ai/gemini";
import { isCarouselConfigured } from "@/lib/carousels";
import type {
  CarouselOption,
  CarouselPost,
  ContentGeneration,
  ContentReference,
} from "@/lib/types";

import { ContentView } from "./content-view";

export const metadata = { title: "Content Studio" };

export default async function ContentPage() {
  const supabase = await createClient();

  const [referencesRes, generationsRes, postsRes, optionsRes] =
    await Promise.all([
      supabase
        .from("content_references")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("content_generations")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(120),
      supabase
        .from("carousel_posts")
        .select("*")
        .order("scheduled_for", { ascending: true })
        .limit(120),
      supabase
        .from("carousel_options")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(240),
    ]);

  return (
    <ContentView
      references={(referencesRes.data ?? []) as ContentReference[]}
      generations={(generationsRes.data ?? []) as ContentGeneration[]}
      carouselPosts={(postsRes.data ?? []) as CarouselPost[]}
      carouselOptions={(optionsRes.data ?? []) as CarouselOption[]}
      geminiReady={isGeminiConfigured()}
      carouselReady={isCarouselConfigured()}
    />
  );
}
