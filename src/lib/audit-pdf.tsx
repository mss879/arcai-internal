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

// Wrap on whole words only — never break a word mid-way with a hyphen.
Font.registerHyphenationCallback((word) => [word]);

/**
 * The branded website-audit report the WhatsApp agent attaches (as a PDF
 * document message) right after the redesign mockup. Selectable-text PDF
 * rendered with @react-pdf — the same serverless-safe engine as invoices
 * and proposals.
 */

export type StrategyReadings = {
  performance: number;
  seo: number;
  accessibility: number;
  best_practices: number;
  metrics: { label: string; value: string }[];
  failed_audits: string[];
};

export type OnPageCheck = { label: string; pass: boolean; note: string };

export type AuditReportData = {
  business: string;
  url: string;
  dateISO: string;
  mobile: StrategyReadings | null;
  desktop: StrategyReadings | null;
  onPage: OnPageCheck[];
  otherIssues: string[];
  summary?: string;
};

const ORANGE = "#ea580c";
const DARK = "#0f172a";
const SLATE = "#475569";
const LIGHT = "#94a3b8";
const LINE = "#e2e8f0";

const styles = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 56,
    paddingHorizontal: 46,
    fontSize: 9.5,
    color: DARK,
    fontFamily: "Helvetica",
  },
  headerBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 18,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: ORANGE,
  },
  wordmark: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  headerTag: { fontSize: 8, color: LIGHT, letterSpacing: 2 },
  h1: { fontSize: 24, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  h2: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    marginTop: 18,
    marginBottom: 8,
  },
  sub: { color: SLATE, lineHeight: 1.5 },
  scoreRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  scoreCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 6,
    padding: 10,
    alignItems: "center",
  },
  scoreValue: { fontSize: 22, fontFamily: "Helvetica-Bold" },
  scoreLabel: { fontSize: 8, color: SLATE, marginTop: 3, textAlign: "center" },
  tableHead: {
    flexDirection: "row",
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: LINE,
    paddingVertical: 5,
    paddingHorizontal: 8,
    marginTop: 8,
  },
  tableRow: {
    flexDirection: "row",
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: LINE,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },
  cellLabel: { flex: 2.2, color: SLATE },
  cell: { flex: 1, textAlign: "center" },
  cellHead: { fontFamily: "Helvetica-Bold", fontSize: 8.5 },
  issue: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 5,
    paddingBottom: 5,
    borderBottomWidth: 0.5,
    borderBottomColor: LINE,
  },
  issueMark: { color: ORANGE, fontFamily: "Helvetica-Bold" },
  issueText: { flex: 1, lineHeight: 1.45, color: DARK },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 46,
    right: 46,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: LIGHT,
    borderTopWidth: 0.5,
    borderTopColor: LINE,
    paddingTop: 6,
  },
  cta: {
    marginTop: 22,
    backgroundColor: ORANGE,
    borderRadius: 8,
    padding: 16,
  },
  ctaTitle: { color: "#ffffff", fontSize: 13, fontFamily: "Helvetica-Bold" },
  ctaText: { color: "#ffedd5", marginTop: 4, lineHeight: 1.5 },
});

function scoreColor(v: number): string {
  if (v >= 80) return "#059669";
  if (v >= 50) return "#d97706";
  return "#e11d48";
}

function fmtScore(v: number | undefined): string {
  return v != null && v >= 0 ? String(v) : "—";
}

function Header() {
  return (
    <View style={styles.headerBar} fixed>
      <Text style={styles.wordmark}>
        ARC <Text style={{ color: ORANGE }}>AI</Text>
      </Text>
      <Text style={styles.headerTag}>WEBSITE AUDIT REPORT</Text>
    </View>
  );
}

function Footer() {
  return (
    <View style={styles.footer} fixed>
      <Text>
        {PROPOSAL_COMPANY.name} · {PROPOSAL_COMPANY.website} · {PROPOSAL_COMPANY.email}
      </Text>
      <Text
        render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
      />
    </View>
  );
}

