/**
 * Pricing catalog — the single structural source of truth for the /pricing
 * page, its PDF export and the emailed PDF.
 *
 * The STRUCTURE (groups, packages, feature lists, labels and the DEFAULT
 * amounts) lives here in code. The team can EDIT the amounts on the pricing
 * page; those edits are stored as a { key: amount } override map in the
 * `pricing_config` singleton (migration 0053) and layered on top of these
 * defaults by applyOverrides(). Untouched keys always fall back to the code
 * default, so adding a new package here never needs a migration.
 *
 * Every editable number has a globally-unique `key` — never reuse or rename a
 * key, or a stored override would attach to the wrong line.
 *
 * Safe to import from BOTH client and server (no node/server-only deps).
 */

export type Currency = "LKR" | "USD";

export type PriceField = {
  /** Globally-unique, stable. Used as the override-map key. */
  key: string;
  label: string;
  amount: number;
  currency?: Currency; // default LKR
  prefix?: string; // e.g. "from"
  suffix?: string; // e.g. "one-time", "/month", "/page"
};

export type PricingPackage = {
  key: string;
  name: string;
  tagline?: string;
  badge?: string; // e.g. "Most Popular", "Flagship"
  features?: string[];
  /** Empty = rendered as a note-only card (e.g. free hosting). */
  prices: PriceField[];
  note?: string;
};

export type PricingGroup = {
  key: string;
  title: string;
  subtitle?: string;
  packages: PricingPackage[];
};

/** Edited amounts, keyed by PriceField.key. Stored in pricing_config.overrides. */
export type PricingOverrides = Record<string, number>;

/** Format a raw amount, e.g. 60000 -> "Rs 60,000", 4 (USD) -> "$4". */
export function formatAmount(amount: number, currency: Currency = "LKR"): string {
  const n = Number.isFinite(amount) ? Math.round(amount) : 0;
  const grouped = n.toLocaleString("en-US");
  return currency === "USD" ? `$${grouped}` : `Rs ${grouped}`;
}

/** Full display string for a price field incl. prefix/suffix. */
export function formatPriceField(f: PriceField): string {
  return [f.prefix, formatAmount(f.amount, f.currency ?? "LKR"), f.suffix]
    .filter(Boolean)
    .join(" ");
}

/** Layer a saved override map over the code defaults. Never mutates the source. */
export function applyOverrides(overrides: PricingOverrides = {}): PricingGroup[] {
  return PRICING_CATALOG.map((g) => ({
    ...g,
    packages: g.packages.map((p) => ({
      ...p,
      prices: p.prices.map((f) => {
        const o = overrides[f.key];
        return typeof o === "number" && Number.isFinite(o)
          ? { ...f, amount: o }
          : { ...f };
      }),
    })),
  }));
}

// ---- The catalog ----------------------------------------------------------

