import { type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

// Next.js 16 "proxy" convention (formerly "middleware").
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt
     * - sw.js (service worker) + manifest.webmanifest (PWA) — must be public
     * - arcus/hand (hand-tracking wasm + model — static, nothing sensitive,
     *   and the worker that fetches them cannot follow a login redirect)
     * - image/font assets
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|sw.js|manifest.webmanifest|arcus/hand/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
