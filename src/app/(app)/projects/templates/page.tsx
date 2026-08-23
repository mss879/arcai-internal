import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { TemplatesView } from "./templates-view";

export const metadata = { title: "Project templates" };

/**
 * The reusable plans behind a service type (PLAN-1).
 *
 * A template holds four kinds of item — the tasks the team does, the assets
 * the client has to send, the milestones they see, and the internal checks
 * before delivery — so "E-commerce Website" stops being a label and starts
 * being a plan that seeds itself.
 */
export default async function ProjectTemplatesPage() {
  const supabase = await createClient();

  const [, templatesRes, itemsRes] = await Promise.all([
    requireProfile(),
    supabase
      .from("project_templates")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase
      .from("project_template_items")
      .select("*")
      .order("position", { ascending: true }),
  ]);

  return (
    <TemplatesView
      templates={templatesRes.data ?? []}
      items={itemsRes.data ?? []}
    />
  );
}
