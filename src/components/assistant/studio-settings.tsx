"use client";

/**
 * Studio settings — who Arcus is to you, and what it remembers (0101).
 *
 * Four tabs, but really two jobs. The first three (Personality, Voice,
 * Briefing) edit one `assistant_config` row: name, manner, how much it says,
 * how it sounds, when it briefs you and when it must stay quiet. The fourth
 * is the one that matters most, and it is why this panel exists at all:
 *
 *   MEMORY is where mined memories are approved.
 *
 * The overnight miner proposes standing rules from yesterday's conversations
 * and writes them as `pending`. Nothing reads a pending row into the prompt.
 * A rule only starts shaping the assistant's answers when a human presses
 * Approve here — which is what stops a client's quoted words, a pasted email
 * or a scraped page from installing themselves as instructions.
 *
 * Everything is read and written directly with the browser's own Supabase
 * client. The `assistant_*` policies are own-rows-only, so there is nothing
 * here a member could reach that is not already theirs.
 */

import * as React from "react";
import {
  BellRing,
  Brain,
  Check,
  Loader2,
  Mic2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";

import {
  getTerminalStatus,
  registerTerminal,
  unregisterTerminal,
} from "@/app/(app)/profile/terminal-actions";
import {
  requestMicrophone,
  wakeWordBlockReason,
} from "@/components/assistant/use-wake-word";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Tab = "personality" | "voice" | "briefing" | "memory";

type Config = {
  persona_name: string;
  tone: string;
  honorific: string;
  verbosity: "brief" | "normal" | "detailed";
  voice_style: string;
  hands_free: boolean;
  wake_word: boolean;
  wake_ack: string;
  ambient_stage: boolean;
  ambient_voice: boolean;
  voice_engine: "classic" | "realtime";
  briefing_enabled: boolean;
  briefing_time: string;
  quiet_start: string;
  quiet_end: string;
  nudges_per_day: number;
};

type Memory = {
  id: string;
  kind: "instruction" | "preference" | "fact";
  content: string;
  source: "user" | "mined";
  status: "active" | "pending" | "rejected" | "archived";
  evidence: { quote?: string } | null;
};

/**
 * The one-click JARVIS. Every field is something the user could set by hand;
 * the preset exists because the *combination* is the character, and finding it
 * by trial and error takes an evening.
 */
const JARVIS_PRESET = {
  tone: "impeccably composed, dryly witty, and a step ahead — a trusted chief of staff who has already looked into it",
  honorific: "sir",
  verbosity: "brief",
  wake_word: true,
  wake_ack: "Yes, sir?",
  voice_style: "measured and precise, with a faint British reserve",
} as const satisfies Partial<Config>;

const DEFAULTS: Config = {
  persona_name: "Arcus",
  tone: "warm and direct",
  honorific: "",
  verbosity: "normal",
  voice_style: "",
  hands_free: false,
  wake_word: false,
  wake_ack: "Yes, sir?",
  ambient_stage: false,
  ambient_voice: false,
  voice_engine: "classic",
  briefing_enabled: true,
  briefing_time: "08:30",
  quiet_start: "21:30",
  quiet_end: "07:30",
  nudges_per_day: 3,
};

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "personality", label: "Personality", icon: Sparkles },
  { id: "voice", label: "Voice", icon: Mic2 },
  { id: "briefing", label: "Briefing", icon: BellRing },
  { id: "memory", label: "Memory", icon: Brain },
];

