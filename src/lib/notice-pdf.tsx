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
  NOTICE_COMPANY,
  NOTICE_GREETING,
  NOTICE_SIGNOFF,
  displaySubject,
  noticeParagraphs,
} from "@/lib/notice";

/**
 * Server-side PDF of a notice, built to mirror the in-app notice template
 * (the printed <NoticeDocument>): the NOTICE wordmark, the company / to /
 * notice columns, the subject + "Dear Client," + message body, the contact
 * block and the signed sign-off. Rendered with @react-pdf/renderer so it works
 * on serverless (no headless browser) and produces selectable text — the same
 * approach as invoice-pdf.tsx.
 */

export type NoticePdfData = {
  notice_number: string;
  notice_date: string; // ISO YYYY-MM-DD
  to_name: string;
  to_details: string;
  subject: string;
  body: string;
};

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB");
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

const styles = StyleSheet.create({
  page: {
    // Same tight side margins as the invoice so the two documents stack
    // identically when a client gets both.
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
    lineHeight: 1,
    marginBottom: 14,
    // Centred, unlike the invoice's left-aligned wordmark.
    textAlign: "center",
  },
  rule: { borderTopWidth: 1, borderTopColor: LINE, marginTop: 12 },
  headerRow: { flexDirection: "row", marginTop: 18 },
  col: { flex: 1, paddingRight: 14 },
  bold: { fontFamily: "Helvetica-Bold", color: INK },
  subject: {
    fontFamily: "Helvetica-Bold",
    color: INK,
    fontSize: 11,
    marginTop: 30,
  },
  greeting: { marginTop: 18, color: INK },
  para: { marginTop: 11, textAlign: "justify" },
  footerRow: { flexDirection: "row", marginTop: 18 },
  signRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: 26,
  },
  signature: { height: 58, width: 120, objectFit: "contain" },
});

function NoticePdfDoc({ notice }: { notice: NoticePdfData }) {
  const sig = getSignature();
  const toLines = (notice.to_details || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const paras = noticeParagraphs(notice.body);
  const dateStr = fmtDate(notice.notice_date);

  return (
    <Document
      title={`Notice ${notice.notice_number}`}
      author={NOTICE_COMPANY.name}
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.wordmark}>NOTICE</Text>
        <View style={styles.rule} />

        {/* From / To / Notice meta */}
        <View style={styles.headerRow}>
          <View style={styles.col}>
            <Text style={styles.bold}>{NOTICE_COMPANY.name}</Text>
            <Text>{NOTICE_COMPANY.phones}</Text>
            <Text>{NOTICE_COMPANY.email}</Text>
            <Text>{NOTICE_COMPANY.website}</Text>
            {NOTICE_COMPANY.addressLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={styles.col}>
            <Text style={styles.bold}>TO</Text>
            <Text>{notice.to_name || "—"}</Text>
            {toLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={styles.col}>
            <Text style={styles.bold}>NOTICE</Text>
            <Text>NoticeNumber:{notice.notice_number}</Text>
            <Text>Notice Date: {dateStr}</Text>
          </View>
        </View>

        {/* The message — where an invoice carries its line-item table */}
        <Text style={styles.subject}>{displaySubject(notice.subject)}</Text>
        <Text style={styles.greeting}>{NOTICE_GREETING}</Text>
        {paras.map((p, i) => (
          <Text style={styles.para} key={i}>
            {p}
          </Text>
        ))}

        <View style={styles.rule} />

        {/* Contact details */}
        <View style={styles.footerRow}>
          <View style={styles.col}>
            <Text style={styles.bold}>CONTACT</Text>
            <Text>{NOTICE_COMPANY.phones}</Text>
            <Text>{NOTICE_COMPANY.website}</Text>
            <Text>{NOTICE_COMPANY.email}</Text>
            {NOTICE_COMPANY.addressLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={styles.col} />
        </View>

        <View style={styles.rule} />

        {/* Sign-off */}
        <View style={{ marginTop: 10 }}>
          <Text
            style={[
              styles.bold,
              { fontSize: 8, textTransform: "uppercase", maxWidth: "60%" },
            ]}
          >
            {NOTICE_SIGNOFF.questionsLine}
          </Text>
          <View style={styles.signRow}>
            <Text style={[styles.bold, { fontSize: 10 }]}>
              {NOTICE_SIGNOFF.signerName}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
              <Text style={{ color: MUTED, marginRight: 18, paddingBottom: 4 }}>
                {NOTICE_SIGNOFF.signerTitle}
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

/** Render a notice to a PDF buffer for download / email attachment. */
export async function renderNoticePdf(notice: NoticePdfData): Promise<Buffer> {
  return renderToBuffer(<NoticePdfDoc notice={notice} />);
}
