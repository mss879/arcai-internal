"use client";

/**
 * The scan's map view (0104) — "salons near me", literally shown near you.
 *
 * MapLibre over OpenFreeMap's keyless tiles, mounted ONLY when the user flips
 * the panel to Map (the parent dynamic-imports this file, so none of it is in
 * the main bundle). Pins are one GeoJSON source coloured by verdict — orange
 * for "no website" because that is the prize — and live updates go through
 * `setData`, never a re-mount: the map object is expensive and owns a WebGL
 * context.
 *
 * Null coordinates simply don't pin. Firecrawl-found candidates and scans
 * from before migration 0104 have none, and the parent's badge says so
 * rather than letting an emptier-than-expected map read as a bug.
 */

import * as React from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import type { ProspectVerdict } from "@/lib/database.types";

/** Verified against OpenFreeMap's published styles; liberty is the fallback. */
const DARK_STYLE = "https://tiles.openfreemap.org/styles/dark";

const VERDICT_COLOR: Record<string, string> = {
  no_website: "#f97316",
  facebook_only: "#f59e0b",
  bad_website: "#f59e0b",
  broken: "#f59e0b",
  good_website: "#64748b",
  duplicate: "#475569",
  excluded: "#334155",
  unverified: "#64748b",
  pending: "#94a3b8",
};

export type MapCandidate = {
  id: string;
  name: string;
  category: string;
  address: string;
  phone: string;
  rating: number | null;
  website_verdict: ProspectVerdict;
  score: number | null;
  lat: number | null;
  lng: number | null;
};

function toGeoJson(candidates: MapCandidate[]) {
  return {
    type: "FeatureCollection" as const,
    features: candidates
      .filter((c) => c.lat != null && c.lng != null)
      .map((c) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [c.lng!, c.lat!] as [number, number],
        },
        properties: {
          id: c.id,
          name: c.name,
          detail: [
            c.category,
            c.rating != null ? `★ ${c.rating}` : null,
            c.website_verdict.replace(/_/g, " "),
          ]
            .filter(Boolean)
            .join(" · "),
          color: VERDICT_COLOR[c.website_verdict] ?? VERDICT_COLOR.pending,
        },
      })),
  };
}

export default function ScanMap({
  candidates,
  centre,
}: {
  candidates: MapCandidate[];
  /** The scan's own centre, from `analysis.centre`, when it has one. */
  centre: { lat: number; lng: number } | null;
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const readyRef = React.useRef(false);

  // Mount once. Candidates flow in through the OTHER effect via setData.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const pinned = candidates.filter((c) => c.lat != null && c.lng != null);
    const start =
      centre ??
      (pinned[0] ? { lat: pinned[0].lat!, lng: pinned[0].lng! } : null);

    const map = new maplibregl.Map({
      container: host,
      style: DARK_STYLE,
      center: start ? [start.lng, start.lat] : [80.6337, 7.2906], // Sri Lanka
      zoom: start ? 12 : 7,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on("load", () => {
      readyRef.current = true;
      map.addSource("candidates", {
        type: "geojson",
        data: toGeoJson(candidates),
      });
      map.addLayer({
        id: "candidate-glow",
        type: "circle",
        source: "candidates",
        paint: {
          "circle-radius": 12,
          "circle-color": ["get", "color"],
          "circle-opacity": 0.25,
          "circle-blur": 0.6,
        },
      });
      map.addLayer({
        id: "candidate-dots",
        type: "circle",
        source: "candidates",
        paint: {
          "circle-radius": 5,
          "circle-color": ["get", "color"],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#0b0805",
        },
      });

      map.on("click", "candidate-dots", (e: maplibregl.MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as { name: string; detail: string };
        new maplibregl.Popup({ closeButton: false, offset: 10 })
          .setLngLat(e.lngLat)
          .setHTML(
            `<div style="font: 12px/1.4 system-ui; color: #0f172a;"><strong>${escapeHtml(
              p.name,
            )}</strong><br/>${escapeHtml(p.detail)}</div>`,
          )
          .addTo(map);
      });
      map.on("mouseenter", "candidate-dots", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "candidate-dots", () => {
        map.getCanvas().style.cursor = "";
      });

      // Fit everything on first load, with a sane ceiling so one pin
      // doesn't zoom to rooftop level.
      if (pinned.length > 1) {
        const bounds = new maplibregl.LngLatBounds();
        for (const c of pinned) bounds.extend([c.lng!, c.lat!]);
        map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
      }
    });

    return () => {
      readyRef.current = false;
      mapRef.current = null;
      map.remove();
    };
    // Deliberately mount-only: live data goes through setData below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live rows → the source, without touching the map object.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const source = map.getSource("candidates") as
      | maplibregl.GeoJSONSource
      | undefined;
    source?.setData(toGeoJson(candidates));
  }, [candidates]);

  return <div ref={hostRef} className="h-full min-h-[280px] w-full" />;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
