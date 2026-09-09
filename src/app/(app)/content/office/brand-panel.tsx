"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Palette, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type { OfficeBrandProfileRow } from "@/lib/agents/office-types";

import { deleteBrandProfile, saveBrandProfile, type BrandProfileInput } from "../office-actions";
import { splitList } from "./office-ui";

/**
 * Brand profiles (0130): the voice the writers write in and the checker
 * checks against. One house profile, plus one per client if wanted.
 */
export function BrandPanel({ profiles, clients, isAdmin }: { profiles: OfficeBrandProfileRow[]; clients: { id: string; name: string }[]; isAdmin: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<OfficeBrandProfileRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const clientName = (id: string | null) => (id ? clients.find((c) => c.id === id)?.name ?? "a client" : "House brand");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-600">What the copywriter writes in and the checker checks against. Pick a profile when you brief.</p>
        {isAdmin && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> New profile
          </Button>
        )}
      </div>
      {!profiles.length ? (
        <EmptyState icon={<Palette className="h-6 w-6" />} title="No brand profile yet" description="The migration seeds a house profile; an admin can add one per client." />
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {profiles.map((p) => {
            const voice = (p.voice ?? {}) as Record<string, unknown>;
            const tone = Array.isArray(voice.tone) ? (voice.tone as string[]) : [];
            return (
              <li key={p.id} className="card bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-slate-900">{p.name}</div>
                    <div className="text-xs text-slate-500">
                      {clientName(p.client_id)}
                      {p.is_default ? " · default" : ""}
                    </div>
                  </div>
                  {isAdmin && (
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                      {!p.is_default && (
                        <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => setDeleting(p.id)} aria-label="Delete profile">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </span>
                  )}
                </div>
                {typeof voice.persona === "string" && voice.persona && <p className="mt-2 text-sm text-slate-700">{voice.persona}</p>}
                {tone.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {tone.map((t) => (
                      <span key={t} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {p.pillars.length > 0 && <p className="mt-2 text-xs text-slate-500">Pillars: {p.pillars.join(" · ")}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {editing && <BrandForm profile={editing === "new" ? null : editing} clients={clients} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this brand profile?"
        description="Missions that used it keep their results."
        onConfirm={async () => {
          if (!deleting) return;
          const res = await deleteBrandProfile(deleting);
          if (!res.ok) toast.error(res.error);
          else toast.success("Profile deleted.");
          setDeleting(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function BrandForm({ profile, clients, onClose }: { profile: OfficeBrandProfileRow | null; clients: { id: string; name: string }[]; onClose: () => void }) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const voice = (profile?.voice ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).join("\n") : "");
  const [s, setS] = React.useState({
    clientId: profile?.client_id ?? "",
    name: profile?.name ?? "",
    persona: typeof voice.persona === "string" ? voice.persona : "",
    tone: Array.isArray(voice.tone) ? (voice.tone as string[]).join(", ") : "",
    dos: arr(voice.do),
    donts: arr(voice.dont),
    pillars: (profile?.pillars ?? []).join("\n"),
    audience: profile?.audience ?? "",
    bannedWords: (profile?.banned_words ?? []).join(", "),
    hashtags: Array.isArray(profile?.hashtag_sets)
      ? (profile!.hashtag_sets as { name?: string; tags?: string[] }[]).map((h) => `${h.name ?? "set"}: ${(h.tags ?? []).join(" ")}`).join("\n")
      : "",
    notes: profile?.notes ?? "",
  });
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setS((prev) => ({ ...prev, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const input: BrandProfileInput = {
        id: profile?.id ?? null,
        clientId: s.clientId || null,
        name: s.name,
        persona: s.persona,
        tone: splitList(s.tone),
        dos: s.dos.split("\n").map((x) => x.trim()).filter(Boolean),
        donts: s.donts.split("\n").map((x) => x.trim()).filter(Boolean),
        pillars: s.pillars.split("\n").map((x) => x.trim()).filter(Boolean),
        audience: s.audience,
        bannedWords: splitList(s.bannedWords),
        hashtagSets: s.hashtags
          .split("\n")
          .map((line) => {
            const [name, rest] = line.split(":");
            return { name: (name ?? "").trim(), tags: (rest ?? "").split(/\s+/).map((t) => t.trim()).filter(Boolean) };
          })
          .filter((h) => h.name && h.tags.length),
        notes: s.notes,
      };
      const res = await saveBrandProfile(input);
      if (!res.ok) return toast.error(res.error);
      toast.success("Brand profile saved.");
      onClose();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={profile ? "Edit brand profile" : "New brand profile"} size="lg">
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={s.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="For">
            <Select value={s.clientId} onChange={(e) => set("clientId", e.target.value)} disabled={Boolean(profile?.is_default)}>
              <option value="">Our own (house) brand</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Persona" hint="One sentence: who is speaking.">
          <Input value={s.persona} onChange={(e) => set("persona", e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tone (comma-separated)">
            <Input value={s.tone} onChange={(e) => set("tone", e.target.value)} placeholder="confident, warm, plain-spoken" />
          </Field>
          <Field label="Audience">
            <Input value={s.audience} onChange={(e) => set("audience", e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Do (one per line)">
            <Textarea rows={3} value={s.dos} onChange={(e) => set("dos", e.target.value)} />
          </Field>
          <Field label="Don't (one per line)">
            <Textarea rows={3} value={s.donts} onChange={(e) => set("donts", e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Content pillars (one per line)">
            <Textarea rows={3} value={s.pillars} onChange={(e) => set("pillars", e.target.value)} />
          </Field>
          <Field label="Banned words (comma-separated)">
            <Textarea rows={3} value={s.bannedWords} onChange={(e) => set("bannedWords", e.target.value)} />
          </Field>
        </div>
        <Field label="Hashtag sets" hint="One per line: name: #tag #tag">
          <Textarea rows={2} value={s.hashtags} onChange={(e) => set("hashtags", e.target.value)} placeholder="core: #arcai #srilanka #smallbusiness" />
        </Field>
        <Field label="Notes">
          <Textarea rows={2} value={s.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
