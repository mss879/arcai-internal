import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // react-pdf ships its own font/PDF binaries — let Next require it at runtime
  // from node_modules instead of bundling it into the serverless function.
  serverExternalPackages: ["@react-pdf/renderer"],
  async headers() {
    return [
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
