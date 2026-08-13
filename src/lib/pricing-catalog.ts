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
    subtitle:
      "Every package includes a CRM and an AI agent. One-time payment, no monthly fee — AI usage billed at cost. Free hosting forever (under 1GB media).",
    packages: [
      {
        key: "web_smart_site",
        name: "Smart Site",
        tagline: "Website + CRM + AI Answers",
        features: [
          "Premium responsive website (15 pages)",
          "Backend CRM — every inquiry lands in one pipeline",
          "AI agent answering customer questions 24/7 (answers & guides — no action steps)",
          "Full SEO with structured data & meta tags",
          "Free hosting forever (under 1GB)",
        ],
        prices: [{ key: "web.smart_site.onetime", label: "Price", amount: 175000, suffix: "one-time" }],
        note: "Exact delivery timeline confirmed with your quote.",
      },
      {
        key: "web_smart_business",
        name: "Smart Business",
        tagline: "The Agent That Does The Work",
        badge: "Most Popular",
        features: [
          "Everything in Smart Site (25 pages)",
          "Advanced CRM — lead scoring + multi-level user access",
          "AI agent that TAKES ACTION: creates invoices, writes proposals, emails customers",
          "Conversion-optimized design with strategic CTAs",
        ],
        prices: [{ key: "web.smart_business.onetime", label: "Price", amount: 250000, suffix: "one-time" }],
        note: "Exact delivery timeline confirmed with your quote.",
      },
      {
        key: "web_smart_system",
        name: "Smart System",
        tagline: "One Smart System. Every Next Step.",
        badge: "Flagship",
        features: [
          "Everything in Smart Business — unlimited pages (fair use up to 50) + very advanced SEO",
          "AI agent on WhatsApp AND Instagram — follows up your CRM leads automatically",
          "3 custom workflow automations of your choice included",
          "Reminders & a far more interactive agent",
        ],
        prices: [{ key: "web.smart_system.onetime", label: "Price", amount: 450000, prefix: "from", suffix: "one-time" }],
        note: "Exact delivery timeline confirmed with your quote.",
      },
    ],
  },
  {
    key: "ecommerce",
    title: "E-Commerce",
    subtitle: "Custom-built online stores. One-time payment, free hosting under 1GB.",
    packages: [
      {
        key: "ecom_store",
        name: "E-Commerce Store",
        tagline: "Sell Online, Beautifully",
        features: [
          "100% custom-coded online store (Next.js) — no theme templates",
          "Product catalog, cart & secure checkout",
          "Payment gateway & delivery integration included",
          "Mobile-first, fast-loading, full technical SEO",
          "Free hosting forever (under 1GB media)",
        ],
        prices: [
          { key: "ecom.store.setup", label: "Price", amount: 150000, prefix: "from", suffix: "one-time" },
        ],
        note: "Delivery in 2–4 weeks. Includes 500MB backend; then $25/mo if exceeded.",
      },
      {
        key: "ecom_smart",
        name: "Smart Store System",
        tagline: "Store + Customer Profiles + Automations",
        badge: "Flagship",
        features: [
          "Everything in E-Commerce Store",
          "Customer profiles built automatically from every order & inquiry",
          "Order confirmation & delivery updates sent automatically",
          "Abandoned-cart recovery messages",
          "Marketing campaigns to your own customer list",
          "Every inquiry lands in your CRM pipeline — nothing lost",
        ],
        prices: [
          { key: "ecom.smart.total", label: "Full system", amount: 350000, prefix: "from", suffix: "one-time" },
          { key: "ecom.smart.layer", label: "Add to an existing ARC store", amount: 200000, prefix: "from", suffix: "one-time" },
        ],
        note: "Exact scope & price confirmed after a short call. Variable AI usage billed at cost.",
      },
      {
        key: "ecom_auto_addons",
        name: "Automation Add-Ons",
        tagline: "Extend the system, one automation at a time",
        features: [
          "Review & feedback requests after delivery",
          "Back-in-stock & restock alerts",
          "Birthday, loyalty & win-back offers",
          "Low-stock alerts to the owner",
          "Weekly sales report digests",
        ],
        prices: [
          { key: "ecom.addon.automation", label: "Per automation", amount: 30000, suffix: "each" },
        ],
        note: "Any automation beyond the Smart Store set — scoped and added one at a time.",
      },
    ],
  },
  {
    key: "ai",
    title: "AI & Automation",
    subtitle:
      "The agent packages are one-time — you pay only your own AI usage at cost. The older Flow/Engage/Qualify/Command tiers carry a monthly retainer.",
    packages: [
      {
        key: "ai_whatsapp_crm",
        name: "WhatsApp AI Agent + CRM",
        tagline: "Your best salesperson, on WhatsApp, 24/7",
        badge: "Flagship",
        features: [
          "Autonomous AI rep on the client's own WhatsApp number",
          "Answers, qualifies, follows up & books 24/7 — English, Sinhala & Tamil",
          "Full CRM included — every chat becomes a tracked lead",
          "Reads photos & payment slips; voice-note replies",
          "Standalone, or add on to any package",
        ],
        prices: [
          { key: "ai.whatsapp_crm.setup", label: "Setup", amount: 175000, suffix: "one-time" },
        ],
        note: "No monthly fee — you pay only your own AI usage, at cost. Live in ~5–7 working days.",
      },
      {
        key: "ai_instagram_crm",
        name: "Instagram AI Agent + CRM",
        tagline: "Every DM answered, every lead captured",
        features: [
          "Autonomous AI rep in the client's Instagram DMs",
          "Answers, qualifies, follows up & books 24/7 — English, Sinhala & Tamil",
          "Full CRM included — every chat becomes a tracked lead",
          "Standalone, or add on to any package",
        ],
        prices: [
          { key: "ai.instagram_crm.setup", label: "Setup", amount: 150000, suffix: "one-time" },
        ],
        note: "No monthly fee — you pay only your own AI usage, at cost. Live in ~5–7 working days.",
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
          { key: "web.addpage.other", label: "Additional page", amount: 6000, suffix: "/page" },
        ],
      },
    ],
  },
];
