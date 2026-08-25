import "server-only";

import fs from "node:fs";
import path from "node:path";

import type * as React from "react";

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

/**
 * The proposal PDF, in the same design language as the invoice (the template
 * the team actually likes): a big wordmark, thin rules, three-column header,
 * a bordered investment table, and the signed sign-off.
 *
 * Layout philosophy — ONE continuous flow. The old renderer forced each
 * section group onto its own A4 page, so a short group left half a page of
 * white space. Here there is a single <Page wrap> and react-pdf paginates
 * naturally: content fills every page top to bottom, section headings are
 * kept with their bodies (minPresenceAhead), and atomic rows never split
 * (wrap={false}). This file is ALSO the preview — the app shows the rendered
 * PDF itself, so what you see is literally the file the client gets.
 */

export type ProposalPdfData = {
  client_name: string;
  project_name: string;
  proposal_date: string; // ISO yyyy-mm-dd
  selection: ProposalSelection;
  content: ProposalContent;
};

// ---- Assets (inline public images as data URIs) ----------------------------
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

// ---- Palette — identical to the invoice ------------------------------------
const INK = "#171717";
const BODY = "#374151";
const MUTED = "#6b7280";
const LINE = "#d4d4d4";
const LINE_SOFT = "#e5e5e5";

const styles = StyleSheet.create({
  page: {
    paddingHorizontal: 34,
    paddingTop: 40,
    paddingBottom: 66,
    fontSize: 9,
    fontFamily: "Helvetica",
    color: BODY,
    lineHeight: 1.5,
  },

  // Header — mirrors the invoice's wordmark + rule + columns.
  wordmark: {
    fontSize: 50,
    fontFamily: "Helvetica-Bold",
    color: INK,
    letterSpacing: -1.5,
    lineHeight: 1,
    marginBottom: 14,
  },
  rule: { borderTopWidth: 1, borderTopColor: LINE, marginTop: 12 },
  headerRow: { flexDirection: "row", marginTop: 18 },
  col: { flex: 1, paddingRight: 14 },
  bold: { fontFamily: "Helvetica-Bold", color: INK },

  // Sections — numbered headings kept with their content.
  section: { marginTop: 20 },
  secHeadRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    paddingBottom: 5,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    marginBottom: 9,
  },
  secNum: { fontSize: 9, fontFamily: "Helvetica-Bold", color: MUTED, letterSpacing: 0.5 },
  secTitle: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    color: INK,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  para: { marginBottom: 5 },
  subHead: { fontFamily: "Helvetica-Bold", color: INK, marginTop: 7, marginBottom: 2.5 },
  note: { fontSize: 7.5, color: MUTED, marginTop: 4 },

  bulletRow: { flexDirection: "row", marginBottom: 2.5 },
  bulletDot: { width: 12, fontFamily: "Helvetica-Bold", color: INK },
  bulletText: { flex: 1 },

  // Timeline rows
  tlRow: { flexDirection: "row", marginBottom: 7, alignItems: "flex-start" },
  tlChip: {
    width: 17,
    height: 17,
    backgroundColor: INK,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 9,
    marginTop: 1,
  },
  tlChipText: { color: "#ffffff", fontSize: 7.5, fontFamily: "Helvetica-Bold" },
  tlBody: { flex: 1 },
  tlTitle: { fontFamily: "Helvetica-Bold", color: INK },
  tlDuration: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: MUTED,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 1,
  },

  // Investment table — the invoice grid, two columns.
  tHead: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: LINE,
  },
  tRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: LINE_SOFT },
  th: { fontFamily: "Helvetica-Bold", color: INK },
  hCell: { paddingHorizontal: 8, paddingVertical: 6 },
  bCell: { paddingHorizontal: 8, paddingVertical: 9 },
  wasPrice: { textDecoration: "line-through", color: MUTED },
  vLine: { borderLeftWidth: 1, borderLeftColor: LINE },
  vSoft: { borderLeftWidth: 1, borderLeftColor: LINE_SOFT },
  cDesc: { width: "78%" },
  cAmount: { width: "22%" },
  right: { textAlign: "right" },
  totals: { marginTop: 14, alignItems: "flex-end" },
  totalLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: 230,
    paddingVertical: 4,
  },
  totalRule: { borderTopWidth: 1, borderTopColor: LINE, width: 230 },

  // Sign-off — same shape as the invoice's.
  signRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: 16,
  },
  signature: { height: 58, width: 120, objectFit: "contain" },

  // Fixed page footer.
  footer: {
    position: "absolute",
    left: 34,
    right: 34,
    bottom: 26,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: LINE_SOFT,
    paddingTop: 6,
  },
  footerText: { fontSize: 7, color: MUTED },
});

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return null;
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

