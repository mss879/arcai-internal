import { requireProfile } from "@/lib/auth";
import { loadGoProjects } from "@/lib/go-projects";
import { createClient } from "@/lib/supabase/server";

import { GoView } from "./go-view";

export const metadata = { title: "Delivery · on the go" };

/**
 * Delivery, phone-shaped (BIG-5, 0099).
 *
 * The app has been installable since the PWA work; what it never had was a
 * screen designed for the phone rather than shrunk onto it. The month board is
 * a three-column grid of cards about money — useful at a desk, useless when
 * you are standing in a client's office and need to move a stage, log the
 * hour and photograph what you built.
 *
 * Four verbs, big enough to hit with a thumb: approve, log, photograph, nudge.
 * Everything here goes through the same server actions the desktop uses, so
 * the deposit gate and the launch checklist apply identically.
 *
 * 0119 — the list is built by loadGoProjects(), shared with /api/go/data,
 * which the service worker keeps as the offline copy. A stage move or a time
 * entry made without signal waits in the outbox and replays through
 * /api/go/sync — the same server actions again, so the gate still applies.
 */
export default async function DeliveryGoPage() {
  const supabase = await createClient();
  const [profile, projects] = await Promise.all([
    requireProfile(),
    loadGoProjects(supabase),
  ]);

  return <GoView projects={projects} userId={profile.id} />;
}
