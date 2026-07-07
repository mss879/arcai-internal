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
  "/api/automation/tick",
  "/api/sms/automation/tick",
  "/api/intelligence/digest",
  // Netlify functions are invoked server-to-server (scheduled tick, and the CRM
  // research synthesis worker `triggerSynthWorker` POSTs here) with no auth
  // cookie. The catch-all proxy matcher runs on these paths too, so without this
  // they get redirected to /login and NEVER execute — which is exactly why
  // prospect-research synthesis silently hangs in production while it works
  // locally (local runs synthesis inline, never calling this function). These
  // carry their own SMS_CRON_SECRET gate.
  "/.netlify/functions",
];

function isPublicPath(pathname: string) {
  if (pathname === "/") return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Refreshes the Supabase auth session on every request and guards
 * private routes. If Supabase env vars are not configured yet, it
 * lets requests through so the app can still boot.
 */
export async function updateSession(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Not configured yet — don't block the app.
  if (!supabaseUrl || !supabaseKey) {
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
