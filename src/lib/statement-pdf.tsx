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

import { INVOICE_COMPANY, INVOICE_SIGNOFF, invoiceBank } from "@/lib/invoice";
import type { ClientStatement, CurrencyStatement } from "@/lib/statement";

// Wrap on whole words only — never break a word mid-way with a hyphen.
Font.registerHyphenationCallback((word) => [word]);

/**
 * The statement of account as a PDF (T4.6), on the invoice letterhead.
 *
 * Mirrors `invoice-pdf.tsx` — same company block, same rules, same bank
 * details — so a client who has both open sees one firm. The differences
 * are what a statement is: a period, per-currency running balances, and a
 * table that can run to several pages.
 *
 * Two react-pdf traps this file avoids on purpose:
 *
 *   • A `lineHeight` on the PAGE style silently deletes a `fixed` footer.
 *     The line height lives on the text styles here, never on the page.
 *   • A table row that straddles a page break is split mid-row unless it
 *     says `wrap={false}`.
 */

function money(amount: number, currency: string): string {
  const v = Number.isFinite(amount) ? amount : 0;
  const code = (currency || "LKR").toUpperCase();
  const prefix = code === "LKR" ? "Rs. " : `${code} `;
  const abs = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: v % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return v < 0 ? `(${prefix}${abs})` : `${prefix}${abs}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB");
}

const INK = "#171717";
const BODY = "#374151";
const MUTED = "#6b7280";
const LINE = "#d4d4d4";
const LINE_SOFT = "#e5e5e5";
const RED = "#dc2626";
const GREEN = "#047857";

const styles = StyleSheet.create({
  page: {
    paddingHorizontal: 30,
    paddingTop: 38,
    // Room for the fixed footer.
    paddingBottom: 60,
    fontSize: 9,
    fontFamily: "Helvetica",
    color: BODY,
  },
  text: { lineHeight: 1.5 },
  wordmark: {
    fontSize: 42,
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
  muted: { color: MUTED },
  sectionTitle: {
    fontFamily: "Helvetica-Bold",
    color: INK,
    fontSize: 11,
    marginTop: 26,
    marginBottom: 6,
  },
  summary: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 4,
    marginTop: 4,
  },
  summaryCell: { flex: 1, paddingVertical: 8, paddingHorizontal: 10 },
  summaryLabel: { fontSize: 7, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 },
  summaryValue: { fontFamily: "Helvetica-Bold", color: INK, fontSize: 11, marginTop: 2 },
  vLine: { borderLeftWidth: 1, borderLeftColor: LINE },
  vSoft: { borderLeftWidth: 1, borderLeftColor: LINE_SOFT },
  tHead: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: LINE,
    marginTop: 12,
  },
  tRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: LINE_SOFT },
  tFoot: { flexDirection: "row", borderBottomWidth: 1, borderColor: LINE, backgroundColor: "#fafafa" },
  th: { fontFamily: "Helvetica-Bold", color: INK },
  hCell: { paddingHorizontal: 6, paddingVertical: 6 },
  bCell: { paddingHorizontal: 6, paddingVertical: 7 },
  cDate: { width: "12%" },
  cRef: { width: "20%" },
  cDesc: { width: "32%" },
  cAmt: { width: "12%" },
  right: { textAlign: "right" },
  center: { textAlign: "center" },
  debit: { color: BODY },
  credit: { color: GREEN },
  negative: { color: RED },
  empty: { paddingVertical: 12, color: MUTED, textAlign: "center" },
  footerRow: { flexDirection: "row", marginTop: 18 },
  footer: {
    position: "absolute",
    left: 30,
    right: 30,
    bottom: 24,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: LINE_SOFT,
    paddingTop: 6,
    fontSize: 7,
    color: MUTED,
  },
});

function periodLabel(s: ClientStatement): string {
  return s.period.from
    ? `${fmtDate(s.period.from)} – ${fmtDate(s.period.to)}`
    : `All activity to ${fmtDate(s.period.to)}`;
}

function CurrencyBlock({ block, count }: { block: CurrencyStatement; count: number }) {
  const cur = block.currency;
  const closingStyle = block.closing > 0 ? styles.negative : block.closing < 0 ? styles.credit : undefined;
  return (
    <View>
      <Text style={styles.sectionTitle}>
        {count > 1 ? `Account in ${cur}` : "Account summary"}
      </Text>
      <View style={styles.summary}>
        <View style={styles.summaryCell}>
          <Text style={styles.summaryLabel}>Opening balance</Text>
          <Text style={styles.summaryValue}>{money(block.opening, cur)}</Text>
        </View>
        <View style={[styles.summaryCell, styles.vLine]}>
          <Text style={styles.summaryLabel}>Invoiced</Text>
          <Text style={styles.summaryValue}>{money(block.invoiced, cur)}</Text>
        </View>
        <View style={[styles.summaryCell, styles.vLine]}>
          <Text style={styles.summaryLabel}>Received</Text>
          <Text style={[styles.summaryValue, styles.credit]}>{money(block.received, cur)}</Text>
        </View>
        <View style={[styles.summaryCell, styles.vLine]}>
          <Text style={styles.summaryLabel}>{block.closing < 0 ? "Credit balance" : "Balance due"}</Text>
          <Text style={[styles.summaryValue, ...(closingStyle ? [closingStyle] : [])]}>
            {money(Math.abs(block.closing), cur)}
          </Text>
        </View>
      </View>

      {/* Lines */}
      <View style={styles.tHead} wrap={false}>
        <Text style={[styles.hCell, styles.cDate, styles.th]}>DATE</Text>
        <Text style={[styles.hCell, styles.cRef, styles.th, styles.vLine]}>REFERENCE</Text>
        <Text style={[styles.hCell, styles.cDesc, styles.th, styles.vLine]}>DETAILS</Text>
        <Text style={[styles.hCell, styles.cAmt, styles.th, styles.vLine, styles.right]}>INVOICED</Text>
        <Text style={[styles.hCell, styles.cAmt, styles.th, styles.vLine, styles.right]}>RECEIVED</Text>
        <Text style={[styles.hCell, styles.cAmt, styles.th, styles.vLine, styles.right]}>BALANCE</Text>
      </View>
      {block.opening !== 0 ? (
        <View style={styles.tRow} wrap={false}>
          <Text style={[styles.bCell, styles.cDate]}></Text>
          <Text style={[styles.bCell, styles.cRef, styles.vSoft, styles.bold]}>Balance brought forward</Text>
          <Text style={[styles.bCell, styles.cDesc, styles.vSoft]}></Text>
          <Text style={[styles.bCell, styles.cAmt, styles.vSoft]}></Text>
          <Text style={[styles.bCell, styles.cAmt, styles.vSoft]}></Text>
          <Text style={[styles.bCell, styles.cAmt, styles.vSoft, styles.right, styles.bold]}>
            {money(block.opening, cur)}
          </Text>
        </View>
      ) : null}
      {block.lines.length === 0 ? (
        <Text style={styles.empty}>No activity in this period.</Text>
      ) : (
        block.lines.map((l) => (
          <View style={styles.tRow} key={l.id} wrap={false}>
            <Text style={[styles.bCell, styles.cDate]}>{fmtDate(l.date)}</Text>
            <Text style={[styles.bCell, styles.cRef, styles.vSoft, l.kind === "invoice" ? styles.bold : {}]}>
              {l.reference}
            </Text>
            <Text style={[styles.bCell, styles.cDesc, styles.vSoft]}>{l.description}</Text>
            <Text style={[styles.bCell, styles.cAmt, styles.vSoft, styles.right, styles.debit]}>
              {l.debit ? money(l.debit, cur) : ""}
            </Text>
            <Text style={[styles.bCell, styles.cAmt, styles.vSoft, styles.right, styles.credit]}>
              {l.credit ? money(l.credit, cur) : ""}
            </Text>
            <Text style={[styles.bCell, styles.cAmt, styles.vSoft, styles.right]}>{money(l.balance, cur)}</Text>
          </View>
        ))
      )}
      <View style={styles.tFoot} wrap={false}>
        <Text style={[styles.bCell, styles.cDate]}></Text>
        <Text style={[styles.bCell, styles.cRef, styles.vSoft, styles.bold]}>Totals</Text>
        <Text style={[styles.bCell, styles.cDesc, styles.vSoft]}></Text>
        <Text style={[styles.bCell, styles.cAmt, styles.vSoft, styles.right, styles.bold]}>
          {money(block.invoiced, cur)}
        </Text>
        <Text style={[styles.bCell, styles.cAmt, styles.vSoft, styles.right, styles.bold, styles.credit]}>
          {money(block.received, cur)}
        </Text>
        <Text style={[styles.bCell, styles.cAmt, styles.vSoft, styles.right, styles.bold, ...(closingStyle ? [closingStyle] : [])]}>
          {money(block.closing, cur)}
        </Text>
      </View>

      {/* Outstanding */}
      {block.outstanding.length > 0 ? (
        <View>
          <Text style={[styles.sectionTitle, { fontSize: 10, marginTop: 18 }]}>
            Invoices still open
          </Text>
          <View style={styles.tHead} wrap={false}>
            <Text style={[styles.hCell, styles.cDate, styles.th]}>DATE</Text>
            <Text style={[styles.hCell, styles.cRef, styles.th, styles.vLine]}>INVOICE</Text>
            <Text style={[styles.hCell, styles.cDesc, styles.th, styles.vLine]}>DUE</Text>
            <Text style={[styles.hCell, styles.cAmt, styles.th, styles.vLine, styles.right]}>TOTAL</Text>
            <Text style={[styles.hCell, styles.cAmt, styles.th, styles.vLine, styles.right]}>PAID</Text>
            <Text style={[styles.hCell, styles.cAmt, styles.th, styles.vLine, styles.right]}>OPEN</Text>
          </View>
          {block.outstanding.map((i) => (
            <View style={styles.tRow} key={i.id} wrap={false}>
              <Text style={[styles.bCell, styles.cDate]}>{fmtDate(i.date)}</Text>
              <Text style={[styles.bCell, styles.cRef, styles.vSoft, styles.bold]}>{i.number}</Text>
              <Text style={[styles.bCell, styles.cDesc, styles.vSoft, ...(i.overdue ? [styles.negative] : [])]}>
                {i.dueDate ? `${fmtDate(i.dueDate)}${i.overdue ? " — overdue" : ""}` : "—"}
              </Text>
              <Text style={[styles.bCell, styles.cAmt, styles.vSoft, styles.right]}>{money(i.total, cur)}</Text>
              <Text style={[styles.bCell, styles.cAmt, styles.vSoft, styles.right, styles.credit]}>
                {i.paid ? money(i.paid, cur) : ""}
              </Text>
              <Text style={[styles.bCell, styles.cAmt, styles.vSoft, styles.right, styles.bold]}>
                {money(i.balance, cur)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function StatementPdfDoc({ statement }: { statement: ClientStatement }) {
  const bank = invoiceBank(null);
  const { client } = statement;
  const clientLines = [client.company, client.email, client.phone].filter(
    (l): l is string => Boolean(l && l.trim()),
  );
  const title = `Statement of account — ${client.name}`;

  return (
    <Document title={title} author={INVOICE_COMPANY.name}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.wordmark}>STATEMENT</Text>
        <View style={styles.rule} />

        <View style={styles.headerRow}>
          <View style={[styles.col, styles.text]}>
            <Text style={styles.bold}>{INVOICE_COMPANY.name}</Text>
            <Text>{INVOICE_COMPANY.phones}</Text>
            <Text>{INVOICE_COMPANY.email}</Text>
            <Text>{INVOICE_COMPANY.website}</Text>
            {INVOICE_COMPANY.addressLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={[styles.col, styles.text]}>
            <Text style={styles.bold}>STATEMENT FOR</Text>
            <Text>{client.name}</Text>
            {clientLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={[styles.col, styles.text]}>
            <Text style={styles.bold}>STATEMENT OF ACCOUNT</Text>
            <Text>Period: {periodLabel(statement)}</Text>
            <Text>Issued: {fmtDate(statement.generatedAt)}</Text>
          </View>
        </View>

        {statement.currencies.map((block) => (
          <CurrencyBlock key={block.currency} block={block} count={statement.currencies.length} />
        ))}

        <View style={[styles.rule, { marginTop: 22 }]} />

        <View style={styles.footerRow} wrap={false}>
          <View style={[styles.col, styles.text]}>
            <Text style={styles.bold}>CONTACT</Text>
            <Text>{INVOICE_COMPANY.phones}</Text>
            <Text>{INVOICE_COMPANY.website}</Text>
            <Text>{INVOICE_COMPANY.email}</Text>
          </View>
          <View style={[styles.col, styles.text]}>
            <Text style={styles.bold}>BANK DETAILS FOR PAYMENT</Text>
            <Text>
              <Text style={styles.bold}>Bank Name: </Text>
              {bank.bankName}
            </Text>
            <Text>
              <Text style={styles.bold}>Account Name: </Text>
              {bank.accountName}
            </Text>
            <Text>
              <Text style={styles.bold}>Account Number: </Text>
              {bank.accountNumber}
            </Text>
            <Text>
              <Text style={styles.bold}>Branch: </Text>
              {bank.branch}
            </Text>
          </View>
        </View>

        <Text style={[styles.bold, styles.text, { fontSize: 8, textTransform: "uppercase", marginTop: 14 }]}>
          {INVOICE_SIGNOFF.questionsLine}
        </Text>

        {/* Fixed footer — page numbers on every page. No lineHeight on the page. */}
        <View style={styles.footer} fixed>
          <Text>
            {INVOICE_COMPANY.name} · statement for {client.name} · issued {fmtDate(statement.generatedAt)}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** Render a client's statement to a PDF buffer, for download and attachment. */
export async function renderStatementPdf(statement: ClientStatement): Promise<Buffer> {
  return renderToBuffer(<StatementPdfDoc statement={statement} />);
}

/** A filename the browser and WhatsApp will both accept. */
export function statementFilename(statement: ClientStatement): string {
  const safe = statement.client.name.replace(/[^a-zA-Z0-9._-]/g, "") || "client";
  return `Statement-${safe}-${statement.period.to}.pdf`;
}
