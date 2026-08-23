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
import type { ExportRow } from "@/lib/project-export";

// Wrap on whole words only — never break a word mid-way with a hyphen.
Font.registerHyphenationCallback((word) => [word]);

export type ProjectsReportData = {
  rows: ExportRow[];
  /** Pretty date, e.g. "23 Aug 2026". Rendered in the header. */
  dateLabel: string;
  /** What was on screen when this was exported — printed so the numbers can
   *  be trusted six months later. */
  filterSummary: string;
  /** Margin is admin-only, matching commissions (invariant 9). */
  includeMargin: boolean;
};

// ---- Palette (ARC AI orange), matching the other documents -----------------
const BRAND = "#f97316";
const BRAND_DARK = "#c2410c";
const BODY = "#374151";
const MUTED = "#6b7280";
const FAINT = "#9ca3af";
const LINE = "#e5e7eb";
const SOFT = "#fff7ed";

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 54,
    paddingHorizontal: 32,
    fontSize: 9,
    fontFamily: "Helvetica",
    color: BODY,
    lineHeight: 1.4,
  },

  header: {
    backgroundColor: BRAND,
    borderRadius: 12,
    paddingVertical: 18,
    paddingHorizontal: 22,
    marginBottom: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  wordmark: {
    fontSize: 20,
    fontFamily: "Helvetica-Bold",
    color: "#ffffff",
    lineHeight: 1.1,
  },
  headerSub: { fontSize: 9, color: "#ffedd5", marginTop: 3 },
  headerRightLabel: {
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    color: "#ffedd5",
    letterSpacing: 1,
    textAlign: "right",
  },
  headerRightValue: {
    fontSize: 10.5,
    fontFamily: "Helvetica-Bold",
    color: "#ffffff",
    textAlign: "right",
    marginTop: 2,
  },

  filters: { fontSize: 8.5, color: MUTED, marginBottom: 12 },

  // Totals strip
  totals: { flexDirection: "row", gap: 8, marginBottom: 14 },
  totalCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 8,
    backgroundColor: SOFT,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  totalLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: BRAND_DARK,
    letterSpacing: 0.6,
  },
  totalValue: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    color: "#0f172a",
    marginTop: 2,
  },

  // Table
  thead: {
    flexDirection: "row",
    borderBottomWidth: 2,
    borderBottomColor: BRAND,
    paddingBottom: 5,
    marginBottom: 2,
  },
  th: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: BRAND_DARK, letterSpacing: 0.4 },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    paddingVertical: 5,
  },
  td: { fontSize: 8.5, color: BODY },
  tdMuted: { fontSize: 7.5, color: FAINT, marginTop: 1 },
  right: { textAlign: "right" },

  empty: { fontSize: 10, color: MUTED, textAlign: "center", paddingVertical: 40 },

  footer: {
    position: "absolute",
    bottom: 22,
    left: 32,
    right: 32,
    borderTopWidth: 1,
    borderTopColor: LINE,
    paddingTop: 7,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footText: { fontSize: 7, color: FAINT },
});

/** Column widths as flex weights, so the table fits any page. */
const W = {
  project: 3.2,
  status: 1.5,
  due: 1.4,
  value: 1.5,
  received: 1.5,
  balance: 1.5,
  margin: 1,
};

function money(amount: number, currency: string): string {
  return `${currency} ${Math.round(amount).toLocaleString("en-US")}`;
}

