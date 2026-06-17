import type { MetadataRoute } from "next";

// Web app manifest — lets users (notably on iOS 16.4+) install ARC AI
// to the home screen, which is required there to receive web push.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ARC AI Management",
    short_name: "ARC AI",
    description: "ARC AI agency workspace — projects, CRM, payments & more.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#f97316",
    icons: [
      { src: "/new-logo.png", sizes: "192x192", type: "image/png" },
      { src: "/new-logo.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
