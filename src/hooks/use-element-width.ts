"use client";

import * as React from "react";

/**
 * Measure a container so an SVG can be drawn in real pixels (0130 — lifted
 * from the chart artifact, where it stopped a viewBox from stretching).
 * Sub-pixel churn is ignored so a scrollbar reflow does not re-render.
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
