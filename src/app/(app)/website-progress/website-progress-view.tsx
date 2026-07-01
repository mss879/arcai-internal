"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  ExternalLink,
  Globe,
  MoreVertical,
  Pencil,
  Rocket,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { WEBSITE_STATUS_META } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import type { Client, WebsiteProject } from "@/lib/types";

import { WebsiteFormModal } from "./website-form-modal";
import { deleteWebsiteProject, launchWebsiteProject } from "./actions";

type WebsiteCard = WebsiteProject & {
  client?: Pick<Client, "id" | "name" | "company"> | null;
};

/** Strip the scheme/trailing slash so the link reads cleanly on the card. */
function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export function WebsiteProgressView({
  sites,
  clients,
}: {
  sites: WebsiteCard[];
  clients: Pick<Client, "id" | "name" | "company">[];
}) {
  useRealtimeSyncTables(["website_projects"]);

  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<WebsiteProject | null>(null);
  const [toDelete, setToDelete] = React.useState<WebsiteProject | null>(null);
  const [toLaunch, setToLaunch] = React.useState<WebsiteProject | null>(null);

  const launchedCount = sites.filter((s) => s.status === "launched").length;
  const waitingCount = sites.filter((s) => s.status === "waiting_client").length;

  function launch(site: WebsiteProject) {
    startTransition(async () => {
      const res = await launchWebsiteProject(site.id);
      if (res.ok) {
        toast.success(`${site.name} is live 🚀`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
      setToLaunch(null);
    });
  }

  const renderCard = (s: WebsiteCard) => {
    const meta = WEBSITE_STATUS_META[s.status];
    const progress = Math.max(0, Math.min(100, Number(s.progress) || 0));
    const isLaunched = s.status === "launched";
    const isWaiting = s.status === "waiting_client";

    return (
      <div
        key={s.id}
        className={cn(
          "group relative flex flex-col rounded-2xl border bg-white p-5 shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-lift)]",
          isWaiting ? "border-amber-200/80" : "border-slate-200/80",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <Badge className={meta.badge}>{meta.label}</Badge>
          <Dropdown
            trigger={
              <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
                <MoreVertical className="h-4 w-4" />
              </button>
            }
          >
            <DropdownItem
              icon={<Pencil className="h-4 w-4" />}
              onClick={() => setEditing(s)}
            >
              Edit
            </DropdownItem>
            <DropdownItem
              destructive
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => setToDelete(s)}
            >
              Delete
            </DropdownItem>
          </Dropdown>
        </div>

        <div className="mt-3 flex-1">
          <h3 className="text-base font-semibold text-slate-900">{s.name}</h3>
          {s.client && (
            <p className="mt-0.5 text-sm text-slate-400">{s.client.name}</p>
          )}
          {s.url && (
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
            >
              <Globe className="h-4 w-4 shrink-0" />
              <span className="truncate">{prettyUrl(s.url)}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-60" />
            </a>
          )}
          {s.notes && (
            <p className="mt-2 line-clamp-2 text-sm text-slate-500">{s.notes}</p>
          )}
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium uppercase tracking-wide text-slate-400">
              Progress
            </span>
            <span className="font-semibold text-slate-700">{progress}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                isLaunched
                  ? "bg-emerald-500"
                  : isWaiting
                    ? "bg-amber-400"
                    : "bg-primary-500",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="mt-4">
          {isLaunched ? (
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                <Rocket className="h-4 w-4" /> Live
                {s.launched_at && (
                  <span className="text-slate-400">
                    · {format(new Date(s.launched_at), "d MMM yyyy")}
                  </span>
                )}
              </span>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" className="h-9 px-3">
                  Visit <ExternalLink className="h-4 w-4" />
                </Button>
              </a>
            </div>
          ) : (
            <Button
              className="w-full"
              onClick={() => setToLaunch(s)}
              disabled={pending}
            >
              <Rocket className="h-4 w-4" /> Launch site
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Website Progress"
        description="Track each client site — build progress, what you're waiting on, and launch when it goes live."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Globe className="h-4 w-4" /> Add website
          </Button>
        }
      />

      {sites.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { label: "Total sites", value: sites.length },
            { label: "Waiting on client", value: waitingCount },
            { label: "Launched", value: launchedCount },
          ].map((stat, i) => (
            <div
              key={stat.label}
              className="animate-continuous-float"
              style={{ animationDelay: `${i * 120}ms` }}
            >
              <div className="rounded-2xl border border-white/30 bg-gradient-to-br from-white/60 to-white/25 p-5 shadow-sm backdrop-blur-xl">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {stat.label}
                </p>
                <p className="mt-2 text-3xl font-extrabold tracking-tight text-slate-800">
                  {stat.value}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {sites.length === 0 ? (
        <EmptyState
          icon={<Globe className="h-6 w-6" />}
          title="No websites tracked yet"
          description="Add a client website to track its build progress and launch."
          action={
            <Button onClick={() => setCreating(true)}>
              <Globe className="h-4 w-4" /> Add website
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sites.map((s) => renderCard(s))}
        </div>
      )}

      <WebsiteFormModal
        open={creating || !!editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        site={editing}
        clients={clients}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete website"
        description={`Remove "${toDelete?.name}" from Website Progress?`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteWebsiteProject(toDelete.id);
          if (res.ok) {
            toast.success("Website removed");
            router.refresh();
          } else {
            toast.error(res.error);
          }
        }}
      />

      <ConfirmDialog
        open={!!toLaunch}
        onClose={() => setToLaunch(null)}
        title="Launch site"
        description={`Mark "${toLaunch?.name}" as live? This sets progress to 100% and stamps the launch date.`}
        confirmLabel="Launch"
        onConfirm={() => {
          if (toLaunch) launch(toLaunch);
        }}
      />
    </div>
  );
}
