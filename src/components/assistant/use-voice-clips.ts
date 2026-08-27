"use client";

/**
 * Precached speech (0104).
 *
 * Two lines have to land the INSTANT something happens — the greeting when
 * the agent opens, and "Yes, sir?" when the wake word fires. A TTS round
 * trip at that moment is a second of dead air exactly where the illusion of
 * presence is made or broken. So each phrase is synthesised once, ahead of
 * time, and kept as a blob URL ready to play.
 *
 * The fetch is deferred a few seconds after mount so it never competes with
 * the page's own startup, and re-runs only when the phrase itself changes.
 * On any failure the hook simply returns null and callers fall back to the
 * fetch-and-speak path — a slower greeting, never a missing one.
 */

import * as React from "react";

// Near-immediate: the whole point is that the FIRST click speaks instantly,
// and people click the moment the page paints. One deferred tick still keeps
// it off the critical render path.
const WARMUP_DELAY_MS = 250;

export function useVoiceClip(text: string | null): string | null {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!text?.trim()) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch("/api/assistant/speak", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (!res.ok || cancelled) return;
          const blob = await res.blob();
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        } catch {
          // Callers fall back to speak(); silence here is deliberate.
        }
      })();
    }, WARMUP_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [text]);

  return url;
}
