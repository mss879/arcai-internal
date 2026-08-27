"use client";

/**
 * The command view — the full-window JARVIS surface: HUD strip across the
 * top, the stage on the left, the system rail (status / reactor / log /
 * voice command) on the right, exactly the anatomy of the reference art,
 * in the workspace's orange.
 *
 * It owns no conversation state. It is a second *presentation* of the same
 * `VoiceChat` the classic workspace renders, which is what makes the header
 * toggle safe: switching views cannot lose a thread, an artifact or a turn
 * in flight, because there is nothing here to lose.
 *
 * The one performance rule that shapes everything: the audio meter ticks
 * ~60 times a second and the `chat` object is rebuilt every render, so
 * nothing memoised may receive either. The stage, HUD and rail take stable
 * slices; the two leaves that need the live meter read it from
 * `LevelContext`.
 */

import * as React from "react";

import { AmbientStage } from "@/components/assistant/command/ambient-stage";
import { CommandHud } from "@/components/assistant/command/command-hud";
import { CommandStage } from "@/components/assistant/command/command-stage";
import { LevelProvider } from "@/components/assistant/command/level-context";
import { SystemRail } from "@/components/assistant/command/system-rail";
import type { VoiceChat } from "@/components/assistant/use-voice-chat";
import type { WakeWordState } from "@/components/assistant/use-wake-word";
import { VoiceVisualizer } from "@/components/assistant/voice-visualizer";

/** Matches the workspace's tab ceiling, for the same reason. */
const MAX_PANELS = 8;

export type CommandViewProps = {
  chat: VoiceChat;
  firstName: string;
  personaName: string;
  onNavigate: (href: string) => void;
  onPrompt: (text: string) => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Artifact to open on entry, when promoted from a chip. */
  initialArtifactId?: string | null;
  wakeListening?: boolean;
  wakeState?: WakeWordState;
  wakePaused?: boolean;
  wakeHeard?: string;
  onWakeFix?: () => void;
  onWakeToggle?: () => void;
  isTerminal?: boolean;
  /** Show the business dashboard on the idle stage. Off = a clean greeting. */
  ambientStage?: boolean;
};

export function CommandView({
  chat,
  firstName,
  personaName,
  onNavigate,
  onPrompt,
  composerRef,
  initialArtifactId,
  wakeListening,
  wakeState,
  wakePaused,
  wakeHeard,
  onWakeFix,
  onWakeToggle,
  isTerminal,
  ambientStage,
}: CommandViewProps): React.ReactElement {
  const orbRef = React.useRef<HTMLDivElement | null>(null);

  const [closedIds, setClosedIds] = React.useState<string[]>([]);
  const [heroId, setHeroId] = React.useState<string | null>(
    initialArtifactId ?? null,
  );
  const [expanded, setExpanded] = React.useState(false);
  const [reloadKeys] = React.useState<Record<string, number>>({});

  // Set the moment the user picks a panel; cleared on every send, so a new
  // answer may steal the stage but an idle conversation never does.
  const userPinnedRef = React.useRef(Boolean(initialArtifactId));

  const artifacts = React.useMemo(() => {
    const open = chat.artifacts.filter((a) => !closedIds.includes(a.id));
    if (open.length <= MAX_PANELS) return open;
    const trimmed = open.slice(open.length - MAX_PANELS);
    const hero = open.find((a) => a.id === heroId);
    if (hero && !trimmed.some((a) => a.id === hero.id)) {
      return [hero, ...trimmed.slice(1)];
    }
    return trimmed;
  }, [chat.artifacts, closedIds, heroId]);

  React.useEffect(() => {
    if (userPinnedRef.current) return;
    const latest = chat.latestArtifactId;
    if (latest && !closedIds.includes(latest)) {
      setHeroId(latest);
      return;
    }
    const fallback = artifacts[artifacts.length - 1];
    if (fallback) setHeroId(fallback.id);
  }, [chat.latestArtifactId, artifacts, closedIds]);

  const promote = React.useCallback((id: string) => {
    userPinnedRef.current = true;
    setHeroId(id);
  }, []);

  const closePanel = React.useCallback(
    (id: string) => {
      setClosedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      if (heroId === id) {
        userPinnedRef.current = false;
        setHeroId(null);
        setExpanded(false);
      }
    },
    [heroId],
  );

  const send = React.useCallback(
    (value: string) => {
      userPinnedRef.current = false;
      onPrompt(value);
    },
    [onPrompt],
  );

  const toggleExpand = React.useCallback(() => setExpanded((v) => !v), []);

  // Memoised ELEMENT, not just component: a fresh JSX element every render is
  // a fresh prop, and it was silently breaking CommandStage's memo — which
  // meant the 60Hz audio meter re-rendered the entire stage. This one line is
  // most of the "why is it laggy".
  const standby = React.useMemo(
    () => (
      <AmbientStage
        firstName={firstName}
        onPrompt={send}
        onNavigate={onNavigate}
        showDashboard={Boolean(ambientStage)}
      />
    ),
    [firstName, send, onNavigate, ambientStage],
  );

  // Tapping the core: interrupt playback, otherwise start or stop listening.
  // Same rule as the mobile orb — the two must not disagree.
  const { status, stop, toggleMic } = chat;
  const onCoreTap = React.useCallback(() => {
    if (status === "speaking") {
      stop();
      return;
    }
    toggleMic();
  }, [status, stop, toggleMic]);

  return (
    <LevelProvider value={chat.level}>
      <div className="arc-command arc-command-bg relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--stage-bg)]">
        {/* The reactive field, anchored to the reactor in the rail. Already
            ref+rAF driven, so it costs no React renders at all. */}
        <VoiceVisualizer
          status={chat.status}
          level={chat.level}
          targetRef={orbRef}
        />

        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <CommandHud
            status={chat.status}
            personaName={personaName}
            isTerminal={isTerminal}
          />

          <div className="flex min-h-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col pl-3">
              <CommandStage
                artifacts={artifacts}
                heroId={heroId}
                onPromote={promote}
                onClose={closePanel}
                onPrompt={send}
                onNavigate={onNavigate}
                reloadKeys={reloadKeys}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                empty={standby}
              />
            </div>

            <SystemRail
              status={chat.status}
              steps={chat.steps}
              heard={chat.heard}
              personaName={personaName}
              wakeListening={wakeListening}
              wakeState={wakeState}
              wakePaused={wakePaused}
              wakeHeard={wakeHeard}
              onWakeFix={onWakeFix}
              onWakeToggle={onWakeToggle}
              isTerminal={isTerminal}
              orbRef={orbRef}
              onCoreTap={onCoreTap}
              messages={chat.messages}
              streamingText={chat.streamingText}
              error={chat.error}
              text={chat.text}
              setText={chat.setText}
              onPrompt={send}
              onToggleMic={chat.toggleMic}
              onCancel={chat.cancel}
              busy={chat.busy}
              composerRef={composerRef}
              onOpenArtifact={promote}
              onSendInvoice={chat.sendInvoice}
              onSendSms={chat.sendSms}
              onApproveMission={chat.approveMission}
            />
          </div>
        </div>
      </div>
    </LevelProvider>
  );
}
