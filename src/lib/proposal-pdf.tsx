import "server-only";

import fs from "node:fs";
import path from "node:path";

import {
  Document,
  Font,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

import {
  PROPOSAL_COMPANY,
  PROPOSAL_SIGNOFF,
  buildPricing,
  money,
  type ProposalContent,
  type ProposalSelection,
} from "@/lib/proposal";

// Wrap on whole words only — never break a word mid-way with a hyphen.
Font.registerHyphenationCallback((word) => [word]);

export type ProposalPdfData = {
  client_name: string;
  project_name: string;
  proposal_date: string; // ISO yyyy-mm-dd
  selection: ProposalSelection;
  content: ProposalContent;
};

// ---- Asset loader (inline public images as data URIs) ---------------------
const assetCache: Record<string, string | null> = {};
function asset(name: string): string | null {
  if (name in assetCache) return assetCache[name];
  try {
    const p = path.join(process.cwd(), "public", name);
    assetCache[name] = `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
  } catch {
    assetCache[name] = null;
  }
  return assetCache[name];
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ---- Palette --------------------------------------------------------------
const INK = "#0f172a";
const BODY = "#374151";
const MUTED = "#6b7280";
const FAINT = "#9ca3af";
const ACCENT = "#2f2fc0";
const ACCENT_SOFT = "#eef2ff";
const LINE = "#e5e7eb";

const styles = StyleSheet.create({
  // Cover — A4 is 595.28 x 841.89pt; give the background image explicit
  // dimensions so it's a true out-of-flow backdrop (a "100%" height makes
  // react-pdf treat it as an oversized in-flow block that takes its own page).
  cover: { position: "relative", color: "#ffffff" },
  coverBg: { position: "absolute", top: 0, left: 0, width: 595.28, height: 841.89 },
  coverInner: {
    position: "relative",
    paddingHorizontal: 46,
    paddingVertical: 52,
    height: "100%",
    flexDirection: "column",
    justifyContent: "space-between",
  },
  coverTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  wordmark: { width: 158, height: 44, objectFit: "contain" },
  metaLabel: { fontSize: 8, fontFamily: "Helvetica-Bold", color: "#5eead4", letterSpacing: 1 },
  metaValue: { fontSize: 11, fontFamily: "Helvetica-Bold", color: "#ffffff", marginBottom: 8 },
  coverTitle: { fontSize: 52, fontFamily: "Helvetica-Bold", color: "#ffffff", lineHeight: 1.05 },
  coverDate: { fontSize: 12, color: "#cbd5e1", marginTop: 14 },
  coverFooter: { flexDirection: "row", gap: 28 },
  coverFootLabel: { fontSize: 8, fontFamily: "Helvetica-Bold", color: "#5eead4", letterSpacing: 1, marginBottom: 3 },
  coverFootText: { fontSize: 8.5, color: "#e2e8f0", lineHeight: 1.5 },

  // Content page
  page: {
    position: "relative",
    paddingTop: 54,
    paddingBottom: 90,
    paddingHorizontal: 46,
    fontSize: 11,
    fontFamily: "Helvetica",
    color: BODY,
    lineHeight: 1.55,
  },
  shield: { position: "absolute", top: 26, right: 30, width: 52, height: 52, objectFit: "contain" },
  footerBand: { position: "absolute", bottom: 0, left: 0, width: "100%" },
  pageNum: {
    position: "absolute",
    top: 26,
    left: 46,
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    color: FAINT,
    letterSpacing: 1,
  },

  section: { marginBottom: 28 },
  secHead: { flexDirection: "row", alignItems: "flex-end", gap: 10, marginBottom: 4 },
  secNum: { fontSize: 24, fontFamily: "Helvetica-Bold", color: FAINT },
  secTitle: { fontSize: 22, fontFamily: "Helvetica-Bold", color: INK },
  secRule: { borderBottomWidth: 1, borderBottomColor: LINE, marginBottom: 12, marginTop: 6 },

  para: { marginBottom: 8, color: BODY, fontSize: 11 },
  subHead: { fontSize: 13, fontFamily: "Helvetica-Bold", color: INK, marginTop: 10, marginBottom: 4 },

  bulletRow: { flexDirection: "row", marginBottom: 4, paddingRight: 10 },
  bulletDot: { width: 12, color: ACCENT, fontFamily: "Helvetica-Bold", fontSize: 11 },
  bulletText: { flex: 1, color: BODY, fontSize: 11 },

  structRow: { marginBottom: 8 },
  structPage: { fontFamily: "Helvetica-Bold", color: INK, fontSize: 11 },

  // Timeline
  tlRow: { flexDirection: "row", marginBottom: 12 },
  tlNum: {
    width: 36,
    height: 36,
    backgroundColor: INK,
    color: "#fff",
    fontFamily: "Helvetica-Bold",
    fontSize: 13,
    textAlign: "center",
    paddingTop: 10,
    borderRadius: 4,
    marginRight: 14,
  },
  tlTitle: { fontFamily: "Helvetica-Bold", color: INK, fontSize: 11 },
  tlDuration: { fontSize: 9, color: FAINT, marginTop: 3, fontFamily: "Helvetica-Bold" },

  // Pricing
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    paddingVertical: 8,
  },
  priceLabel: { color: BODY, flex: 1, paddingRight: 12, fontSize: 11 },
  priceAmt: { fontFamily: "Helvetica-Bold", color: INK, fontSize: 11 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: ACCENT_SOFT,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 8,
    borderRadius: 6,
  },
  totalLabel: { fontFamily: "Helvetica-Bold", color: ACCENT, fontSize: 13 },
  totalAmt: { fontFamily: "Helvetica-Bold", color: ACCENT, fontSize: 14 },
  note: { fontSize: 9.5, color: MUTED, marginTop: 6 },

  prepared: { marginTop: 18 },
});

function Bullets({ items }: { items: string[] }) {
  return (
    <View>
      {items.map((it, i) => (
        <View style={styles.bulletRow} key={i} wrap={false}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>{it}</Text>
        </View>
      ))}
    </View>
  );
}

function Section({
  num,
  title,
  children,
}: {
  num: number;
  title: string;
  children: React.ReactNode;
}) {
  const n = String(num).padStart(2, "0");
  return (
    <View style={styles.section}>
      <View style={styles.secHead}>
        <Text style={styles.secNum}>{n}</Text>
        <Text style={styles.secTitle}>{title}</Text>
      </View>
      <View style={styles.secRule} />
      {children}
    </View>
  );
}

function ProposalPdfDoc({ data }: { data: ProposalPdfData }) {
  const { content: c, selection } = data;
  const pricing = buildPricing(selection);
  const coverBg = asset("proposal/cover-bg.png");
  const logo = asset("new-logo.png");
  const shield = asset("proposal/shield.png");
  const footerBand = asset("proposal/footer-band.png");

  // Build the section list in order, skipping empty ones, so numbering stays
  // correct regardless of which sections have content.
  // Build individual sections
  const overviewSec = c.overview
    ? {
        title: "Overview",
        body: (
          <View>
            {c.overview.split("\n\n").map((p, i) => (
              <Text style={styles.para} key={i}>
                {p}
              </Text>
            ))}
          </View>
        ),
      }
    : null;

  const objectivesSec = c.objectives.length
    ? {
        title: "Objectives",
        body: (
          <View>
            {c.objectives.map((g, i) => (
              <View key={i} wrap={false} style={{ marginBottom: 6 }}>
                <Text style={styles.subHead}>{g.group}</Text>
                <Bullets items={g.items} />
              </View>
            ))}
          </View>
        ),
      }
    : null;

  const structSec = c.websiteStructure.length
    ? {
        title: "Website Structure",
        body: (
          <View>
            {c.websiteStructure.map((p, i) => (
              <View style={styles.structRow} key={i} wrap={false}>
                <Text style={styles.structPage}>{p.page}</Text>
                <Text>{p.description}</Text>
              </View>
            ))}
          </View>
        ),
      }
    : null;

  const featuresSec = c.keyFeatures.length
    ? {
        title: "Key Features",
        body: (
          <View>
            {c.keyFeatures.map((f, i) => (
              <View key={i} style={{ marginBottom: 8 }}>
                <Text style={styles.subHead}>{f.heading}</Text>
                {f.intro ? <Text style={styles.para}>{f.intro}</Text> : null}
                <Bullets items={f.bullets} />
              </View>
            ))}
          </View>
        ),
      }
    : null;

  const eduSec =
    c.educational.intro || c.educational.bullets.length || c.educational.aiAgent
      ? {
          title: "Educational Strategy",
          body: (
            <View>
              {c.educational.intro ? (
                <Text style={styles.para}>{c.educational.intro}</Text>
              ) : null}
              <Bullets items={c.educational.bullets} />
              {c.educational.aiAgent ? (
                <View style={{ marginTop: 8 }}>
                  <Text style={styles.subHead}>AI Customer Support Agent</Text>
                  {c.educational.aiAgent.intro ? (
                    <Text style={styles.para}>{c.educational.aiAgent.intro}</Text>
                  ) : null}
                  <Bullets items={c.educational.aiAgent.capabilities} />
                  {c.educational.aiAgent.note ? (
                    <Text style={styles.note}>{c.educational.aiAgent.note}</Text>
                  ) : null}
                </View>
              ) : null}
            </View>
          ),
        }
      : null;

  const seoSec =
    c.seo.bullets.length || c.seo.whyDedicated
      ? {
          title: "SEO Optimization",
          body: (
            <View>
              <Bullets items={c.seo.bullets} />
              {c.seo.whyDedicated ? (
                <>
                  <Text style={styles.subHead}>Why Dedicated Pages Matter</Text>
                  <Text style={styles.para}>{c.seo.whyDedicated}</Text>
                </>
              ) : null}
            </View>
          ),
        }
      : null;

  const timelineSec = c.timeline.length
    ? {
        title: "Timeline & Key Dates",
        body: (
          <View>
            {c.timeline.map((s, i) => (
              <View style={styles.tlRow} key={i} wrap={false}>
                <Text style={styles.tlNum}>{String(i + 1).padStart(2, "0")}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.tlTitle}>{s.title}</Text>
                  <Text>{s.description}</Text>
                  <Text style={styles.tlDuration}>{s.duration}</Text>
                </View>
              </View>
            ))}
          </View>
        ),
      }
    : null;

  // Investment (always present — driven by the selection)
  const pricingSec = {
    title: "Investment",
    body: (
      <View>
        {pricing.lineItems.map((l, i) => (
          <View style={styles.priceRow} key={i} wrap={false}>
            <Text style={styles.priceLabel}>{l.label}</Text>
            <Text style={styles.priceAmt}>{money(l.amount)}</Text>
          </View>
        ))}
        <View style={styles.totalRow} wrap={false}>
          <Text style={styles.totalLabel}>ONE-TIME TOTAL</Text>
          <Text style={styles.totalAmt}>{money(pricing.oneTimeTotal)}</Text>
        </View>
        {pricing.recurringNotes.length ? (
          <Text style={styles.note}>
            Recurring / external: {pricing.recurringNotes.join(" · ")}
          </Text>
        ) : null}
      </View>
    ),
  };

  const termsSec =
    c.paymentTerms.length || c.hosting.hosting
      ? {
          title: "Terms of Payment",
          body: (
            <View>
              <Bullets items={c.paymentTerms} />
              <Text style={styles.subHead}>Hosting, Domain & Third-Party Costs</Text>
              {c.hosting.hosting ? (
                <Text style={styles.para}>{c.hosting.hosting}</Text>
              ) : null}
              {c.hosting.storage ? (
                <Text style={styles.para}>{c.hosting.storage}</Text>
              ) : null}
              {c.hosting.domain ? (
                <Text style={styles.para}>{c.hosting.domain}</Text>
              ) : null}
            </View>
          ),
        }
      : null;

  const maintSec = c.maintenance.length
    ? {
        title: "Maintenance & Support",
        body: <Bullets items={c.maintenance} />,
      }
    : null;

  const qualitySec = {
    title: "Quality Standards",
    body: (
      <View>
        <Bullets items={c.quality.bullets} />
        {c.quality.assumptions.length ? (
          <>
            <Text style={styles.subHead}>Assumptions & Exclusions</Text>
            <Bullets items={c.quality.assumptions} />
          </>
        ) : null}
        {c.quality.nextSteps.length ? (
          <>
            <Text style={styles.subHead}>Next Steps</Text>
            <Bullets items={c.quality.nextSteps} />
          </>
        ) : null}
        <View style={styles.prepared} wrap={false}>
          <Text style={styles.subHead}>Prepared by</Text>
          <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>
            {PROPOSAL_SIGNOFF.preparedBy}
          </Text>
          <Text style={{ color: MUTED }}>Email — {PROPOSAL_SIGNOFF.email}</Text>
        </View>
      </View>
    ),
  };

  // Group sections logically into distinct pages to optimize space
  const pageGroups: { sections: { title: string; body: React.ReactNode }[] }[] = [];

  // Page 2: Overview & Objectives
  const p2Secs = [overviewSec, objectivesSec].filter(Boolean) as {
    title: string;
    body: React.ReactNode;
  }[];
  if (p2Secs.length) pageGroups.push({ sections: p2Secs });

  // Page 3: Website Structure & Key Features
  const p3Secs = [structSec, featuresSec].filter(Boolean) as {
    title: string;
    body: React.ReactNode;
  }[];
  if (p3Secs.length) pageGroups.push({ sections: p3Secs });

  // Page 4: Educational Strategy & SEO Optimization
  const p4Secs = [eduSec, seoSec].filter(Boolean) as {
    title: string;
    body: React.ReactNode;
  }[];
  if (p4Secs.length) pageGroups.push({ sections: p4Secs });

  // Page 5: Timeline & Key Dates
  const p5Secs = [timelineSec].filter(Boolean) as {
    title: string;
    body: React.ReactNode;
  }[];
  if (p5Secs.length) pageGroups.push({ sections: p5Secs });

  // Page 6: Investment, Terms of Payment & Maintenance Support
  const p6Secs = [pricingSec, termsSec, maintSec].filter(Boolean) as {
    title: string;
    body: React.ReactNode;
  }[];
  if (p6Secs.length) pageGroups.push({ sections: p6Secs });

  // Page 7: Quality Standards
  const p7Secs = [qualitySec].filter(Boolean) as {
    title: string;
    body: React.ReactNode;
  }[];
  if (p7Secs.length) pageGroups.push({ sections: p7Secs });

  // Sequential numbering based on all visible sections
  const allActiveSections = pageGroups.flatMap((pg) => pg.sections);
  const getSectionNumber = (title: string) => {
    const idx = allActiveSections.findIndex((s) => s.title === title);
    return idx !== -1 ? idx + 1 : 1;
  };

  return (
    <Document
      title={`Proposal — ${data.client_name || "ARC AI"}`}
      author={PROPOSAL_COMPANY.name}
    >
      {/* Cover */}
      <Page size="A4" style={styles.cover}>
        {coverBg ? (
          /* eslint-disable-next-line jsx-a11y/alt-text */
          <Image src={coverBg} style={styles.coverBg} fixed />
        ) : null}
        <View style={styles.coverInner}>
          <View style={styles.coverTop}>
            {logo ? (
              /* eslint-disable-next-line jsx-a11y/alt-text */
              <Image src={logo} style={styles.wordmark} />
            ) : (
              <Text style={{ fontSize: 22, fontFamily: "Helvetica-Bold", color: "#fff" }}>
                ARC AI
              </Text>
            )}
            <View style={{ alignItems: "flex-end" }}>
              <Text style={styles.metaLabel}>CLIENT NAME</Text>
              <Text style={styles.metaValue}>{data.client_name || "—"}</Text>
              <Text style={styles.metaLabel}>PROJECT NAME</Text>
              <Text style={styles.metaValue}>{data.project_name || "—"}</Text>
            </View>
          </View>

          <View>
            <Text style={styles.coverTitle}>Project</Text>
            <Text style={styles.coverTitle}>Proposal</Text>
            <Text style={styles.coverDate}>{fmtDate(data.proposal_date)}</Text>
          </View>

          <View style={styles.coverFooter}>
            <View style={{ flex: 1 }}>
              <Text style={styles.coverFootLabel}>ADDRESS</Text>
              {PROPOSAL_COMPANY.addressLines.map((l, i) => (
                <Text style={styles.coverFootText} key={i}>
                  {l}
                </Text>
              ))}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.coverFootLabel}>PHONE</Text>
              <Text style={styles.coverFootText}>{PROPOSAL_COMPANY.phones}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.coverFootLabel}>WEB</Text>
              <Text style={styles.coverFootText}>{PROPOSAL_COMPANY.email}</Text>
              <Text style={styles.coverFootText}>{PROPOSAL_COMPANY.website}</Text>
            </View>
          </View>
        </View>
      </Page>

      {/* Content Pages */}
      {pageGroups.map((page, i) => (
        <Page size="A4" style={styles.page} key={i}>
          <Text style={styles.pageNum}>PAGE {i + 2}</Text>
          {shield ? (
            /* eslint-disable-next-line jsx-a11y/alt-text */
            <Image src={shield} style={styles.shield} fixed />
          ) : null}
          {footerBand ? (
            /* eslint-disable-next-line jsx-a11y/alt-text */
            <Image src={footerBand} style={styles.footerBand} fixed />
          ) : null}
          {page.sections.map((s, j) => (
            <Section key={j} num={getSectionNumber(s.title)} title={s.title}>
              {s.body}
            </Section>
          ))}
        </Page>
      ))}
    </Document>
  );
}

/** Render a proposal to a PDF buffer for download. */
export async function renderProposalPdf(data: ProposalPdfData): Promise<Buffer> {
  return renderToBuffer(<ProposalPdfDoc data={data} />);
}
