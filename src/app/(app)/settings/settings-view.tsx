"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUpRight,
  BadgeDollarSign,
  Bot,
  Hash,
  Inbox,
  KanbanSquare,
  KeyRound,
  Mail,
  MessageCircle,
  PackageCheck,
  Plug,
  ShieldCheck,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Target,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import type { SocialPlatform } from "@/lib/database.types";
import { cn } from "@/lib/utils";

import {
  connectSocialAccount,
  deleteSocialAccount,
  saveAppSetting,
  setNextDocumentNumber,
  setSocialAccountActive,
} from "./actions";

export type SettingsData = {
  leadForm: { pipelineId: string; stageId: string };
  outreach: { enabled: boolean; fromEmail: string };
  chatAutoLead: boolean;
  /** T5.2 — whether pages and money actions refuse a member without the tick. */
  capabilitiesEnforced: boolean;
  pipelines: { id: string; name: string }[];
  stages: { id: string; name: string; pipelineId: string }[];
  social: {
    /** SOCIAL_TOKEN_KEY is set, so a token can be stored. */
    configured: boolean;
    accounts: {
      id: string;
      platform: SocialPlatform;
      name: string;
      externalId: string;
      pageId: string | null;
      clientId: string | null;
      active: boolean;
      tokenExpiresAt: string | null;
    }[];
  };
  counters: {
    kind: string;
    prefix: string;
    width: number;
    suffix: string;
    last: number;
    yearly: boolean;
    updatedAt: string;
  }[];
  handoff: { userId: string | null; name: string | null };
  counts: { emailTemplates: number; apiKeys: number; webhooks: number; members: number };
  clients: { id: string; name: string }[];
};

/**
 * The settings hub (T5.1).
 *
 * Two kinds of thing on one page, kept visually apart: CARDS that go to a
 * settings surface that already exists inside its module, and FORMS for the
 * few switches that never had a screen. A card never duplicates a form —
 * if the setting has a home, the card sends you there.
 */
