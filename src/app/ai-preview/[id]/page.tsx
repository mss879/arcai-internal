import { notFound } from "next/navigation";
import Script from "next/script";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Widget preview", robots: { index: false } };

/**
 * A stand-in client page with the real widget on it (0126). Outside the
 * (app) group so it carries no sidebar, admin-only like the rest of the
 * module. `data-preview="1"` makes the chat route file everything said here
 * as preview — visible in analytics, never billed, never emailed.
 */
export default async function AiPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdmin();
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("ai_projects")
    .select("id, name, public_key, agent_name, website_url, primary_color")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  return (
    <main className="min-h-screen bg-slate-50 text-slate-800">
      <div className="mx-auto max-w-3xl px-6 py-14">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Preview · {project.name}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">A page on {project.website_url ?? "the client's website"}</h1>
        <p className="mt-4 text-slate-600">
          This is a stand-in for the client&apos;s site. The launcher in the corner is the real widget, loaded from this CRM
          exactly as it will be on their pages. Ask it something a visitor would.
        </p>
        <div className="mt-8 space-y-3">
          <div className="h-4 w-11/12 rounded bg-slate-200/80" />
          <div className="h-4 w-full rounded bg-slate-200/80" />
          <div className="h-4 w-4/5 rounded bg-slate-200/80" />
          <div className="mt-6 h-40 rounded-2xl bg-slate-200/60" />
          <div className="h-4 w-3/4 rounded bg-slate-200/80" />
          <div className="h-4 w-5/6 rounded bg-slate-200/80" />
        </div>
      </div>
      <Script src="/ai-widget.js" data-project={project.public_key} data-preview="1" data-open="1" strategy="afterInteractive" />
    </main>
  );
}
