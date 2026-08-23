import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PREFIXES = [
  "/login",
  "/admin",
  "/join",
  "/book",
  "/auth",
  // Public quote acceptance page (share link).
  "/q",
  // Public APIs: inquiry forms, inbound webhooks, visitor tracking, open API.
  "/api/public",
  // Cron tick endpoints (optionally guarded by SMS_CRON_SECRET themselves).
  // ANY new /api cron route must be listed here as well as given its Netlify
  // scheduled function — miss this and the call is silently 307'd to /login,
  // which looks like a working endpoint from the outside.
  "/api/automation/tick",
  "/api/sms/automation/tick",
  // Live WhatsApp replies, promise touches and the follow-up cadence.
  "/api/whatsapp/agent-tick",
  "/api/intelligence/digest",
  // Meta's WhatsApp Cloud API webhook — must be reachable by Meta's servers.
  // The route guards itself: GET needs the verify token, POST needs a valid
  // X-Hub-Signature-256 signature from WHATSAPP_APP_SECRET.
  "/api/whatsapp/webhook",
  // Resend email webhooks (bounces/complaints) — must be reachable by Resend's
  // servers. The route guards itself: POST needs a valid Svix signature from
  // RESEND_WEBHOOK_SECRET.
  "/api/webhooks",
  // Cold-outreach unsubscribe link — recipients aren't logged in. The route
  // guards itself with a per-email HMAC token.
  "/api/outreach/unsubscribe",
  // Public prospect showcase pages (unguessable token, like /q).
  "/showcase",
  // Client project portal (/public/project/<share_token>) — the link the team
  // sends a client, who is never signed in. Same model as /q and /showcase:
  // the page itself is worthless without the unguessable token, it renders a
  // hand-picked set of client-safe fields, and every server action re-resolves
  // the token to a project before it writes anything.
  "/public",
  // The client account portal (BIG-1, 0099). Clients are never Supabase users
  // — they hold their OWN signed cookie, checked by currentClientId(). Every
  // page under here redirects to /portal/login itself when that cookie is
  // missing, so leaving it out of this list would send clients to the TEAM's
  // login screen instead.
  "/portal",
  // Netlify functions (the scheduled automation tick) are invoked server-to-
  // server with no auth cookie. The catch-all proxy matcher runs on these paths
  // too, so without this they'd be redirected to /login. Harmless to keep even
  // for internally-invoked scheduled functions.
  "/.netlify/functions",
];

function isPublicPath(pathname: string) {
  if (pathname === "/") return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refreshes the Supabase auth session on every request and guards
 * private routes. If Supabase env vars are not configured yet, it
 * lets requests through so the app can still boot.
 */
export async function updateSession(request: NextRequest) {
  try {
    return await refreshAndGuard(request);
  } catch (e) {
    // The proxy runs on EVERY request — an unexpected throw here (malformed
    // env value, transient auth outage, runtime quirk) must degrade to a
    // pass-through/redirect, never a site-wide "edge function invocation
    // failed" 502. Private routes fail CLOSED (to /login), public fail open.
    console.error(
      "[proxy] session refresh crashed:",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
    if (isPublicPath(request.nextUrl.pathname)) {
      return NextResponse.next({ request });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
}

async function refreshAndGuard(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  // Not configured (or a mangled URL value) — don't block the app.
  if (!supabaseUrl || !supabaseKey || !isValidUrl(supabaseUrl)) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: do not run code between createServerClient and the auth call.
  // This runs on EVERY request, so it dominates navigation speed. getClaims()
  // refreshes the session (via getSession) AND validates the JWT — locally,
  // with no network round-trip, when the project uses asymmetric JWT signing
  // keys. It transparently falls back to a network getUser() for legacy
  // symmetric keys, so this is safe: the session is always validated.
  const { data: claimsData } = await supabase.auth.getClaims();
  const user = claimsData?.claims ?? null;

  const { pathname } = request.nextUrl;

  // Only guard private routes. Public pages (login, /admin, join, book)
  // handle their own "already signed in" redirects, which avoids redirect
  // loops when an account is mid-provisioning.
  if (!user && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