function ScoreCards({ readings }: { readings: StrategyReadings }) {
  const items = [
    { label: "Performance", value: readings.performance },
    { label: "SEO", value: readings.seo },
    { label: "Accessibility", value: readings.accessibility },
    { label: "Best practices", value: readings.best_practices },
  ];
  return (
    <View style={styles.scoreRow}>
      {items.map((s) => (
        <View key={s.label} style={styles.scoreCard}>
          <Text style={[styles.scoreValue, { color: s.value >= 0 ? scoreColor(s.value) : LIGHT }]}>
            {fmtScore(s.value)}
          </Text>
          <Text style={styles.scoreLabel}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}

function AuditReport({ data }: { data: AuditReportData }) {
  const metricLabels = Array.from(
    new Set([
      ...(data.mobile?.metrics ?? []).map((m) => m.label),
      ...(data.desktop?.metrics ?? []).map((m) => m.label),
    ]),
  );
  const metricOf = (r: StrategyReadings | null, label: string) =>
    r?.metrics.find((m) => m.label === label)?.value ?? "—";

  const allIssues = Array.from(
    new Set([
      ...(data.mobile?.failed_audits ?? []),
      ...(data.desktop?.failed_audits ?? []),
      ...data.otherIssues,
    ]),
  );

  return (
    <Document
      title={`${data.business} — Website Audit`}
      author={PROPOSAL_COMPANY.name}
    >
      <Page size="A4" style={styles.page}>
        <Header />

        <Text style={{ fontSize: 8.5, color: ORANGE, letterSpacing: 2, marginBottom: 5 }}>
          PREPARED EXCLUSIVELY FOR
        </Text>
        <Text style={styles.h1}>{data.business}</Text>
        <Text style={{ color: SLATE, marginBottom: 2 }}>{data.url}</Text>
        <Text style={{ color: LIGHT, fontSize: 8.5 }}>
          Audited {data.dateISO} · Google Lighthouse (mobile + desktop) + on-page analysis
        </Text>

        {data.summary ? (
          <>
            <Text style={styles.h2}>About your business</Text>
            <Text style={styles.sub}>{data.summary}</Text>
          </>
        ) : null}

        {data.mobile && (
          <>
            <Text style={styles.h2}>Mobile scores — how most visitors see you</Text>
            <ScoreCards readings={data.mobile} />
          </>
        )}
        {data.desktop && (
          <>
            <Text style={styles.h2}>Desktop scores</Text>
            <ScoreCards readings={data.desktop} />
          </>
        )}
        <Text style={{ color: LIGHT, fontSize: 8, marginTop: 8 }}>
          Scores are 0–100, measured with Google Lighthouse — the same engine Google
          uses when deciding how to rank websites. 0–49 poor · 50–79 needs work ·
          80+ good.
        </Text>

        {metricLabels.length > 0 && (
          <>
            <Text style={styles.h2}>Key speed readings</Text>
            <View style={styles.tableHead}>
              <Text style={[styles.cellLabel, styles.cellHead]}>Metric</Text>
              <Text style={[styles.cell, styles.cellHead]}>Mobile</Text>
              <Text style={[styles.cell, styles.cellHead]}>Desktop</Text>
            </View>
            {metricLabels.map((label) => (
              <View key={label} style={styles.tableRow}>
                <Text style={styles.cellLabel}>{label}</Text>
                <Text style={styles.cell}>{metricOf(data.mobile, label)}</Text>
                <Text style={styles.cell}>{metricOf(data.desktop, label)}</Text>
              </View>
            ))}
          </>
        )}
        <Footer />
      </Page>

      <Page size="A4" style={styles.page}>
        <Header />

        {allIssues.length > 0 && (
          <>
            <Text style={styles.h2}>Everything we found</Text>
            <Text style={[styles.sub, { marginBottom: 8 }]}>
              Each of these is costing you visitors, Google ranking, or both — and
              every single one is fixable.
            </Text>
            {allIssues.map((issue, i) => (
              <View key={issue} style={styles.issue} wrap={false}>
                <Text style={styles.issueMark}>{String(i + 1).padStart(2, "0")}</Text>
                <Text style={styles.issueText}>{issue}</Text>
              </View>
            ))}
          </>
        )}

        {data.onPage.length > 0 && (
          <>
            <Text style={styles.h2}>On-page SEO essentials</Text>
            <View style={styles.tableHead}>
              <Text style={[styles.cellLabel, styles.cellHead]}>Check</Text>
              <Text style={[styles.cell, styles.cellHead]}>Status</Text>
              <Text style={[{ flex: 2.2 }, styles.cellHead]}>Why it matters</Text>
            </View>
            {data.onPage.map((check) => (
              <View key={check.label} style={styles.tableRow} wrap={false}>
                <Text style={styles.cellLabel}>{check.label}</Text>
                <Text
                  style={[
                    styles.cell,
                    {
                      color: check.pass ? "#059669" : "#e11d48",
                      fontFamily: "Helvetica-Bold",
                    },
                  ]}
                >
                  {check.pass ? "PASS" : "MISSING"}
                </Text>
                <Text style={{ flex: 2.2, color: SLATE, fontSize: 8.5 }}>{check.note}</Text>
              </View>
            ))}
          </>
        )}

        <View style={styles.cta} wrap={false}>
          <Text style={styles.ctaTitle}>Ready to fix all of this?</Text>
          <Text style={styles.ctaText}>
            Everything in this report — the speed, the SEO gaps, the design — is what
            we do every day. Reply on WhatsApp and we&apos;ll walk you through exactly
            what we&apos;d change, or call {PROPOSAL_COMPANY.phones}.
          </Text>
        </View>
        <Footer />
      </Page>
    </Document>
  );
}

/** Render the report to a Buffer, ready for storage upload. */
export async function renderAuditReportPdf(data: AuditReportData): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(<AuditReport data={data} />));
}
