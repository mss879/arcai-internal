import "server-only";

import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

import { PROPOSAL_COMPANY } from "@/lib/proposal";
import {
  applyOverrides,
  formatPriceField,
  type PriceField,
  type PricingGroup,
  type PricingOverrides,
  type PricingPackage,
} from "@/lib/pricing-catalog";

// Wrap on whole words only — never break a word mid-way with a hyphen.
Font.registerHyphenationCallback((word) => [word]);

export type PricingPdfData = {
  overrides?: PricingOverrides;
  /** Pretty date, e.g. "13 Jul 2026". Rendered in the header. */
  dateLabel?: string;
};

// ---- Palette (ARC AI orange) ----------------------------------------------
const BRAND = "#f97316";
const BRAND_DARK = "#c2410c";
const INK = "#0f172a";
const BODY = "#374151";
const MUTED = "#6b7280";
const FAINT = "#9ca3af";
const LINE = "#e5e7eb";
const SOFT = "#fff7ed"; // orange-50

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 58,
    paddingHorizontal: 40,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: BODY,
    lineHeight: 1.5,
  },

  // Header band
  header: {
    backgroundColor: BRAND,
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 24,
    marginBottom: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  wordmark: { fontSize: 22, fontFamily: "Helvetica-Bold", color: "#ffffff", lineHeight: 1.1 },
  headerSub: { fontSize: 10, color: "#ffedd5", marginTop: 4, lineHeight: 1.2 },
  headerRightLabel: { fontSize: 8, fontFamily: "Helvetica-Bold", color: "#ffedd5", letterSpacing: 1, textAlign: "right" },
  headerRightValue: { fontSize: 11, fontFamily: "Helvetica-Bold", color: "#ffffff", textAlign: "right", marginTop: 2 },

  intro: { fontSize: 9.5, color: MUTED, marginBottom: 16 },

  // Group section
  section: { marginBottom: 18 },
  secTitle: { fontSize: 15, fontFamily: "Helvetica-Bold", color: BRAND_DARK },
  secSub: { fontSize: 9, color: MUTED, marginTop: 2 },
  secRule: { borderBottomWidth: 2, borderBottomColor: BRAND, marginTop: 6, marginBottom: 12, width: 48 },

  // Package card
  card: {
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  cardLeft: { flex: 1, paddingRight: 16 },
  cardRight: { width: 150, borderLeftWidth: 1, borderLeftColor: LINE, paddingLeft: 14 },

  nameRow: { flexDirection: "row", alignItems: "center", marginBottom: 2 },
  name: { fontSize: 13, fontFamily: "Helvetica-Bold", color: INK },
  badge: {
    marginLeft: 8,
    backgroundColor: SOFT,
    color: BRAND_DARK,
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 20,
    letterSpacing: 0.3,
  },
  tagline: { fontSize: 9, color: BRAND_DARK, marginBottom: 6 },

  bulletRow: { flexDirection: "row", marginBottom: 2.5, paddingRight: 6 },
  bulletDot: { width: 10, color: BRAND, fontFamily: "Helvetica-Bold", fontSize: 9 },
  bulletText: { flex: 1, color: BODY, fontSize: 9 },

  note: { fontSize: 8, color: FAINT, marginTop: 6, fontFamily: "Helvetica-Oblique" },

  // Price block (right column)
  priceLine: { marginBottom: 8 },
  priceLabel: { fontSize: 8, color: MUTED, fontFamily: "Helvetica-Bold", letterSpacing: 0.3 },
  priceValue: { fontSize: 14, fontFamily: "Helvetica-Bold", color: INK, marginTop: 1 },
  freeValue: { fontSize: 13, fontFamily: "Helvetica-Bold", color: BRAND_DARK },

  // Add-on rows (packages with no features — a simple priced list)
  addonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    paddingVertical: 6,
  },
  addonRowLast: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
  },
  addonLabel: { fontSize: 10, color: BODY, flex: 1, paddingRight: 12 },
  addonAmt: { fontSize: 11, fontFamily: "Helvetica-Bold", color: INK },

  // Footer
  footer: {
    position: "absolute",
    bottom: 24,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: LINE,
    paddingTop: 8,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footText: { fontSize: 7.5, color: FAINT },
});