export function SettingsView({ data }: { data: SettingsData }) {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Every switch in the workspace, from one page — the ones that live inside a module link there."
      />

      <section>
        <h2 className="mb-3 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Where each setting lives
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <SettingsCard
            href="/crm/settings"
            icon={<KanbanSquare className="h-4 w-4" />}
            title="CRM settings"
            description="Pipelines and their stages, custom fields, saved segments."
          />
          <SettingsCard
            href="/delivery?tab=settings"
            icon={<PackageCheck className="h-4 w-4" />}
            title="Delivery settings"
            description="Stage defaults, client-facing messages and reminders for every project."
          />
          <SettingsCard
            href="/pricing"
            icon={<BadgeDollarSign className="h-4 w-4" />}
            title="Pricing"
            description="The price list every quote, proposal and the assistant read from."
          />
          <SettingsCard
            href="/whatsapp?tab=agent"
            icon={<Bot className="h-4 w-4" />}
            title="WhatsApp agent"
            description={
              data.handoff.name
                ? `Persona, hours and hand-offs — hand-offs currently go to ${data.handoff.name}.`
                : "Persona, hours and who a hand-off goes to."
            }
          />
          <SettingsCard
            href="/whatsapp?tab=keywords"
            icon={<MessageCircle className="h-4 w-4" />}
            title="WhatsApp keywords"
            description="Replies that fire on a word, before the agent gets involved."
          />
          <SettingsCard
            href="/dashboard"
            icon={<Sparkles className="h-4 w-4" />}
            title="Studio settings"
            description="Arcus's voice, wake word and interactivity — open the assistant and press its gear."
          />
          <SettingsCard
            href="/automation?tab=connect"
            icon={<Plug className="h-4 w-4" />}
            title="Automation Connect"
            description="Inbound hooks and outgoing webhooks, and the API keys that call the public API."
            badge={
              data.counts.webhooks + data.counts.apiKeys > 0
                ? `${data.counts.apiKeys} key${data.counts.apiKeys === 1 ? "" : "s"} · ${data.counts.webhooks} webhook${data.counts.webhooks === 1 ? "" : "s"}`
                : undefined
            }
          />
          <SettingsCard
            href="/crm/webhooks"
            icon={<KeyRound className="h-4 w-4" />}
            title="API keys & webhooks"
            description="The CRM's outgoing webhooks by event. The public API and its limits are documented in docs/api.md."
          />
          <SettingsCard
            href="/inbox"
            icon={<Mail className="h-4 w-4" />}
            title="Email templates"
            description="The Templates button on the inbox — reused by every compose box."
            badge={data.counts.emailTemplates > 0 ? `${data.counts.emailTemplates} saved` : undefined}
          />
          <SettingsCard
            href="/intelligence?tab=goals"
            icon={<Target className="h-4 w-4" />}
            title="Targets"
            description="Monthly goals for revenue, leads and delivery, and how the month is tracking."
          />
          <SettingsCard
            href="/team"
            icon={<ShieldCheck className="h-4 w-4" />}
            title="Team & Access"
            description="Members, invitations, devices, commissions and loans."
            badge={`${data.counts.members} member${data.counts.members === 1 ? "" : "s"}`}
          />
          <SettingsCard
            href="/profile"
            icon={<UserRound className="h-4 w-4" />}
            title="Your profile"
            description="Name, phone, avatar, notification preferences and quiet hours."
          />
        </div>
      </section>

      <section className="space-y-6">
        <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Switches that live here
        </h2>
        <div className="grid gap-6 lg:grid-cols-2">
          <LeadFormCard data={data} />
          <div className="space-y-6">
            <OutreachCard data={data} />
            <ChatLeadCard data={data} />
            <PermissionsCard data={data} />
          </div>
        </div>
        <SocialAccountsCard data={data} />
        <NumberingCard data={data} />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SettingsCard({
  href,
  icon,
  title,
  description,
  badge,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)] transition hover:border-primary-200 hover:bg-primary-50/30"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600 group-hover:bg-primary-100 group-hover:text-primary-700">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-900">{title}</span>
          {badge && <Badge className="bg-slate-100 text-slate-500 ring-slate-200">{badge}</Badge>}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{description}</span>
      </span>
      <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-300 group-hover:text-primary-500" />
    </Link>
  );
}