export const PRICING_CATALOG: PricingGroup[] = [
  {
    key: "websites",
    title: "Website Packages",
    subtitle: "One-time payments. Free hosting forever (under 1GB media).",
    packages: [
      {
        key: "web_starter",
        name: "Starter",
        tagline: "Get Online Fast",
        features: [
          "Modern responsive website (5 pages)",
          "Clean, minimal design with standard layouts",
          "WhatsApp button + contact / inquiry form",
          "Mobile-optimized & fast-loading",
          "Free hosting forever",
        ],
        prices: [{ key: "web.starter.onetime", label: "Price", amount: 60000, suffix: "one-time" }],
        note: "Delivery in 2–3 days.",
      },
      {
        key: "web_launch",
        name: "Launch",
        tagline: "Stand Out & Convert",
        features: [
          "Everything in Starter",
          "Premium custom design (8 pages)",
          "Parallax, hover effects & micro-interactions",
          "Glassmorphism cards & bespoke hero",
          "Conversion-optimized layout + strategic CTAs",
          "Full SEO with structured data & meta tags",
        ],
        prices: [{ key: "web.launch.onetime", label: "Price", amount: 90000, suffix: "one-time" }],
        note: "Delivery in 3–5 days.",
      },
      {
        key: "web_growth",
        name: "Growth",
        tagline: "Capture & Close Leads",
        badge: "Most Popular",
        features: [
          "Everything in Launch (15 pages)",
          "Lead Dashboard — every inquiry in one place",
          "CRM pipeline (New → Contacted → Quoted → Won/Lost)",
          "Email capture + newsletter system",
          "Email campaigns — promos, updates, re-engagement",
        ],
        prices: [{ key: "web.growth.onetime", label: "Price", amount: 130000, suffix: "one-time" }],
        note: "Delivery in 5–7 days.",
      },
      {
        key: "web_scale",
        name: "Scale",
        tagline: "24/7 AI-Powered Sales",
        features: [
          "Everything in Growth (23 pages)",
          "AI agent built into your website",
          "Instant 24/7 answers to visitor questions",
          "Captures details & guides users to book",
          "1 month free keyword optimization",
        ],
        prices: [
          { key: "web.scale.onetime", label: "Price", amount: 160000, suffix: "one-time" },
          { key: "web.scale.ai", label: "AI fee", amount: 4, currency: "USD", suffix: "/month" },
        ],
        note: "Delivery in 5–7 days.",
      },
    ],
  },
  {
    key: "ecommerce",
    title: "E-Commerce",
    packages: [
      {
        key: "ecom_shopify",
        name: "Shopify Theme Build",
        features: [
          "Official Shopify store builder",
          "Reliable theme-based design",
          "Product & collection management",
          "Built-in secure checkout",
          "Unlimited pages",
        ],
        prices: [
          { key: "ecom.shopify.setup", label: "Setup", amount: 75000, suffix: "one-time" },
          { key: "ecom.shopify.monthly", label: "Shopify subscription", amount: 25, currency: "USD", suffix: "/month" },
        ],
        note: "Delivery in 5–7 days. Shopify fee paid directly to Shopify.",
      },
      {
        key: "ecom_custom",
        name: "Custom Next.js Store",
        features: [
          "100% custom-coded storefront (Next.js + React)",
          "Bespoke premium animations & UI",
          "Unmatched loading speed",
          "Unrestricted technical SEO",
          "Any custom feature you want",
        ],
        prices: [{ key: "ecom.custom.setup", label: "Setup", amount: 120000, prefix: "from" }],
        note: "Delivery in 2–4 weeks. Includes 500MB backend; then $25/mo if exceeded.",
      },
      {
        key: "ecom_addons",
        name: "E-Commerce Add-Ons",
        prices: [
          { key: "ecom.addon.gateway", label: "Payment Gateway Integration", amount: 25000, suffix: "one-time" },
          { key: "ecom.addon.delivery", label: "Delivery Integration", amount: 25000, suffix: "one-time" },
        ],
      },
    ],
  },
  {
    key: "ai",
    title: "AI & Automation",
    subtitle: "Setup fee + monthly retainer. Variable AI usage billed at cost.",
    packages: [
      {
        key: "ai_whatsapp",
        name: "WhatsApp AI Sales Agent",
        tagline: "Your best salesperson, on WhatsApp, 24/7",
        badge: "Flagship",
        features: [
          "Autonomous AI rep on the client's WhatsApp",
          "Answers, qualifies, follows up & books 24/7",
          "English, Sinhala & Tamil",
          "Reads photos & payment slips; voice-note replies",
          "Standalone, or add on to any package",
        ],
        prices: [
          { key: "ai.whatsapp.setup", label: "Setup", amount: 60000, suffix: "one-time" },
          { key: "ai.whatsapp.monthly", label: "Monthly", amount: 30000, prefix: "from", suffix: "/month" },
        ],
        note: "Monthly scales with usage. Live in ~5–7 working days.",
      },
      {
        key: "ai_flow",
        name: "Flow",
        tagline: "Automate Repetitive Work",
        features: [
          "Automates one core business process",
          "Data extraction from receipts/forms/docs",
          "Auto-updates Sheets, Airtable or databases",
          "Slack / Discord / WhatsApp alerts",
          "Internal AI assistant for documents",
        ],
        prices: [
          { key: "ai.flow.setup", label: "Setup", amount: 75000, suffix: "one-time" },
          { key: "ai.flow.monthly", label: "Monthly", amount: 10000, prefix: "from", suffix: "/month" },
        ],
        note: "Deployment 1–2 weeks.",
      },
      {
        key: "ai_engage",
        name: "Engage",
        tagline: "24/7 AI Lead Capture",
        badge: "Most Popular",
        features: [
          "Everything in Flow",
          "AI chat assistant on your website",
          "Trained on your business knowledge",
          "Lead capture & qualification",
          "Scheduling integration + instant alerts",
        ],
        prices: [
          { key: "ai.engage.setup", label: "Setup", amount: 135000, suffix: "one-time" },
          { key: "ai.engage.monthly", label: "Monthly", amount: 15000, prefix: "from", suffix: "/month" },
        ],
        note: "Deployment 2–3 weeks.",
      },
      {
        key: "ai_qualify",
        name: "Qualify",
        tagline: "AI Voice Follow-Up & Booking",
        features: [
          "Everything in Engage",
          "AI voice assistant (inbound & outbound calls)",
          "Phone qualification with custom voice models",
          "Automated SMS/email follow-up",
          "Call notes, summaries & transcripts to CRM",
        ],
        prices: [
          { key: "ai.qualify.setup", label: "Setup", amount: 195000, suffix: "one-time" },
          { key: "ai.qualify.monthly", label: "Monthly", amount: 24000, prefix: "from", suffix: "/month" },
        ],
        note: "Deployment 3–5 weeks.",
      },
      {
        key: "ai_command",
        name: "Command",
        tagline: "Full AI Revenue System",
        features: [
          "Everything in Qualify",
          "Unified AI chat + voice agents",
          "Multi-stage follow-up (email, SMS, WhatsApp)",
          "Co-pilot sales tools & research briefs",
          "Custom CRM/ERP/calendar/billing integrations",
          "Executive dashboards + multi-agent orchestration",
        ],
        prices: [
          { key: "ai.command.setup", label: "Setup", amount: 310000, suffix: "one-time" },
          { key: "ai.command.monthly", label: "Monthly", amount: 45000, prefix: "from", suffix: "/month" },
        ],
        note: "Deployment 6–8 weeks.",
      },
    ],
  },
  {
    key: "social",
    title: "Social Media Marketing",
    subtitle: "Halo Media, powered by ARC AI. Monthly retainers.",
    packages: [
      {
        key: "smm_starter",
        name: "Starter",
        tagline: "Establish Your Presence",
        features: [
          "10 custom graphic posts / month",
          "Content planning, calendaring & scheduling",
          "Basic caption writing",
          "Basic graphic design support",
          "Monthly performance overview",
        ],
        prices: [{ key: "smm.starter.monthly", label: "Monthly", amount: 50000, suffix: "/month" }],
      },
      {
        key: "smm_intermediate",
        name: "Intermediate",
        tagline: "Accelerate Your Engagement",
        badge: "Most Popular",
        features: [
          "Everything in Starter",
          "18 custom graphic posts / month",
          "Professional caption writing",
          "Priority graphic design",
          "1 mobile reel / month (trending audio + editing)",
        ],
        prices: [{ key: "smm.intermediate.monthly", label: "Monthly", amount: 80000, suffix: "/month" }],
      },
      {
        key: "smm_premium",
        name: "Premium",
        tagline: "Dominate the Digital Space",
        features: [
          "Everything in Intermediate",
          "20 custom graphic posts / month",
          "Advanced content strategy",
          "Professional copywriting & ad messaging",
          "2 mobile reels / month",
          "Brand consultation & monthly strategy review",
        ],
        prices: [{ key: "smm.premium.monthly", label: "Monthly", amount: 120000, suffix: "/month" }],
      },
      {
        key: "smm_addons",
        name: "Halo Media Add-Ons",
        prices: [
          { key: "smm.addon.post", label: "Additional creative post", amount: 15000, suffix: "/post" },
          { key: "smm.addon.reel", label: "Additional mobile reel", amount: 25000, suffix: "/reel" },
          { key: "smm.addon.ads", label: "Ads setup & management", amount: 35000, suffix: "/month" },
          { key: "smm.addon.photo", label: "Professional photography", amount: 35000, suffix: "/shoot" },
          { key: "smm.addon.workshop", label: "Brand strategy workshop", amount: 40000, suffix: "/session" },
        ],
      },
    ],
  },
  {
    key: "maintenance",
    title: "Hosting & Maintenance",
    packages: [
      {
        key: "hosting",
        name: "Website Hosting",
        features: [
          "Free forever while media storage stays under 1GB",
          "Storage above 1GB quoted separately",
          "Domain registration & renewal billed to the client",
        ],
        prices: [],
        note: "FREE FOREVER (under 1GB).",
      },
      {
        key: "maint_protection",
        name: "Website Protection",
        tagline: "Security, updates, backups & bug fixes",
        prices: [
          { key: "maint.3mo", label: "3 Months", amount: 40000 },
          { key: "maint.6mo", label: "6 Months", amount: 60000 },
          { key: "maint.12mo", label: "12 Months", amount: 90000 },
        ],
      },
      {
        key: "maint_adhoc",
        name: "Ad-Hoc & Extras",
        prices: [
          { key: "maint.payperfix", label: "Pay-Per-Fix", amount: 5000, suffix: "/request" },
          { key: "seo.monthly", label: "Monthly SEO", amount: 20000, suffix: "/month" },
          { key: "web.addpage.starter", label: "Additional page (Starter)", amount: 4000, suffix: "/page" },
          { key: "web.addpage.other", label: "Additional page (Launch–Scale)", amount: 6000, suffix: "/page" },
        ],
      },
    ],
  },
];
