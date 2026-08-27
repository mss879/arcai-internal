"use client";

/**
 * The `chart` artifact — bar, line and donut, drawn as inline SVG.
 *
 * No chart library, by rule: the app ships no charting dependency and three
 * shapes do not justify adding one. Everything is computed from a *measured*
 * pane width rather than a fixed `viewBox` with `preserveAspectRatio="none"`,
 * because the canvas is resizable and a stretched viewBox turns rounded bar
 * corners into ovals at 46% and slivers at 25%.
 *
 * Two deliberate degradations: more than ~24 points, or every value zero, and
 * the chart becomes a labelled list. A 40-bar chart at 360px is unreadable and
 * a chart of nothing but zeros is a flat line that says nothing — in both
 * cases the list is the more honest picture.
 *
 * Presentational only: data in via props. It calls nothing back.
 */

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";
import type { ArtifactFormat, ArtifactTone } from "@/lib/assistant-artifacts";
import { formatCell, TONE_TEXT, type ArtifactOf } from "./artifact-format";

/** Above this, bars/points are thinner than their own gap — use the list. */
const MAX_POINTS = 24;
const PLOT_HEIGHT = 176;
const BAR_GAP = 8;

/** Slice colours when the server didn't tone the points itself. */
const CYCLE: ArtifactTone[] = ["info", "positive", "warning", "danger", "neutral"];

/** Measure a container so the SVG can be drawn in real pixels. */
function useElementWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      // Ignore sub-pixel churn; it would re-render on every scrollbar reflow.
      setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

type Point = { label: string; value: number; tone?: ArtifactTone };

function toneFor(point: Point, index: number, cycle: boolean): ArtifactTone {
  if (point.tone) return point.tone;
  return cycle ? CYCLE[index % CYCLE.length] : "info";
}

/**
 * The two palettes this chart can wear.
 *
 * Collected here rather than as a ternary at each of the dozen call sites:
 * the marks themselves already carry their own tone colours and work on
 * either ground, so all that actually changes is the text, the rules and the
 * card the fallback list sits on. One object, one place to keep them honest.
 */
type ChartSkin = {
  label: string;
  value: string;
  faint: string;
  rule: string;
  track: string;
  card: string;
  divide: string;
};

const LIGHT_SKIN: ChartSkin = {
  label: "text-slate-700",
  value: "text-slate-900",
  faint: "text-slate-400",
  rule: "stroke-slate-200",
  track: "bg-slate-100",
  card: "rounded-2xl border border-slate-200/80 bg-white",
  divide: "divide-slate-100",
};

const STAGE_SKIN: ChartSkin = {
  label: "text-[var(--stage-text)]",
  value: "text-[var(--stage-text)]",
  faint: "text-[var(--stage-faint)]",
  rule: "stroke-white/10",
  track: "bg-white/10",
  card: "rounded-2xl border border-[var(--stage-border)] bg-[var(--stage-panel)]",
  divide: "divide-white/5",
};

const skinFor = (stage?: boolean): ChartSkin => (stage ? STAGE_SKIN : LIGHT_SKIN);

/** Screen-reader table of the same numbers, always rendered alongside. */
function ChartReadout({
  points,
  format,
}: {
  points: Point[];
  format?: ArtifactFormat;
}): React.ReactElement {
  return (
    <ul className="sr-only">
      {points.map((p, i) => (
        <li key={`${p.label}-${i}`}>
          {p.label}: {formatCell(p.value, format)}
        </li>
      ))}
    </ul>
  );
}

