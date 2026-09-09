import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isGeminiConfigured } from "@/lib/ai/gemini";
import { isCarouselConfigured } from "@/lib/carousels";
import { loadOfficeSnapshot } from "@/lib/agents/snapshot";
import { loadPriceCatalog } from "@/lib/ai-projects/usage";
import { selectableModels } from "@/lib/ai-projects/pricing-core";
import { colomboDay } from "@/lib/ai-projects/time-core";
import type {
  CarouselOption,
  CarouselPost,
  ContentGeneration,
  ContentReference,
} from "@/lib/types";

import { ContentView } from "./content-view";
import type { SocialPostRow } from "./publishing-tab";
import { requireCapability } from "@/lib/auth";

export const metadata = { title: "Content Office" };

export default async function ContentPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string; mission?: string }>;
}) {
  // T5.2 — marketing; hidden from the menu without it, refused once enforced.
  const profile = await requireCapability("marketing");
  // T5.1 — a settings-hub card can open a specific tab; 0130 — a notification
  // or the approvals list can open a mission.
  const { tab: initialTab, mission: missionParam } = (await searchParams) ?? {};
  const initialMissionId = missionParam && /^[0-9a-f-]{36}$/i.test(missionParam) ? missionParam : null;
  const supabase = await createClient();
  // 0130 — the office's own tables and the model catalog are read on the
  // service role: members may read the runs (RLS says so) but the catalog
  // and the spend ledger are admin tables.
  const admin = createAdminClient();
  const isAdmin = profile.role === "admin";

  const [
    referencesRes,
    generationsRes,
    postsRes,
    optionsRes,
    clientsRes,
    socialRes,
    accountsRes,
    office,
    catalog,
  ] = await Promise.all([
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
      // 0118 — for the client picker and the approval link.
      supabase.from("clients").select("id, name").order("name").limit(500),
      // 0118 — the publish queue. Tolerates the table being absent.
      supabase
        .from("social_posts")
        .select(
          "id, platform, account_id, carousel_post_id, caption, media, scheduled_for, status, permalink, error, attempts",
        )
        .order("scheduled_for", { ascending: false })
        .limit(100)
        .then((r) => r, () => ({ data: null })),
      // Names only. Members can't read this table (admin RLS) and simply
      // see the platform instead.
      supabase
        .from("social_accounts")
        .select("id, name")
        .then((r) => r, () => ({ data: null })),
      loadOfficeSnapshot(admin, {
        isAdmin,
        missionId: initialMissionId,
        dryRun: process.env.SOCIAL_DRY_RUN === "1",
      }),
      loadPriceCatalog(admin).catch(() => []),
    ]);

  const accountName = new Map(
    (accountsRes.data ?? []).map((a) => [a.id, a.name] as const),
  );
  const topicById = new Map(
    (postsRes.data ?? []).map((p) => [p.id, p.topic] as const),
  );
  const socialPosts: SocialPostRow[] = (socialRes.data ?? []).map((p) => ({
    id: p.id,
    platform: p.platform,
    accountName: p.account_id ? (accountName.get(p.account_id) ?? null) : null,
    topic: p.carousel_post_id ? (topicById.get(p.carousel_post_id) ?? null) : null,
    caption: p.caption,
    mediaCount: Array.isArray(p.media) ? p.media.length : 0,
    scheduledFor: p.scheduled_for,
    status: p.status,
    permalink: p.permalink,
    error: p.error,
    attempts: p.attempts,
  }));

  const models = selectableModels(catalog, colomboDay()).map((m) => ({
    model: m.model,
    inputPerM: m.quote.inputPerM,
    outputPerM: m.quote.outputPerM,
  }));

  return (
    <ContentView
      initialTab={initialTab}
      initialMissionId={initialMissionId}
      office={office}
      models={models}
      viewerName={(profile.full_name ?? "").trim().split(/\s+/)[0] || "You"}
      references={(referencesRes.data ?? []) as ContentReference[]}
      generations={(generationsRes.data ?? []) as ContentGeneration[]}
      carouselPosts={(postsRes.data ?? []) as CarouselPost[]}
      carouselOptions={(optionsRes.data ?? []) as CarouselOption[]}
      clients={clientsRes.data ?? []}
      socialPosts={socialPosts}
      socialDryRun={process.env.SOCIAL_DRY_RUN === "1"}
      geminiReady={isGeminiConfigured()}
      carouselReady={isCarouselConfigured()}
    />
  );
}
