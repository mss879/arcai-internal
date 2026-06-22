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

// Wrap on whole words only — never break a word mid-way with a hyphen.
Font.registerHyphenationCallback((word) => [word]);

import {
  INVOICE_BANK,
  INVOICE_COMPANY,
  INVOICE_SIGNOFF,
} from "@/lib/invoice";

/**
 * Server-side PDF of an invoice, built to mirror the in-app invoice template
 * (the printed <InvoiceDocument>): the INVOICE wordmark, the company / bill-to
 * / invoice columns, the line-item table, totals, contact + bank details and
 * the signed sign-off. Rendered with @react-pdf/renderer so it works on
 * serverless (no headless browser) and produces a real, selectable-text PDF.
 */

export type InvoiceEmailData = {
  invoice_number: string;
  invoice_date: string; // ISO YYYY-MM-DD
  bill_to_name: string;
  bill_to_details: string;
  items: {
    item: string;
    description: string;
    qty: string;
    rate: string;
    total: number;
  }[];
  grand_total: number;
  due_today: number;
};

function money(amount: number): string {
  const v = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  return (
    "Rs. " +
    v.toLocaleString("en-US", {
      minimumFractionDigits: v % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    })
  );
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB");
}

function parseAmount(input: string): number {
  const n = Number(String(input).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Read the director's signature once and inline it as a data URI.
let signatureUri: string | null | undefined;
function getSignature(): string | null {
  if (signatureUri !== undefined) return signatureUri;
  try {
    const p = path.join(process.cwd(), "public", "signature-mark.png");
    signatureUri = `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
  } catch {
    signatureUri = null;
  }
  return signatureUri;
}

const INK = "#171717";
const BODY = "#374151";
const MUTED = "#6b7280";
const LINE = "#d4d4d4";
const LINE_SOFT = "#e5e5e5";

const styles = StyleSheet.create({
  page: {
    // Tight side margins so the invoice fills the A4 width — just a small gap
    // from the edge rather than the wide borders the old print output had.
    paddingHorizontal: 30,
    paddingVertical: 38,
    fontSize: 9,
    fontFamily: "Helvetica",
    color: BODY,
    lineHeight: 1.5,
  },
  wordmark: {
    fontSize: 50,
    fontFamily: "Helvetica-Bold",
    color: INK,
    letterSpacing: -1.5,
    // Tight line box + explicit gap so the big glyphs never overlap the header.
    lineHeight: 1,
    marginBottom: 14,
  },
  rule: { borderTopWidth: 1, borderTopColor: LINE, marginTop: 12 },
  headerRow: { flexDirection: "row", marginTop: 18 },
  col: { flex: 1, paddingRight: 14 },
  bold: { fontFamily: "Helvetica-Bold", color: INK },
  // Bordered grid, mirroring the in-app template: header top+bottom rules and
  // vertical dividers between every column.
  tHead: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: LINE,
    marginTop: 28,
  },
  tRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderColor: LINE_SOFT,
  },
  th: { fontFamily: "Helvetica-Bold", color: INK },
  hCell: { paddingHorizontal: 8, paddingVertical: 7 },
  bCell: { paddingHorizontal: 8, paddingVertical: 11 },
  vLine: { borderLeftWidth: 1, borderLeftColor: LINE },
  vSoft: { borderLeftWidth: 1, borderLeftColor: LINE_SOFT },
  // Give RATE and TOTAL enough room that "Rs. 72,000" stays on one line.
  cItem: { width: "16%" },
  cDesc: { width: "41%" },
  cQty: { width: "10%" },
  cRate: { width: "16%" },
  cTotal: { width: "17%" },
  center: { textAlign: "center" },
  right: { textAlign: "right" },
  totals: { marginTop: 20, alignItems: "flex-end" },
  totalLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: 220,
    paddingVertical: 4,
  },
  totalRule: { borderTopWidth: 1, borderTopColor: LINE, width: 220 },
  footerRow: { flexDirection: "row", marginTop: 18 },
  signRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: 26,
  },
  signature: { height: 58, width: 120, objectFit: "contain" },
});

function InvoicePdfDoc({ invoice }: { invoice: InvoiceEmailData }) {
  const sig = getSignature();
  const billLines = (invoice.bill_to_details || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const dateStr = fmtDate(invoice.invoice_date);

  return (
    <Document
      title={`Invoice ${invoice.invoice_number}`}
      author={INVOICE_COMPANY.name}
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.wordmark}>INVOICE</Text>
        <View style={styles.rule} />

        {/* From / Bill to / Invoice meta */}
        <View style={styles.headerRow}>
          <View style={styles.col}>
            <Text style={styles.bold}>{INVOICE_COMPANY.name}</Text>
            <Text>{INVOICE_COMPANY.phones}</Text>
            <Text>{INVOICE_COMPANY.email}</Text>
            <Text>{INVOICE_COMPANY.website}</Text>
            {INVOICE_COMPANY.addressLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={styles.col}>
            <Text style={styles.bold}>BILL TO</Text>
            <Text>{invoice.bill_to_name || "—"}</Text>
            {billLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={styles.col}>
            <Text style={styles.bold}>INVOICE</Text>
            <Text>InvoiceNumber:{invoice.invoice_number}</Text>
            <Text>Invoice Date: {dateStr}</Text>
          </View>
        </View>

        {/* Line items */}
        <View style={styles.tHead}>
          <Text style={[styles.hCell, styles.cItem, styles.th]}>
            ITEM / SERVICE
          </Text>
          <Text style={[styles.hCell, styles.cDesc, styles.th, styles.vLine, styles.center]}>
            DESCRIPTION
          </Text>
          <Text style={[styles.hCell, styles.cQty, styles.th, styles.vLine, styles.center]}>
            QTY
          </Text>
          <Text style={[styles.hCell, styles.cRate, styles.th, styles.vLine, styles.center]}>
            RATE
          </Text>
          <Text style={[styles.hCell, styles.cTotal, styles.th, styles.vLine, styles.center]}>
            TOTAL
          </Text>
        </View>
        {invoice.items.map((it, i) => (
          <View style={styles.tRow} key={i} wrap={false}>
            <Text style={[styles.bCell, styles.cItem]}>{it.item}</Text>
            <Text style={[styles.bCell, styles.cDesc, styles.vSoft]}>
              {it.description}
            </Text>
            <Text style={[styles.bCell, styles.cQty, styles.vSoft, styles.center]}>
              {it.qty}
            </Text>
            <Text style={[styles.bCell, styles.cRate, styles.vSoft, styles.right]}>
              {it.rate ? money(parseAmount(it.rate)) : ""}
            </Text>
            <Text style={[styles.bCell, styles.cTotal, styles.vSoft, styles.right]}>
              {it.total ? money(it.total) : ""}
            </Text>
          </View>
        ))}

        {/* Totals */}
        <View style={styles.totals}>
          <View style={styles.totalLine}>
            <Text style={styles.bold}>TOTAL:</Text>
            <Text>{money(invoice.grand_total)}</Text>
          </View>
          <View style={styles.totalRule} />
          <View style={styles.totalLine}>
            <Text style={styles.bold}>DUE TODAY:</Text>
            <Text>{money(invoice.due_today)}</Text>
          </View>
        </View>

        <View style={styles.rule} />

        {/* Contact / bank details */}
        <View style={styles.footerRow}>
          <View style={styles.col}>
            <Text style={styles.bold}>CONTACT</Text>
            <Text>{INVOICE_COMPANY.phones}</Text>
            <Text>{INVOICE_COMPANY.website}</Text>
            <Text>{INVOICE_COMPANY.email}</Text>
            {INVOICE_COMPANY.addressLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={styles.col}>
            <Text style={styles.bold}>BANK DETAILS FOR PAYMENT</Text>
            <Text>
              <Text style={styles.bold}>Bank Name: </Text>
              {INVOICE_BANK.bankName}
            </Text>
            <Text>
              <Text style={styles.bold}>Account Name: </Text>
              {INVOICE_BANK.accountName}
            </Text>
            <Text>
              <Text style={styles.bold}>Account Number: </Text>
              {INVOICE_BANK.accountNumber}
            </Text>
            <Text>
              <Text style={styles.bold}>Branch: </Text>
              {INVOICE_BANK.branch}
            </Text>
          </View>
        </View>

        <View style={styles.rule} />

        {/* Sign-off */}
        <View style={{ marginTop: 10 }}>
          <Text
            style={[styles.bold, { fontSize: 8, textTransform: "uppercase", maxWidth: "60%" }]}
          >
            {INVOICE_SIGNOFF.questionsLine}
          </Text>
          <View style={styles.signRow}>
            <Text style={[styles.bold, { fontSize: 10 }]}>
              {INVOICE_SIGNOFF.signerName}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
              <Text style={{ color: MUTED, marginRight: 18, paddingBottom: 4 }}>
                {INVOICE_SIGNOFF.signerTitle}
              </Text>
              {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
              {sig ? <Image src={sig} style={styles.signature} /> : null}
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}

/** Render an invoice to a PDF buffer for email attachment. */
export async function renderInvoicePdf(
  invoice: InvoiceEmailData,
): Promise<Buffer> {
  return renderToBuffer(<InvoicePdfDoc invoice={invoice} />);
}
