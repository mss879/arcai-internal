"use client";

/**
 * The live audio level, as context.
 *
 * The meter updates ~60 times a second. Passed as a prop it would tear
 * through every memo boundary between the engine and the two leaves that
 * genuinely need it (the reactor core and the composer's mic ring), because
 * the `chat` object is rebuilt every render and a prop chain is only as
 * stable as its least stable link. As context, the provider's value changes
 * at 60Hz but React re-renders only the components that CONSUME it — the
 * rail, the stage and the log stay perfectly still.
 */

import * as React from "react";

const LevelContext = React.createContext(0);

export function LevelProvider({
  value,
  children,
}: {
  value: number;
  children: React.ReactNode;
}) {
  return <LevelContext.Provider value={value}>{children}</LevelContext.Provider>;
}

/** The current audio amplitude, 0–1ish. Re-renders the caller per frame. */
export function useAudioLevel(): number {
  return React.useContext(LevelContext);
}