/** Numbered section: the heading refuses to sit orphaned at a page bottom. */
function Section({
  no,
  title,
  children,
}: {
  no: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.secHeadRow} minPresenceAhead={64}>
        <Text style={styles.secNum}>{String(no).padStart(2, "0")}</Text>
        <Text style={styles.secTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function ProposalPdfDoc({ data }: { data: ProposalPdfData }) {
  const c = data.content;
  const pricing = buildPricing(data.selection);
  const sig = asset("signature-mark.png");
  const dateStr = fmtDate(data.proposal_date);

  // Assemble sections in reading order; numbering skips anything empty.
  let no = 0;
  const n = () => ++no;

  return (
    <Document
      title={`Proposal — ${data.client_name || "Client"}`}
      author={PROPOSAL_COMPANY.name}
    >
      <Page size="A4" style={styles.page} wrap>
        {/* Fixed footer with page numbers */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {PROPOSAL_COMPANY.name} · {PROPOSAL_COMPANY.website} · {PROPOSAL_COMPANY.email}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>

        {/* Header — invoice-style */}
        <Text style={styles.wordmark}>PROPOSAL</Text>
        <View style={{ borderTopWidth: 1, borderTopColor: LINE }} />
        <View style={styles.headerRow}>
          <View style={styles.col}>
            <Text style={styles.bold}>{PROPOSAL_COMPANY.name}</Text>
            <Text>{PROPOSAL_COMPANY.phones}</Text>
            <Text>{PROPOSAL_COMPANY.email}</Text>
            <Text>{PROPOSAL_COMPANY.website}</Text>
            {PROPOSAL_COMPANY.addressLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={styles.col}>
            <Text style={styles.bold}>PREPARED FOR</Text>
            <Text>{data.client_name || "—"}</Text>
          </View>
          <View style={styles.col}>
            <Text style={styles.bold}>PROPOSAL</Text>
            <Text>Project: {data.project_name || "—"}</Text>
            <Text>Date: {dateStr}</Text>
          </View>
        </View>
        <View style={styles.rule} />

        {/* Sections — one continuous flow, no forced page breaks */}
        {c.overview ? (
          <Section no={n()} title="Overview">
            {c.overview.split("\n\n").map((p, i) => (
              <Text style={styles.para} key={i}>
                {p}
              </Text>
            ))}
          </Section>
        ) : null}

        {c.objectives.length ? (
          <Section no={n()} title="Objectives">
            {c.objectives.map((g, i) => (
              <View key={i} style={{ marginBottom: 6 }}>
                <Text style={styles.subHead}>{g.group}</Text>
                <Bullets items={g.items} />
              </View>
            ))}
          </Section>
        ) : null}

        {c.keyFeatures.length ? (
          <Section no={n()} title="Key Features">
            {c.keyFeatures.map((f, i) => (
              <View key={i} style={{ marginBottom: 6 }}>
                <Text style={styles.subHead}>{f.heading}</Text>
                {f.intro ? <Text style={styles.para}>{f.intro}</Text> : null}
                <Bullets items={f.bullets} />
              </View>
            ))}
          </Section>
        ) : null}

        {c.educational.intro || c.educational.bullets.length || c.educational.aiAgent ? (
          <Section no={n()} title="Educational Strategy">
            {c.educational.intro ? (
              <Text style={styles.para}>{c.educational.intro}</Text>
            ) : null}
            <Bullets items={c.educational.bullets} />
            {c.educational.aiAgent ? (
              <View style={{ marginTop: 5 }}>
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
          </Section>
        ) : null}

        {c.seo.bullets.length || c.seo.whyDedicated ? (
          <Section no={n()} title="SEO Optimization">
            <Bullets items={c.seo.bullets} />
            {c.seo.whyDedicated ? (
              <>
                <Text style={styles.subHead}>Why Dedicated Pages Matter</Text>
                <Text style={styles.para}>{c.seo.whyDedicated}</Text>
              </>
            ) : null}
          </Section>
        ) : null}

        {c.timeline.length ? (
          <Section no={n()} title="Timeline & Key Dates">
            {c.timeline.map((s, i) => (
              <View style={styles.tlRow} key={i} wrap={false}>
                <View style={styles.tlChip}>
                  <Text style={styles.tlChipText}>{String(i + 1).padStart(2, "0")}</Text>
                </View>
                <View style={styles.tlBody}>
                  <Text style={styles.tlTitle}>{s.title}</Text>
                  <Text>{s.description}</Text>
                  <Text style={styles.tlDuration}>{s.duration}</Text>
                </View>
              </View>
            ))}
          </Section>
        ) : null}

        <Section no={n()} title="Investment">
          <View style={styles.tHead} minPresenceAhead={40}>
            <Text style={[styles.hCell, styles.cDesc, styles.th]}>DESCRIPTION</Text>
            <Text style={[styles.hCell, styles.cAmount, styles.th, styles.vLine, styles.right]}>
              AMOUNT
            </Text>
          </View>
          {pricing.lineItems.map((l, i) => (
            <View style={styles.tRow} key={i} wrap={false}>
              <Text style={[styles.bCell, styles.cDesc]}>{l.label}</Text>
              <Text style={[styles.bCell, styles.cAmount, styles.vSoft, styles.right]}>
                {/* A negotiated price shows what it came down from, so the
                    client can see the reduction they were given. */}
                {typeof l.original === "number" ? (
                  <>
                    <Text style={styles.wasPrice}>{money(l.original)}</Text>
                    {/* Spacer kept OUTSIDE the struck run, or the line runs on
                        into the gap and the two figures read as one. */}
                    <Text>{"   "}</Text>
                  </>
                ) : null}
                {money(l.amount)}
              </Text>
            </View>
          ))}
          <View style={styles.totals} wrap={false}>
            <View style={styles.totalLine}>
              <Text style={styles.bold}>ONE-TIME TOTAL:</Text>
              <Text style={styles.bold}>{money(pricing.oneTimeTotal)}</Text>
            </View>
            {pricing.recurringNotes.length ? (
              <>
                <View style={styles.totalRule} />
                <View style={{ width: 230, paddingTop: 4 }}>
                  {pricing.recurringNotes.map((r, i) => (
                    <Text style={styles.note} key={i}>
                      {r}
                    </Text>
                  ))}
                </View>
              </>
            ) : null}
          </View>
        </Section>

        {c.paymentTerms.length || c.hosting.hosting ? (
          <Section no={n()} title="Terms of Payment">
            <Bullets items={c.paymentTerms} />
            {c.hosting.hosting || c.hosting.storage || c.hosting.domain ? (
              <>
                <Text style={styles.subHead}>Hosting, Domain & Third-Party Costs</Text>
                {c.hosting.hosting ? <Text style={styles.para}>{c.hosting.hosting}</Text> : null}
                {c.hosting.storage ? <Text style={styles.para}>{c.hosting.storage}</Text> : null}
                {c.hosting.domain ? <Text style={styles.para}>{c.hosting.domain}</Text> : null}
              </>
            ) : null}
          </Section>
        ) : null}

        {c.maintenance.length ? (
          <Section no={n()} title="Maintenance & Support">
            <Bullets items={c.maintenance} />
          </Section>
        ) : null}

        {c.quality.bullets.length || c.quality.assumptions.length || c.quality.nextSteps.length ? (
          <Section no={n()} title="Quality Standards">
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
          </Section>
        ) : null}

        {/* Sign-off — the invoice's signature block */}
        <View wrap={false}>
          <View style={styles.rule} />
          <View style={styles.signRow}>
            <View>
              <Text style={[styles.bold, { fontSize: 10 }]}>Prepared by</Text>
              <Text style={[styles.bold, { fontSize: 10 }]}>
                {PROPOSAL_SIGNOFF.preparedBy}
              </Text>
              <Text style={{ color: MUTED }}>Email — {PROPOSAL_SIGNOFF.email}</Text>
            </View>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
            {sig ? <Image src={sig} style={styles.signature} /> : null}
          </View>
        </View>
      </Page>
    </Document>
  );
}

/** Render a proposal to a PDF buffer (download, email, and the live preview). */
export async function renderProposalPdf(data: ProposalPdfData): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(<ProposalPdfDoc data={data} />));
}
