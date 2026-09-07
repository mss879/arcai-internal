import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // react-pdf ships its own font/PDF binaries — let Next require it at runtime
  // from node_modules instead of bundling it into the serverless function.
  serverExternalPackages: ["@react-pdf/renderer"],
  experimental: {
    serverActions: {
      // The client portal uploads photos/PDFs through a server action; the
      // default 1MB body limit fails any real photo with an opaque error.
      // The action itself enforces a friendly 10MB cap — this is headroom
      // for multipart overhead.
      bodySizeLimit: "12mb",
    },
  },
  images: {
    // Avatars are uploaded to Supabase storage and rendered via next/image.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
  async headers() {
    return [
      {
        // Hand-tracking assets (wasm + model) are versionless files that
        // never change in place — cache them hard so arming interactivity
        // mode is instant after the first visit.
        source: "/arcus/hand/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // 0126 — the website-agent widget, loaded on clients' sites. Cached
        // briefly so a fix reaches every site within minutes, revalidated
        // cheaply by ETag in between.
        source: "/ai-widget.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "public, max-age=300, stale-while-revalidate=86400",
          },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
      {
        // Always serve the freshest service worker.
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
