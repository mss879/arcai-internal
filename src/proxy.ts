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
     * - machine-only API paths (cron ticks, inbound webhooks, the public
     *   token-guarded API) — server-to-server, cookie-free, and self-guarded,
     *   so running the session proxy on them is a paid edge invocation plus
     *   an auth round-trip that can never do anything. Every path here must
     *   guard itself (cron secret, webhook signature, or unguessable token).
     * - image/font assets
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|sw.js|manifest.webmanifest|arcus/hand/|api/automation/tick|api/assistant/tick|api/whatsapp/agent-tick|api/whatsapp/webhook|api/webhooks|api/sms/automation/tick|api/web-analytics/sync|api/intelligence/digest|api/public|api/outreach/unsubscribe|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