function Price({ field }: { field: PriceField }) {
  return (
    <View style={styles.priceLine}>
      <Text style={styles.priceLabel}>{field.label.toUpperCase()}</Text>
      <Text style={styles.priceValue}>{formatPriceField(field)}</Text>
    </View>
  );
}

/** A rich card: features on the left, headline price(s) on the right. */
function FeatureCard({ pkg }: { pkg: PricingPackage }) {
  return (
    <View style={styles.card} wrap={false}>
      <View style={styles.cardLeft}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>{pkg.name}</Text>
          {pkg.badge ? <Text style={styles.badge}>{pkg.badge.toUpperCase()}</Text> : null}
        </View>
        {pkg.tagline ? <Text style={styles.tagline}>{pkg.tagline}</Text> : null}
        {(pkg.features ?? []).map((f, i) => (
          <View style={styles.bulletRow} key={i} wrap={false}>
            <Text style={styles.bulletDot}>•</Text>
            <Text style={styles.bulletText}>{f}</Text>
          </View>
        ))}
        {pkg.note ? <Text style={styles.note}>{pkg.note}</Text> : null}
      </View>
      <View style={styles.cardRight}>
        {pkg.prices.length === 0 ? (
          <Text style={styles.freeValue}>{pkg.note ? pkg.note : "Free"}</Text>
        ) : (
          pkg.prices.map((p) => <Price key={p.key} field={p} />)
        )}
      </View>
    </View>
  );
}

/** A compact card: no feature list — just a titled list of priced line items. */
function ListCard({ pkg }: { pkg: PricingPackage }) {
  return (
    <View style={styles.card} wrap={false}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.name, { marginBottom: 6 }]}>{pkg.name}</Text>
        {pkg.prices.map((p, i) => (
          <View
            key={p.key}
            style={i === pkg.prices.length - 1 ? styles.addonRowLast : styles.addonRow}
          >
            <Text style={styles.addonLabel}>{p.label}</Text>
            <Text style={styles.addonAmt}>{formatPriceField(p)}</Text>
          </View>
        ))}
        {pkg.note ? <Text style={styles.note}>{pkg.note}</Text> : null}
      </View>
    </View>
  );
}

function GroupSection({ group }: { group: PricingGroup }) {
  return (
    <View style={styles.section}>
      <Text style={styles.secTitle}>{group.title}</Text>
      {group.subtitle ? <Text style={styles.secSub}>{group.subtitle}</Text> : null}
      <View style={styles.secRule} />
      {group.packages.map((pkg) =>
        pkg.features && pkg.features.length > 0 ? (
          <FeatureCard key={pkg.key} pkg={pkg} />
        ) : pkg.prices.length === 0 ? (
          <FeatureCard key={pkg.key} pkg={pkg} />
        ) : (
          <ListCard key={pkg.key} pkg={pkg} />
        ),
      )}
    </View>
  );
}

function PricingDoc({ groups, dateLabel }: { groups: PricingGroup[]; dateLabel: string }) {
  return (
    <Document title="ARC AI — Pricing" author={PROPOSAL_COMPANY.name}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View>
            <Text style={styles.wordmark}>ARC AI</Text>
            <Text style={styles.headerSub}>Services & Pricing</Text>
          </View>
          <View>
            <Text style={styles.headerRightLabel}>PRICE LIST</Text>
            <Text style={styles.headerRightValue}>{dateLabel}</Text>
          </View>
        </View>

        <Text style={styles.intro}>
          All prices in LKR (Rs) unless marked. Setup fees are one-time; monthly figures are
          recurring. Prices are indicative and valid as of {dateLabel} — please confirm with the team
          before finalizing.
        </Text>

        {groups.map((g) => (
          <GroupSection key={g.key} group={g} />
        ))}

        <View style={styles.footer} fixed>
          <Text style={styles.footText}>
            {PROPOSAL_COMPANY.name} · {PROPOSAL_COMPANY.email} · {PROPOSAL_COMPANY.website}
          </Text>
          <Text
            style={styles.footText}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}

/** Render the current pricing (defaults + overrides) to a PDF Buffer. */
export async function renderPricingPdf(data: PricingPdfData = {}): Promise<Buffer> {
  const groups = applyOverrides(data.overrides ?? {});
  const dateLabel = data.dateLabel || "";
  return Buffer.from(await renderToBuffer(<PricingDoc groups={groups} dateLabel={dateLabel} />));
}