function Panel({
  icon,
  title,
  description,
  children,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-600">{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-400">{description}</p>
        </div>
        {actions}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/* ---- Lead form destination ------------------------------------------- */

function LeadFormCard({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [pipelineId, setPipelineId] = React.useState(data.leadForm.pipelineId);
  const [stageId, setStageId] = React.useState(data.leadForm.stageId);
  const [saving, setSaving] = React.useState(false);
  const stages = data.stages.filter((s) => !pipelineId || s.pipelineId === pipelineId);

  async function save() {
    setSaving(true);
    const res = await saveAppSetting("lead_form", {
      pipeline_id: pipelineId || null,
      stage_id: stageId || null,
    });
    setSaving(false);
    if (res.ok) {
      toast.success("Saved — new enquiries land there from now on.");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Panel
      icon={<Inbox className="h-4 w-4" />}
      title="Where a new enquiry lands"
      description="The website form, WhatsApp, the chat widget, the audit magnet and the public API all create leads through one door."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Pipeline" hint="Blank = the first pipeline.">
          <Select
            value={pipelineId}
            onChange={(e) => {
              setPipelineId(e.target.value);
              setStageId("");
            }}
          >
            <option value="">First pipeline</option>
            {data.pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Stage" hint="Blank = the pipeline's first stage.">
          <Select value={stageId} onChange={(e) => setStageId(e.target.value)}>
            <option value="">First stage</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={save} loading={saving}>
          Save
        </Button>
      </div>
    </Panel>
  );
}

/* ---- Cold outreach ----------------------------------------------------- */

function OutreachCard({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [enabled, setEnabled] = React.useState(data.outreach.enabled);
  const [fromEmail, setFromEmail] = React.useState(data.outreach.fromEmail);
  const [saving, setSaving] = React.useState(false);

  async function save() {
    setSaving(true);
    const res = await saveAppSetting("outreach", {
      enabled,
      from_email: fromEmail.trim() || null,
    });
    setSaving(false);
    if (res.ok) {
      toast.success("Outreach settings saved.");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Panel
      icon={<Share2 className="h-4 w-4" />}
      title="Cold email outreach"
      description="Whether a new prospect is researched and drafted automatically, and the mailbox replies land in."
    >
      <label className="flex items-start gap-2.5 text-sm text-slate-700">
        <input type="checkbox" className="mt-0.5" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>
          Draft outreach for every new prospect automatically
          <span className="block text-xs text-slate-400">Sends still wait for approval unless auto-send is on for the campaign.</span>
        </span>
      </label>
      <Field label="From address" hint="Defaults to support@arcai.agency." className="mt-3">
        <Input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="support@arcai.agency" />
      </Field>
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={save} loading={saving}>
          Save
        </Button>
      </div>
    </Panel>
  );
}

/* ---- Website chat → lead ------------------------------------------------ */

function ChatLeadCard({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [enabled, setEnabled] = React.useState(data.chatAutoLead);
  const [saving, setSaving] = React.useState(false);

  async function toggle(next: boolean) {
    setEnabled(next);
    setSaving(true);
    const res = await saveAppSetting("web_chat_auto_lead", { enabled: next });
    setSaving(false);
    if (res.ok) {
      toast.success(next ? "Website chats with contact details become leads." : "Website chats stay as chats.");
      router.refresh();
    } else {
      setEnabled(!next);
      toast.error(res.error);
    }
  }

  return (
    <Panel
      icon={<MessageCircle className="h-4 w-4" />}
      title="Website chat → lead"
      description="When the site's chat widget captures a name and a way to reach them, open a lead in the pipeline."
    >
      <label className="flex items-start gap-2.5 text-sm text-slate-700">
        <input type="checkbox" className="mt-0.5" checked={enabled} disabled={saving} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          Create a lead from a website chat automatically
          <span className="block text-xs text-slate-400">Read on the next analytics sync. Off by default.</span>
        </span>
      </label>
    </Panel>
  );
}

/* ---- Permissions (T5.2) ------------------------------------------------ */

function PermissionsCard({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [enabled, setEnabled] = React.useState(data.capabilitiesEnforced);
  const [saving, setSaving] = React.useState(false);

  async function toggle(next: boolean) {
    setEnabled(next);
    setSaving(true);
    const res = await saveAppSetting("capabilities_enforced", { enabled: next });
    setSaving(false);
    if (res.ok) {
      toast.success(
        next
          ? "Enforced — a member without an area's tick is now refused there."
          : "Menus only — pages and actions let everyone through again.",
      );
      router.refresh();
    } else {
      setEnabled(!next);
      toast.error(res.error);
    }
  }

  return (
    <Panel
      icon={<ShieldCheck className="h-4 w-4" />}
      title="Permissions"
      description="Each member's areas — Finance, Delivery, Sales, Marketing — are ticked on the Team page. This decides how far they reach."
    >
      <label className="flex items-start gap-2.5 text-sm text-slate-700">
        <input type="checkbox" className="mt-0.5" checked={enabled} disabled={saving} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          Enforce capabilities
          <span className="block text-xs text-slate-400">
            Off: an unticked area only leaves the member&apos;s menu. On: its pages send them to the dashboard and
            recording money needs the Finance tick. Admins are never affected.
          </span>
        </span>
      </label>
      <p className="mt-2 text-[11px] text-slate-400">
        The database keeps its permissive policies either way — the app enforces, the database records
        (&ldquo;RLS-lite&rdquo;, see docs/ops.md).
      </p>
    </Panel>
  );
}

/* ---- Social accounts --------------------------------------------------- */

function SocialAccountsCard({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<SettingsData["social"]["accounts"][number] | null>(null);

  async function toggle(id: string, active: boolean) {
    const res = await setSocialAccountActive(id, active);
    if (res.ok) {
      toast.success(active ? "Account back on." : "Account paused — nothing will publish to it.");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Panel
      icon={<Share2 className="h-4 w-4" />}
      title="Social accounts"
      description="The Instagram and Facebook accounts the publish queue can post to. Tokens are encrypted at rest."
      actions={
        <Button size="sm" onClick={() => setOpen(true)} disabled={!data.social.configured}>
          Connect an account
        </Button>
      }
    >
      {!data.social.configured && (
        <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800">
          SOCIAL_TOKEN_KEY is not set on the server. Add it to the environment before connecting an account — a token
          can&apos;t be stored safely without it.
        </p>
      )}
      {data.social.accounts.length === 0 ? (
        <p className="text-sm text-slate-400">
          Nothing connected yet. A Meta Page token with <code className="text-xs">pages_manage_posts</code> (and{" "}
          <code className="text-xs">instagram_content_publish</code> for Instagram) is what the publisher needs.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.social.accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
              <Badge
                className={cn(
                  a.platform === "instagram"
                    ? "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200"
                    : "bg-sky-50 text-sky-700 ring-sky-200",
                )}
              >
                {a.platform === "instagram" ? "Instagram" : "Facebook"}
              </Badge>
              <span className="font-medium text-slate-800">{a.name}</span>
              <span className="font-mono text-xs text-slate-400">{a.externalId}</span>
              {a.pageId && <span className="text-xs text-slate-400">· page {a.pageId}</span>}
              {a.clientId && (
                <span className="text-xs text-slate-400">
                  · {data.clients.find((c) => c.id === a.clientId)?.name ?? "a client"}
                </span>
              )}
              {a.tokenExpiresAt && (
                <span className="text-xs text-slate-400">· token to {a.tokenExpiresAt.slice(0, 10)}</span>
              )}
              <span className="ml-auto flex items-center gap-2">
                <Badge className={a.active ? "bg-emerald-50 text-emerald-600 ring-emerald-200" : "bg-slate-100 text-slate-500 ring-slate-200"}>
                  {a.active ? "Active" : "Paused"}
                </Badge>
                <Button size="sm" variant="ghost" onClick={() => void toggle(a.id, !a.active)}>
                  {a.active ? "Pause" : "Resume"}
                </Button>
                <button
                  onClick={() => setToDelete(a)}
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                  aria-label="Remove account"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <ConnectSocialModal open={open} clients={data.clients} onClose={() => setOpen(false)} />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title="Remove this account?"
        description={
          toDelete
            ? `${toDelete.name} is disconnected and its token deleted. Posts already published stay where they are.`
            : undefined
        }
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteSocialAccount(toDelete.id);
          if (res.ok) {
            toast.success("Account removed.");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </Panel>
  );
}

function ConnectSocialModal({
  open,
  clients,
  onClose,
}: {
  open: boolean;
  clients: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [platform, setPlatform] = React.useState<SocialPlatform>("instagram");
  const [name, setName] = React.useState("");
  const [externalId, setExternalId] = React.useState("");
  const [pageId, setPageId] = React.useState("");
  const [token, setToken] = React.useState("");
  const [expires, setExpires] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setPlatform("instagram");
    setName("");
    setExternalId("");
    setPageId("");
    setToken("");
    setExpires("");
    setClientId("");
  }, [open]);

  async function submit() {
    setPending(true);
    const res = await connectSocialAccount({
      platform,
      name,
      external_id: externalId,
      page_id: pageId || null,
      access_token: token,
      token_expires_at: expires ? `${expires}T00:00:00Z` : null,
      client_id: clientId || null,
    });
    setPending(false);
    if (res.ok) {
      toast.success("Connected — it's available in the publish queue.");
      router.refresh();
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect a social account"
      description="From Meta's Business settings: the account id, the linked Page id for Instagram, and a long-lived token."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending} disabled={!name.trim() || !externalId.trim() || !token.trim()}>
            Connect
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Platform" required>
            <Select value={platform} onChange={(e) => setPlatform(e.target.value as SocialPlatform)}>
              <option value="instagram">Instagram</option>
              <option value="facebook">Facebook Page</option>
            </Select>
          </Field>
          <Field label="Name" required hint="How it shows in the queue.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ARC AI on Instagram" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={platform === "instagram" ? "Instagram user id" : "Page id"} required>
            <Input value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="1784…" />
          </Field>
          <Field
            label="Linked Facebook Page id"
            required={platform === "instagram"}
            hint={platform === "instagram" ? "Instagram publishes through its Page." : "Optional for a Page."}
          >
            <Input value={pageId} onChange={(e) => setPageId(e.target.value)} />
          </Field>
        </div>
        <Field label="Access token" required hint="Encrypted before it is stored; never shown again.">
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Token expires" hint="Long-lived Page tokens last about 60 days.">
            <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          <Field label="Belongs to" hint="Blank = the agency's own account.">
            <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">ARC AI (our own)</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ---- Document numbering ------------------------------------------------- */

function previewNumber(c: SettingsData["counters"][number], n: number): string {
  return `${c.prefix}${String(n).padStart(c.width, "0")}${c.suffix}`;
}

function NumberingCard({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<SettingsData["counters"][number] | null>(null);
  const [next, setNext] = React.useState("");
  const [pending, setPending] = React.useState(false);

  async function save() {
    if (!editing) return;
    setPending(true);
    const res = await setNextDocumentNumber(editing.kind, Number(next));
    setPending(false);
    if (res.ok) {
      toast.success(`The next ${editing.kind} will be ${previewNumber(editing, Number(next))}.`);
      router.refresh();
      setEditing(null);
    } else toast.error(res.error);
  }

  return (
    <Panel
      icon={<Hash className="h-4 w-4" />}
      title="Document numbering"
      description="Every invoice, quote and notice number comes from these counters at the moment it is saved. Forward only — a series never goes back."
    >
      {data.counters.length === 0 ? (
        <p className="text-sm text-slate-400">No counters yet — they appear once migration 0120 has run.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                <th className="py-2 pr-3 font-semibold">Series</th>
                <th className="py-2 pr-3 font-semibold">Format</th>
                <th className="py-2 pr-3 font-semibold">Last issued</th>
                <th className="py-2 pr-3 font-semibold">Next</th>
                <th className="py-2 pr-3 font-semibold">Resets</th>
                <th className="py-2 text-right font-semibold" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.counters.map((c) => (
                <tr key={c.kind}>
                  <td className="py-2 pr-3 font-medium capitalize text-slate-800">{c.kind}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-slate-500">
                    {c.prefix}
                    {"N".repeat(c.width)}
                    {c.suffix}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-slate-600">{c.last > 0 ? previewNumber(c, c.last) : "—"}</td>
                  <td className="py-2 pr-3 font-mono text-xs font-semibold text-slate-800">{previewNumber(c, c.last + 1)}</td>
                  <td className="py-2 pr-3 text-xs text-slate-500">{c.yearly ? "Every January" : "Never"}</td>
                  <td className="py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(c);
                        setNext(String(c.last + 1));
                      }}
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5" /> Set next number
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Next ${editing.kind} number` : ""}
        description="Skip ahead — for example after numbers were issued outside the CRM. It cannot go backwards."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} loading={pending} disabled={!editing || !(Number(next) > editing.last)}>
              Save
            </Button>
          </>
        }
      >
        {editing && (
          <Field
            label="Next number"
            hint={`Will print as ${Number(next) > 0 ? previewNumber(editing, Number(next)) : "…"}. The last issued was ${editing.last}.`}
          >
            <Input type="number" min={editing.last + 1} value={next} onChange={(e) => setNext(e.target.value)} autoFocus />
          </Field>
        )}
      </Modal>
    </Panel>
  );
}

// Users is kept for the members badge's future icon without a lint warning.
void Users;