function ProjectsDoc({
  rows,
  dateLabel,
  filterSummary,
  includeMargin,
}: ProjectsReportData) {
  // Totals are per currency: adding LKR to GBP would produce a number that
  // means nothing. In practice there is one, and this stays honest if not.
  const byCurrency = new Map<
    string,
    { value: number; received: number; balance: number }
  >();
  for (const r of rows) {
    const prev = byCurrency.get(r.currency) ?? { value: 0, received: 0, balance: 0 };
    byCurrency.set(r.currency, {
      value: prev.value + r.totalValue,
      received: prev.received + r.received,
      balance: prev.balance + r.balance,
    });
  }
  const totals = [...byCurrency.entries()];

  return (
    <Document
      title={`ARC AI — Projects report (${dateLabel})`}
      author={PROPOSAL_COMPANY.name}
    >
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.wordmark}>ARC AI</Text>
            <Text style={styles.headerSub}>Projects report</Text>
          </View>
          <View>
            <Text style={styles.headerRightLabel}>GENERATED</Text>
            <Text style={styles.headerRightValue}>{dateLabel}</Text>
          </View>
        </View>

        <Text style={styles.filters}>
          {rows.length} project{rows.length === 1 ? "" : "s"} · {filterSummary}
        </Text>

        {totals.length > 0 && (
          <View style={styles.totals}>
            {totals.map(([currency, t]) => (
              <View key={`${currency}-group`} style={{ flex: 1, flexDirection: "row", gap: 8 }}>
                <View style={styles.totalCard}>
                  <Text style={styles.totalLabel}>TOTAL VALUE</Text>
                  <Text style={styles.totalValue}>{money(t.value, currency)}</Text>
                </View>
                <View style={styles.totalCard}>
                  <Text style={styles.totalLabel}>RECEIVED</Text>
                  <Text style={styles.totalValue}>{money(t.received, currency)}</Text>
                </View>
                <View style={styles.totalCard}>
                  <Text style={styles.totalLabel}>OUTSTANDING</Text>
                  <Text style={styles.totalValue}>{money(t.balance, currency)}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {rows.length === 0 ? (
          <Text style={styles.empty}>Nothing matched the filters.</Text>
        ) : (
          <>
            <View style={styles.thead} fixed>
              <Text style={[styles.th, { flex: W.project }]}>PROJECT</Text>
              <Text style={[styles.th, { flex: W.status }]}>STATUS</Text>
              <Text style={[styles.th, { flex: W.due }]}>DUE</Text>
              <Text style={[styles.th, styles.right, { flex: W.value }]}>VALUE</Text>
              <Text style={[styles.th, styles.right, { flex: W.received }]}>RECEIVED</Text>
              <Text style={[styles.th, styles.right, { flex: W.balance }]}>BALANCE</Text>
              {includeMargin && (
                <Text style={[styles.th, styles.right, { flex: W.margin }]}>MARGIN</Text>
              )}
            </View>

            {rows.map((r, i) => (
              <View key={`${r.name}-${i}`} style={styles.tr} wrap={false}>
                <View style={{ flex: W.project, paddingRight: 6 }}>
                  <Text style={styles.td}>{r.name}</Text>
                  {(r.client || r.serviceType) && (
                    <Text style={styles.tdMuted}>
                      {[r.client, r.serviceType].filter(Boolean).join(" · ")}
                    </Text>
                  )}
                </View>
                <View style={{ flex: W.status, paddingRight: 6 }}>
                  <Text style={styles.td}>{r.status}</Text>
                  {r.stage && <Text style={styles.tdMuted}>{r.stage}</Text>}
                </View>
                <Text style={[styles.td, { flex: W.due }]}>{r.dueDate ?? "—"}</Text>
                <Text style={[styles.td, styles.right, { flex: W.value }]}>
                  {money(r.totalValue, r.currency)}
                </Text>
                <Text style={[styles.td, styles.right, { flex: W.received }]}>
                  {money(r.received, r.currency)}
                </Text>
                <Text style={[styles.td, styles.right, { flex: W.balance }]}>
                  {r.balance > 0 ? money(r.balance, r.currency) : "—"}
                </Text>
                {includeMargin && (
                  <Text style={[styles.td, styles.right, { flex: W.margin }]}>
                    {r.marginPercent === null ? "—" : `${r.marginPercent}%`}
                  </Text>
                )}
              </View>
            ))}
          </>
        )}

        <View style={styles.footer} fixed>
          <Text style={styles.footText}>
            {PROPOSAL_COMPANY.name} · {PROPOSAL_COMPANY.email} ·{" "}
            {PROPOSAL_COMPANY.website}
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

export async function renderProjectsReportPdf(
  data: ProjectsReportData,
): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(<ProjectsDoc {...data} />));
}
