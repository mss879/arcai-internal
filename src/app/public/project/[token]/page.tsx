import { notFound } from "next/navigation";
import { FolderCheck } from "lucide-react";

import { createAdminClient } from "@/lib/supabase/admin";
import { PortalClient } from "./portal-client";
import { Badge } from "@/components/ui/badge";
import { PROJECT_STATUS_META, SERVICE_TYPE_LABELS } from "@/lib/constants";
import type { ProjectDocumentRequest, ProjectStatus } from "@/lib/types";

export const metadata = {
  title: "Client Portal - ARC AI",
  description: "Secure workspace to share files and track your project timeline.",
};

export default async function PublicProjectPortal({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Use the admin client since this page is public/unauthenticated
  const supabase = createAdminClient();

  const [projectRes, docRequestsRes] = await Promise.all([
    (supabase as any)
      .from("projects")
      .select("*, client:clients(id, name, company)")
      .eq("share_token", token)
      .maybeSingle(),
    (supabase as any)
      .from("project_document_requests")
      .select("*")
      .order("created_at", { ascending: true }),
  ]);

  const project = projectRes.data;
  if (!project) notFound();

  // Filter requests that belong to this project
  const requests = ((docRequestsRes.data || []) as any[]).filter(
    (r) => r.project_id === project.id
  ) as ProjectDocumentRequest[];

  return (
    <div className="min-h-screen app-bg px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[900px] space-y-6">
        {/* Portal Header */}
        <div className="rounded-3xl border border-white/30 bg-white/70 p-6 shadow-lg backdrop-blur-xl saturate-150 animate-float-in">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <FolderCheck className="h-6 w-6 text-primary-500" />
                <h1 className="text-xl font-bold text-slate-800 tracking-tight sm:text-2xl">
                  Client Portal
                </h1>
              </div>
              <p className="text-sm text-slate-500 mt-1">
                Workspace for project <span className="font-bold text-slate-700">{project.name}</span>
              </p>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              {project.service_type && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">Service:</span>
                  <Badge className="bg-primary-50 text-primary-700 ring-primary-200 font-semibold">
                    {SERVICE_TYPE_LABELS[project.service_type] || project.service_type}
                  </Badge>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">Status:</span>
                <Badge className={PROJECT_STATUS_META[project.status as ProjectStatus].badge}>
                  {PROJECT_STATUS_META[project.status as ProjectStatus].label}
                </Badge>
              </div>
            </div>
          </div>

          {project.description && (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Project Description</h2>
              <p className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">{project.description}</p>
            </div>
          )}
        </div>

        {/* Portal Timeline and Financial Client Component */}
        <PortalClient
          token={token}
          project={project}
          initialRequests={requests}
        />
      </div>
    </div>
  );
}