export function StudioSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = React.useState<Tab>("personality");
  const [config, setConfig] = React.useState<Config>(DEFAULTS);
  const [memories, setMemories] = React.useState<Memory[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);

  // Load on open, not on mount: the panel lives inside a persistent overlay
  // and would otherwise query on every page of the app.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) {
        setLoading(false);
        return;
      }
      const [configRes, memoryRes] = await Promise.all([
        supabase
          .from("assistant_config")
          .select(
            "persona_name, tone, honorific, verbosity, voice_style, hands_free, wake_word, wake_ack, ambient_stage, ambient_voice, voice_engine, briefing_enabled, briefing_time, quiet_start, quiet_end, nudges_per_day",
          )
          .eq("user_id", user.id)
          .maybeSingle()
          .then(async (res) => {
            // Pre-0104 fallback: a select naming missing columns fails as a
            // WHOLE, which would paint defaults over settings that exist.
            if (!res.error) return res;
            return supabase
              .from("assistant_config")
              .select(
                "persona_name, tone, verbosity, voice_style, hands_free, wake_word, briefing_enabled, briefing_time, quiet_start, quiet_end, nudges_per_day",
              )
              .eq("user_id", user.id)
              .maybeSingle();
          }),
        supabase
          .from("assistant_memories")
          .select("id, kind, content, source, status, evidence")
          .eq("user_id", user.id)
          .in("status", ["active", "pending"])
          .order("status", { ascending: true })
          .order("updated_at", { ascending: false })
          .limit(200),
      ]);
      if (cancelled) return;
      if (configRes.data) setConfig({ ...DEFAULTS, ...configRes.data });
      setMemories((memoryRes.data ?? []) as Memory[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const save = React.useCallback(
    async (patch: Partial<Config>) => {
      const next = { ...config, ...patch };
      setConfig(next);
      setSaving(true);
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        // Upsert, because the row is created lazily — a member who has never
        // opened this panel has no config row, and shouldn't need one until
        // they actually change something.
        const { error } = await supabase
          .from("assistant_config")
          .upsert({ user_id: user.id, ...next }, { onConflict: "user_id" });
        if (error) {
          // Loudly. The classic failure here is a workspace one migration
          // behind: the upsert names 0104 columns, the whole statement fails,
          // and "my wake word does nothing" is impossible to diagnose from a
          // toggle that looked like it saved.
          toast.error(
            /column/i.test(error.message)
              ? "Could not save — run migration 0104 in Supabase, then try again."
              : `Could not save: ${error.message}`,
          );
        }
      }
      setSaving(false);
      setSavedAt(Date.now());
    },
    [config],
  );

  const decide = React.useCallback(
    async (id: string, status: "active" | "rejected" | "archived") => {
      setMemories((prev) =>
        status === "active"
          ? prev.map((m) => (m.id === id ? { ...m, status } : m))
          : prev.filter((m) => m.id !== id),
      );
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      await supabase
        .from("assistant_memories")
        .update({
          status,
          decided_by: user?.id ?? null,
          decided_at: new Date().toISOString(),
        })
        .eq("id", id);
    },
    [],
  );

  const pending = memories.filter((m) => m.status === "pending");
  const active = memories.filter((m) => m.status === "active");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${config.persona_name || "Arcus"} settings`}
      description="How your copilot sounds, when it speaks first, and what it remembers."
      size="lg"
    >
      <div className="flex flex-wrap gap-1 border-b border-slate-200 pb-3">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              tab === id
                ? "bg-primary-50 text-primary-700"
                : "text-slate-600 hover:bg-slate-100",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
            {id === "memory" && pending.length > 0 && (
              <span className="ml-0.5 rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-700">
                {pending.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading your settings…
        </div>
      ) : (
        <div className="space-y-5 py-4">
          {tab === "personality" && (
            <>
              <Field
                label="What it calls itself"
                hint="Used when it introduces itself and in its own prompt."
              >
                <Input
                  value={config.persona_name}
                  maxLength={40}
                  onChange={(e) => setConfig({ ...config, persona_name: e.target.value })}
                  onBlur={(e) => void save({ persona_name: e.target.value.trim() || "Arcus" })}
                />
              </Field>
              <Field
                label="Manner"
                hint="In your own words — 'warm and direct', 'dry, no small talk'."
              >
                <Input
                  value={config.tone}
                  maxLength={80}
                  onChange={(e) => setConfig({ ...config, tone: e.target.value })}
                  onBlur={(e) => void save({ tone: e.target.value.trim() })}
                />
              </Field>
              <Field
                label="What it calls you"
                hint='Leave empty for none. "sir" gives you the Jarvis register — used in greetings and confirmations, not every sentence.'
              >
                <Input
                  value={config.honorific}
                  maxLength={24}
                  placeholder="sir"
                  onChange={(e) => setConfig({ ...config, honorific: e.target.value })}
                  onBlur={(e) => void save({ honorific: e.target.value.trim() })}
                />
              </Field>
              <Field label="How much it says">
                <div className="flex gap-2">
                  {(["brief", "normal", "detailed"] as const).map((v) => (
                    <Choice
                      key={v}
                      active={config.verbosity === v}
                      onClick={() => void save({ verbosity: v })}
                    >
                      {v}
                    </Choice>
                  ))}
                </div>
              </Field>
              <div className="rounded-xl border border-primary-200 bg-primary-50/60 p-3">
                <p className="text-sm font-semibold text-primary-900">
                  The JARVIS preset
                </p>
                <p className="mt-0.5 text-xs text-primary-800/80">
                  Composed, dryly witty, a step ahead — calls you “sir”, keeps it
                  brief, and answers to its name. Sets manner, honorific, length,
                  wake word and voice in one go. Every part stays editable above.
                </p>
                <Button
                  type="button"
                  size="sm"
                  className="mt-2.5"
                  onClick={() => void save({ ...JARVIS_PRESET })}
                >
                  Apply the preset
                </Button>
              </div>
            </>
          )}

          {tab === "voice" && (
            <>
              <Field
                label="How it should sound"
                hint="Steers the OpenAI fallback voice only — with ElevenLabs configured, the JARVIS voice (Daniel, British) speaks and is tuned by its own settings, not prose."
              >
                <Input
                  value={config.voice_style}
                  maxLength={200}
                  placeholder="calm and unhurried"
                  onChange={(e) => setConfig({ ...config, voice_style: e.target.value })}
                  onBlur={(e) => void save({ voice_style: e.target.value.trim() })}
                />
              </Field>
              <Toggle
                label="Hands-free by default"
                hint="After it finishes speaking it listens again, so you can talk without tapping."
                checked={config.hands_free}
                onChange={(v) => void save({ hands_free: v })}
              />
              <Toggle
                label={`Wake word — "Hey ${config.persona_name || "Arcus"}"`}
                hint="Listens for its name while this tab is open. Off by default: it uses the browser's speech recognition, which may process audio through the browser vendor. Cmd/Ctrl+K always works instead."
                checked={config.wake_word}
                onChange={(v) => void save({ wake_word: v })}
              />
              {config.wake_word && (
                <Field
                  label="What it says back"
                  hint="Spoken the instant it hears its name, before the microphone opens. Kept ready as audio so there is no pause."
                >
                  <Input
                    value={config.wake_ack}
                    maxLength={60}
                    placeholder="Yes, sir?"
                    onChange={(e) => setConfig({ ...config, wake_ack: e.target.value })}
                    onBlur={(e) =>
                      void save({ wake_ack: e.target.value.trim() || "Yes?" })
                    }
                  />
                </Field>
              )}
              <Field
                label="Voice engine"
                hint="Live is a real back-and-forth call — far faster, real interruptions — billed by OpenAI per minute of audio. Classic is the free-flowing record-then-reply loop. Live falls back to Classic automatically if it can't connect."
              >
                <div className="flex gap-2">
                  {(
                    [
                      ["classic", "Classic"],
                      ["realtime", "Live (Realtime)"],
                    ] as const
                  ).map(([v, label]) => (
                    <Choice
                      key={v}
                      active={config.voice_engine === v}
                      onClick={() => void save({ voice_engine: v })}
                    >
                      {label}
                    </Choice>
                  ))}
                </div>
              </Field>
              <WakeDoctor wakeOn={config.wake_word} />
              <Toggle
                label="Standby dashboard"
                hint="Show the business vitals, today's briefing and open alerts on the idle screen. Off keeps standby to a clean greeting."
                checked={config.ambient_stage}
                onChange={(v) => void save({ ambient_stage: v })}
              />
              <Toggle
                label="Spoken alerts (terminal only)"
                hint="When something urgent happens — an invoice a month overdue, a job blocked for weeks — Arcus says it out loud on the terminal. Respects quiet hours, at most six a day, never twice for the same thing."
                checked={config.ambient_voice}
                onChange={(v) => void save({ ambient_voice: v })}
              />
              <TerminalCard />
            </>
          )}

          {tab === "briefing" && (
            <>
              <Toggle
                label="Morning briefing"
                hint="One conversation a day, waiting when you open the app: what needs you, what moved, what is at risk."
                checked={config.briefing_enabled}
                onChange={(v) => void save({ briefing_enabled: v })}
              />
              <div className="grid grid-cols-2 gap-4">
                <Field label="Briefing time">
                  <Input
                    type="time"
                    value={config.briefing_time}
                    onChange={(e) => void save({ briefing_time: e.target.value })}
                  />
                </Field>
                <Field label="Nudges per day" hint="At most, and never during quiet hours.">
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    value={config.nudges_per_day}
                    onChange={(e) =>
                      void save({ nudges_per_day: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })
                    }
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Quiet from">
                  <Input
                    type="time"
                    value={config.quiet_start}
                    onChange={(e) => void save({ quiet_start: e.target.value })}
                  />
                </Field>
                <Field label="Quiet until">
                  <Input
                    type="time"
                    value={config.quiet_end}
                    onChange={(e) => void save({ quiet_end: e.target.value })}
                  />
                </Field>
              </div>
            </>
          )}

          {tab === "memory" && (
            <div className="space-y-5">
              {pending.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Waiting for you
                  </h3>
                  <p className="text-xs text-slate-500">
                    Picked up from your conversations. Nothing here changes how{" "}
                    {config.persona_name || "Arcus"} behaves until you approve it.
                  </p>
                  {pending.map((m) => (
                    <div
                      key={m.id}
                      className="rounded-xl border border-amber-200 bg-amber-50/60 p-3"
                    >
                      <p className="text-sm text-slate-800">{m.content}</p>
                      {m.evidence?.quote && (
                        <p className="mt-1 text-xs italic text-slate-500">
                          “{m.evidence.quote}”
                        </p>
                      )}
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => void decide(m.id, "active")}
                        >
                          <Check className="h-3.5 w-3.5" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void decide(m.id, "rejected")}
                        >
                          <X className="h-3.5 w-3.5" />
                          No
                        </Button>
                      </div>
                    </div>
                  ))}
                </section>
              )}

              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-900">In use</h3>
                {active.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    Nothing yet. Just say “remember…” in a conversation and it
                    lands here.
                  </p>
                ) : (
                  active.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-start gap-3 rounded-xl border border-slate-200 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-slate-800">{m.content}</p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {m.kind} · {m.source === "mined" ? "learned" : "you told it"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void decide(m.id, "archived")}
                        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                        aria-label="Forget this"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))
                )}
              </section>
            </div>
          )}

          <p className="h-4 text-xs text-slate-400">
            {saving ? "Saving…" : savedAt ? "Saved" : ""}
          </p>
        </div>
      )}
    </Modal>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-slate-800">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors",
        active
          ? "bg-primary-600 text-white"
          : "bg-slate-100 text-slate-700 hover:bg-slate-200",
      )}
    >
      {children}
    </button>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-800">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors",
          checked ? "bg-primary-600" : "bg-slate-300",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            checked ? "left-[22px]" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}

/**
 * "Make this Mac the Arcus terminal" (0104).
 *
 * The terminal is the one machine that never idles out and always listens
 * for the wake word — the admin workstation Arcus lives on. Registration is
 * a server action against the trusted-devices registry; the honest fine
 * print below is the part people actually need, because the browser platform
 * has real limits no toggle can wish away.
 */
function TerminalCard() {
  const [state, setState] = React.useState<{
    loaded: boolean;
    isTerminal: boolean;
    terminalLabel: string | null;
  }>({ loaded: false, isTerminal: false, terminalLabel: null });
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const res = await getTerminalStatus();
    if (res.ok) {
      setState({
        loaded: true,
        isTerminal: res.isTerminal,
        terminalLabel: res.terminalLabel,
      });
    } else {
      setState((prev) => ({ ...prev, loaded: true }));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = React.useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
      setBusy(true);
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Something went wrong.");
      else
        toast.success(
          "Done. Reload the page for the terminal settings to take effect.",
        );
      await refresh();
      setBusy(false);
    },
    [refresh],
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <p className="text-sm font-semibold text-slate-800">
        The Arcus terminal
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
        One machine can be the terminal: it stays signed in indefinitely and
        listens for the wake word whenever the app is open, even with the
        toggle above off.
        {state.terminalLabel && !state.isTerminal
          ? ` Currently: ${state.terminalLabel}.`
          : ""}
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        {state.isTerminal ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
              <Check className="h-3 w-3" />
              This is the terminal
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act(unregisterTerminal)}
            >
              Un-register
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={busy || !state.loaded}
            onClick={() => void act(registerTerminal)}
          >
            Make this the Arcus terminal
          </Button>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
        Honest limits: listening needs this tab open and visible — install the
        app as a PWA or keep it in its own window. The screen is held awake
        while listening, but OS sleep still stops it; for a true always-on
        desk, set the Mac&apos;s display sleep to Never.
      </p>
    </div>
  );
}

function DoctorRow({
  ok,
  warn,
  label,
  detail,
}: {
  ok: boolean;
  warn?: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span
        className={cn(
          "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold",
          ok
            ? "bg-emerald-100 text-emerald-700"
            : warn
              ? "bg-amber-100 text-amber-700"
              : "bg-rose-100 text-rose-700",
        )}
      >
        {ok ? "✓" : "!"}
      </span>
      <span>
        <span className="font-medium text-slate-700">{label}</span>{" "}
        <span className="text-slate-500">{detail}</span>
      </span>
    </div>
  );
}

/**
 * "Why doesn't hey Arcus work?" — answered as a checklist instead of a
 * support call (0104). Each line is a live check: the browser engine, the
 * microphone permission (with the fix button that actually re-prompts), and
 * the setting itself. The one thing it cannot probe from the browser — the
 * migration — announces itself through the save toasts.
 */
function WakeDoctor({ wakeOn }: { wakeOn: boolean }) {
  const [mic, setMic] = React.useState<"granted" | "denied" | "prompt" | "unknown">(
    "unknown",
  );
  const [testing, setTesting] = React.useState(false);
  const reason = React.useMemo(() => wakeWordBlockReason(), []);
  const supported = reason === "ok";

  const readMic = React.useCallback(async () => {
    try {
      const status = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      setMic(status.state);
    } catch {
      setMic("unknown");
    }
  }, []);

  React.useEffect(() => {
    void readMic();
  }, [readMic]);

  const testMic = React.useCallback(async () => {
    setTesting(true);
    const res = await requestMicrophone();
    if (res.ok) toast.success("Microphone works. Say “Hey Arcus”.");
    else toast.error(res.error);
    await readMic();
    setTesting(false);
  }, [readMic]);

  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <p className="text-sm font-semibold text-slate-800">
        Wake word health check
      </p>
      <DoctorRow
        ok={supported}
        label="Browser"
        detail={
          supported
            ? "speech recognition available."
            : reason === "safari"
              ? "Safari plays the system listening tone every time the recogniser restarts, and re-asks for the microphone each visit — use Chrome or Edge for the wake word."
              : "no speech recognition — use Chrome for the wake word."
        }
      />
      <DoctorRow
        ok={mic === "granted"}
        warn={mic === "prompt" || mic === "unknown"}
        label="Microphone"
        detail={
          mic === "granted"
            ? "allowed."
            : mic === "denied"
              ? "BLOCKED for this site — click the mic icon in the address bar, allow it, then test."
              : "not granted yet — press Test below and allow it."
        }
      />
      <p className="pl-6 text-[11px] leading-relaxed text-slate-400">
        Asked to allow the mic on every login? Make the grant permanent: in
        Chrome pick &ldquo;Allow while visiting the site&rdquo; on the prompt
        (or click the lock / mic icon in the address bar → Microphone →
        Allow); in Safari use the Safari menu → Settings for this website… →
        Microphone → Allow.
      </p>
      <DoctorRow
        ok={wakeOn}
        warn={!wakeOn}
        label="Setting"
        detail={
          wakeOn
            ? "wake word is on."
            : "off — flip the toggle above (or register this machine as the terminal below)."
        }
      />
      <p className="text-[11px] leading-relaxed text-slate-400">
        Also: listening needs this tab open and visible, and pauses while
        Arcus itself is talking.
      </p>
      <Button type="button" size="sm" disabled={testing} onClick={testMic}>
        {testing ? "Testing…" : "Test the microphone"}
      </Button>
    </div>
  );
}