/** The fallback shape: a plain labelled list with proportional rules. */
function PointList({
  points,
  format,
  showBars,
  skin,
}: {
  points: Point[];
  format?: ArtifactFormat;
  showBars: boolean;
  skin: ChartSkin;
}): React.ReactElement {
  const max = Math.max(...points.map((p) => Math.abs(p.value)), 0);
  return (
    <ul className={cn("divide-y", skin.divide, skin.card)}>
      {points.map((point, i) => {
        const share = max > 0 ? Math.abs(point.value) / max : 0;
        return (
          <li key={`${point.label}-${i}`} className="px-3.5 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className={cn("truncate text-[13px]", skin.label)}>
                {point.label}
              </span>
              <span
                className={cn(
                  "shrink-0 text-[13px] font-medium tabular-nums",
                  skin.value,
                )}
              >
                {formatCell(point.value, format)}
              </span>
            </div>
            {showBars && (
              <div
                className={cn(
                  "mt-1.5 h-1 w-full overflow-hidden rounded-full",
                  skin.track,
                )}
              >
                <div
                  className={cn(
                    "h-full rounded-full bg-current",
                    TONE_TEXT[toneFor(point, i, false)],
                  )}
                  style={{ width: `${Math.max(share * 100, 1.5)}%` }}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function BarChart({
  points,
  format,
  skin,
  width,
  reduced,
}: {
  points: Point[];
  format?: ArtifactFormat;
  width: number;
  reduced: boolean;
  skin: ChartSkin;
}): React.ReactElement {
  const values = points.map((p) => p.value);
  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const range = top - bottom || 1;
  const zeroY = (top / range) * PLOT_HEIGHT;

  const n = points.length;
  const barWidth = Math.max((width - BAR_GAP * (n - 1)) / n, 3);

  return (
    <>
      <svg
        width={width}
        height={PLOT_HEIGHT}
        viewBox={`0 0 ${width} ${PLOT_HEIGHT}`}
        className="block"
        aria-hidden
        focusable="false"
      >
        {/* Zero line, only when the data actually crosses it. */}
        {bottom < 0 && (
          <line
            x1={0}
            x2={width}
            y1={zeroY}
            y2={zeroY}
            className={skin.rule}
            strokeWidth={1}
          />
        )}
        {points.map((point, i) => {
          const x = i * (barWidth + BAR_GAP);
          const height = Math.max(
            (Math.abs(point.value) / range) * PLOT_HEIGHT,
            point.value === 0 ? 0 : 2,
          );
          const y = point.value >= 0 ? zeroY - height : zeroY;
          return (
            <motion.rect
              key={`${point.label}-${i}`}
              x={x}
              y={y}
              width={barWidth}
              height={height}
              rx={Math.min(3, barWidth / 2)}
              fill="currentColor"
              className={TONE_TEXT[toneFor(point, i, false)]}
              style={{
                transformBox: "fill-box",
                transformOrigin: point.value >= 0 ? "50% 100%" : "50% 0%",
              }}
              initial={reduced ? false : { scaleY: 0, opacity: 0.6 }}
              animate={{ scaleY: 1, opacity: 1 }}
              transition={{
                duration: 0.4,
                delay: Math.min(i * 0.03, 0.3),
                ease: "easeOut",
              }}
            />
          );
        })}
      </svg>

      {/* Labels live in HTML, not <text>: they keep the app's font, truncate
          properly, and never need manual measuring. */}
      <div className="mt-2 flex" style={{ gap: BAR_GAP }}>
        {points.map((point, i) => (
          <div
            key={`${point.label}-${i}`}
            className="min-w-0 flex-1 text-center"
            style={{ flexBasis: barWidth }}
          >
            <p className={cn("truncate text-[11px] font-medium tabular-nums", skin.label)}>
              {formatCell(point.value, format)}
            </p>
            <p className={cn("truncate text-[10px]", skin.faint)} title={point.label}>
              {point.label}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

function LineChart({
  points,
  format,
  skin,
  width,
  reduced,
}: {
  points: Point[];
  format?: ArtifactFormat;
  width: number;
  reduced: boolean;
  skin: ChartSkin;
}): React.ReactElement {
  const values = points.map((p) => p.value);
  const top = Math.max(...values);
  const bottom = Math.min(...values, 0);
  const range = top - bottom || 1;
  const inset = 5; // room for the end dots' radius + stroke
  const usable = Math.max(width - inset * 2, 1);
  const plot = PLOT_HEIGHT - inset * 2;

  const coords = points.map((point, i) => {
    const x =
      points.length === 1
        ? inset + usable / 2
        : inset + (i / (points.length - 1)) * usable;
    const y = inset + (1 - (point.value - bottom) / range) * plot;
    return { x, y, point };
  });

  const line = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ");
  const area = `${inset},${PLOT_HEIGHT - inset} ${line} ${(width - inset).toFixed(2)},${PLOT_HEIGHT - inset}`;
  const tone = toneFor(points[0], 0, false);
  const showAllLabels = points.length <= 12 && width >= 380;

  return (
    <>
      <svg
        width={width}
        height={PLOT_HEIGHT}
        viewBox={`0 0 ${width} ${PLOT_HEIGHT}`}
        className={cn("block", TONE_TEXT[tone])}
        aria-hidden
        focusable="false"
      >
        <polygon points={area} fill="currentColor" opacity={0.12} />
        <motion.polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={reduced ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
        {coords.map((c, i) => (
          <circle
            key={`${c.point.label}-${i}`}
            cx={c.x}
            cy={c.y}
            r={3}
            fill="currentColor"
          >
            <title>{`${c.point.label}: ${formatCell(c.point.value, format)}`}</title>
          </circle>
        ))}
      </svg>

      <div className="mt-2 flex items-start justify-between gap-2">
        {(showAllLabels
          ? coords
          : [coords[0], coords[Math.floor(coords.length / 2)], coords[coords.length - 1]]
        ).map((c, i) => (
          <div
            key={`${c.point.label}-${i}`}
            className="min-w-0 flex-1 text-center first:text-left last:text-right"
          >
            <p className={cn("truncate text-[11px] font-medium tabular-nums", skin.label)}>
              {formatCell(c.point.value, format)}
            </p>
            <p className={cn("truncate text-[10px]", skin.faint)} title={c.point.label}>
              {c.point.label}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

function DonutChart({
  points,
  format,
  skin,
  reduced,
}: {
  points: Point[];
  format?: ArtifactFormat;
  reduced: boolean;
  skin: ChartSkin;
}): React.ReactElement {
  // Negative slices have no meaning in a donut; clamp rather than draw nonsense.
  const slices = points.map((p) => ({ ...p, value: Math.max(p.value, 0) }));
  const total = slices.reduce((sum, p) => sum + p.value, 0);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;

  // Built with a plain loop rather than `map` over a mutable accumulator: a
  // `let` reassigned inside a render callback is exactly what the React
  // compiler's immutability rule refuses, and the running offset is the whole
  // point of the shape.
  const arcs: {
    key: string;
    point: Point;
    share: number;
    tone: ArtifactTone;
    dash: string;
    offset: number;
  }[] = [];
  let consumed = 0;
  for (let i = 0; i < slices.length; i++) {
    const point = slices[i];
    const share = total > 0 ? point.value / total : 0;
    const length = share * circumference;
    arcs.push({
      key: `${point.label}-${i}`,
      point,
      share,
      tone: toneFor(point, i, true),
      dash: `${length} ${circumference - length}`,
      offset: -consumed,
    });
    consumed += length;
  }

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative shrink-0">
        <svg
          width={140}
          height={140}
          viewBox="0 0 120 120"
          className="block"
          aria-hidden
          focusable="false"
        >
          <circle
            cx={60}
            cy={60}
            r={radius}
            fill="none"
            strokeWidth={18}
            className={skin.rule}
          />
          <g transform="rotate(-90 60 60)">
            {arcs.map((arc, i) => (
              <motion.circle
                key={arc.key}
                cx={60}
                cy={60}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={18}
                strokeDasharray={arc.dash}
                strokeDashoffset={arc.offset}
                className={TONE_TEXT[arc.tone]}
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.35, delay: Math.min(i * 0.05, 0.3) }}
              />
            ))}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className={cn("text-[15px] font-semibold tabular-nums leading-tight", skin.value)}>
              {formatCell(total, format)}
            </p>
            <p className={cn("text-[10px] uppercase tracking-wide", skin.faint)}>
              Total
            </p>
          </div>
        </div>
      </div>

      <ul className="min-w-[160px] flex-1 space-y-1.5">
        {arcs.map((arc) => (
          <li key={arc.key} className="flex items-center gap-2 text-[12px]">
            <span
              aria-hidden
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-full bg-current",
                TONE_TEXT[arc.tone],
              )}
            />
            <span className={cn("min-w-0 flex-1 truncate", skin.label)}>
              {arc.point.label}
            </span>
            <span className={cn("shrink-0 font-medium tabular-nums", skin.value)}>
              {formatCell(arc.point.value, format)}
            </span>
            <span className={cn("w-10 shrink-0 text-right tabular-nums", skin.faint)}>
              {(arc.share * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type ChartArtifactProps = {
  artifact: ArtifactOf<"chart">;
  /** True when the pane is narrow. */
  dense: boolean;
  /** Paint for the dark command stage (0104). */
  stage?: boolean;
};

/** Render a `chart` artifact as inline SVG, or as a list when that reads better. */
export function ChartArtifact({
  artifact,
  dense,
  stage,
}: ChartArtifactProps): React.ReactElement {
  const skin = skinFor(stage);
  const reducedMotion = useReducedMotion();
  const reduced = reducedMotion === true;
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const points = artifact.points;

  const allZero = points.every((p) => !Number.isFinite(p.value) || p.value === 0);
  const tooMany = points.length > MAX_POINTS;
  const degrade = points.length === 0 || allZero || tooMany;

  return (
    <div ref={ref} className="w-full">
      <div
        role="img"
        aria-label={`${artifact.title}${artifact.summary ? `. ${artifact.summary}` : ""}`}
      >
        {points.length === 0 ? (
          <p className={cn("py-10 text-center text-[13px]", skin.faint)}>
            There is nothing to chart for this period.
          </p>
        ) : degrade ? (
          <>
            {tooMany && (
              <p className={cn("mb-2 text-[11px]", skin.faint)}>
                {points.length} values — shown as a list so every label stays
                readable.
              </p>
            )}
            <PointList
              points={points}
              format={artifact.format}
              showBars={!allZero}
              skin={skin}
            />
          </>
        ) : artifact.chart === "donut" ? (
          <DonutChart
            points={points}
            format={artifact.format}
            reduced={reduced}
            skin={skin}
          />
        ) : width > 0 ? (
          artifact.chart === "line" ? (
            <LineChart
              points={points}
              format={artifact.format}
              width={width}
              reduced={reduced}
              skin={skin}
            />
          ) : (
            <BarChart
              points={points}
              format={artifact.format}
              width={width}
              reduced={reduced}
              skin={skin}
            />
          )
        ) : (
          // First paint, before the ResizeObserver has reported: reserve the
          // space so the pane doesn't visibly jump when the chart lands.
          <div
            aria-hidden
            style={{ height: PLOT_HEIGHT }}
            className={cn("rounded-2xl", skin.track)}
          />
        )}
        <ChartReadout points={points} format={artifact.format} />
      </div>

      {dense && points.length > 8 && !degrade ? (
        <p className={cn("mt-3 text-[11px]", skin.faint)}>
          Widen the preview for roomier labels.
        </p>
      ) : null}
    </div>
  );
}
