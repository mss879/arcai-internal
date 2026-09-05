/**
 * Capabilities (T5.2, 0121) — which areas a member may work in.
 *
 * Before this the only distinction was admin vs member, and a member who
 * only ever logged hours could open the finance page. Four capabilities
 * name the areas; an admin has all of them by role, and a member has the
 * ones ticked on the Team page (all four by default, so nothing changed the
 * day this landed).
 *
 * Two layers, deliberately:
 *
 *   • the sidebar reads `hasCapability()` and hides what a member cannot
 *     use — always, from day one;
 *   • pages and money actions enforce it only once
 *     `app_settings.capabilities_enforced` is on (a switch on /settings),
 *     so the workspace can watch the menus for a week before a wrong tick
 *     locks anyone out of a page.
 *
 * Pure and client-safe: the sidebar is a client component. The server side
 * (the enforcement switch, the finance audience) lives in
 * `capabilities-server.ts`; the page and action guards in `auth.ts`.
 */

export const CAPABILITIES = ["finance", "delivery", "sales", "marketing"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_META: Record<Capability, { label: string; blurb: string }> = {
  finance: {
    label: "Finance",
    blurb: "Money & Finance, invoices, payments, and recording money received.",
  },
  delivery: {
    label: "Delivery",
    blurb: "The delivery board, project reports and client-facing stage moves.",
  },
  sales: {
    label: "Sales",
    blurb: "The CRM pipeline and proposals.",
  },
  marketing: {
    label: "Marketing",
    blurb: "Content Studio, SMS campaigns and WhatsApp outreach.",
  },
};

/** The shape both `profiles` rows and lighter selects satisfy. */
export type CapabilityHolder = {
  role: string;
  /** Absent on a database without 0121 — treated as "everything". */
  capabilities?: string[] | null;
};

/**
 * Whether this person may work in `capability`.
 *
 * No capability asked for = always yes (a nav item without one is open to
 * everyone). An admin = yes. A row without the column (0121 not applied) =
 * yes, because a permission the database cannot record must not lock
 * anyone out. Otherwise, it is ticked or it is not.
 */
export function hasCapability(
  profile: CapabilityHolder | null | undefined,
  capability: Capability | null | undefined,
): boolean {
  if (!capability) return true;
  if (!profile) return false;
  if (profile.role === "admin") return true;
  if (profile.capabilities === undefined || profile.capabilities === null) return true;
  return profile.capabilities.includes(capability);
}

/** Keep only known values, in canonical order. */
export function normaliseCapabilities(input: readonly string[] | null | undefined): Capability[] {
  const set = new Set((input ?? []).filter((c): c is Capability => (CAPABILITIES as readonly string[]).includes(c)));
  return CAPABILITIES.filter((c) => set.has(c));
}
