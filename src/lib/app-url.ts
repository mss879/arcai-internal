/**
 * Absolute URL into the app for links that leave it (SMS, email, push).
 * Returns null when NEXT_PUBLIC_APP_URL isn't configured so callers can
 * fall back to link-less copy instead of sending a broken link.
 */
export function appLink(path: string): string | null {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
}
