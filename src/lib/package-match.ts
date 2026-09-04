import { PRICING_CATALOG, type PricingPackage } from "@/lib/pricing-catalog";

/**
 * The bridge between what was SOLD and what gets BUILT (0112).
 *
 * Sales talks in catalogue packages — Smart Site, Smart Business, Smart
 * Store — while delivery talks in `projects.service_type` (business_website,
 * ecommerce_website, …), which drives the asset checklist and the plan
 * templates. Nothing joined the two, so a project could never say which
 * package it was. `projects.package_key` now records the catalogue key, and
 * these helpers derive it from a quote's line items or a proposal's
 * selection, and derive the service type from it.
 *
 * Pure and client-safe: the create-project form uses it for its picker, the
 * server uses it to prefill from a quote.
 */

export type ProjectServiceType = "business_website" | "ecommerce_website";

export type ProjectPackageOption = {
  key: string;
  name: string;
  groupKey: string;
  groupTitle: string;
  /** The package's default list amount (first price line), or null. */
  amount: number | null;
  serviceType: ProjectServiceType | null;
};

/** The catalogue groups a project can be built from. */
const PROJECT_GROUPS: readonly string[] = ["websites", "ecommerce"];

const GROUP_SERVICE_TYPE: Record<string, ProjectServiceType> = {
  websites: "business_website",
  ecommerce: "ecommerce_website",
};

export function packageByKey(key: string | null | undefined): PricingPackage | null {
  if (!key) return null;
  for (const group of PRICING_CATALOG) {
    const hit = group.packages.find((p) => p.key === key);
    if (hit) return hit;
  }
  return null;
}

/** The delivery service type a catalogue package implies, or null. */
export function serviceTypeForPackage(
  key: string | null | undefined,
): ProjectServiceType | null {
  if (!key) return null;
  for (const group of PRICING_CATALOG) {
    if (group.packages.some((p) => p.key === key)) {
      return GROUP_SERVICE_TYPE[group.key] ?? null;
    }
  }
  return null;
}

/** The packages offered in the create-project form, in catalogue order. */
export function projectPackageOptions(): ProjectPackageOption[] {
  return PRICING_CATALOG.filter((g) => PROJECT_GROUPS.includes(g.key)).flatMap((g) =>
    g.packages.map((p) => ({
      key: p.key,
      name: p.name,
      groupKey: g.key,
      groupTitle: g.title,
      amount: p.prices[0]?.amount ?? null,
      serviceType: GROUP_SERVICE_TYPE[g.key] ?? null,
    })),
  );
}

/** The package that owns a /pricing price key (web.smart_site.onetime → web_smart_site). */
export function packageKeyForPriceKey(priceKey: string | null | undefined): string | null {
  if (!priceKey) return null;
  for (const group of PRICING_CATALOG) {
    for (const pkg of group.packages) {
      if (pkg.prices.some((f) => f.key === priceKey)) return pkg.key;
    }
  }
  return null;
}

export type LineItemLike = {
  item?: string | null;
  description?: string | null;
};

/**
 * Guess the package from a quote's line items by package name — longest
 * name first, so "Smart System Budget" wins over "Smart System".
 */
export function packageFromLineItems(
  items: LineItemLike[] | null | undefined,
): string | null {
  const text = (items ?? [])
    .map((i) => `${i.item ?? ""} ${i.description ?? ""}`)
    .join(" \n ")
    .toLowerCase();
  if (!text.trim()) return null;
  const candidates = PRICING_CATALOG.flatMap((g) => g.packages)
    .map((p) => ({ key: p.key, name: p.name.toLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length);
  return candidates.find((c) => text.includes(c.name))?.key ?? null;
}

/** A quote's line items as the "Included:" block of a project description. */
export function includedLines(items: LineItemLike[] | null | undefined): string {
  const lines = (items ?? [])
    .map((i) => {
      const name = (i.item ?? "").trim();
      const desc = (i.description ?? "").trim();
      if (!name && !desc) return null;
      return `• ${name}${name && desc ? " — " : ""}${desc}`;
    })
    .filter((l): l is string => Boolean(l));
  return lines.length ? `Included:\n${lines.join("\n")}` : "";
}
