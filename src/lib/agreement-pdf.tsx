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
import type { Style } from "@react-pdf/types";

// Wrap on whole words only — never break a word mid-way with a hyphen.
Font.registerHyphenationCallback((word) => [word]);

import { AGREEMENT_COMPANY } from "@/lib/agreement-templates";
import { parseInline, parseMarkdown } from "@/lib/markdown";

/**
 * An agreement, as a PDF — the draft the editor previews, and the signed copy
 * both sides keep (0117).
 *
 * Drawn in the same design language as the proposal and the invoice: a big
 * wordmark, thin rules, a three-column header and a ruled signature block. A
 * client who has just read a proposal should recognise the contract as coming
 * from the same desk.
 *
 * When it is the signed copy it also has to carry the evidence: who typed
 * their name, the signature they drew, when, and from where. The body is the
 * Markdown the team wrote, rendered through the same parser the public page
 * uses — so the document somebody signed and the document that gets filed are
 * the same words in the same order.
 *
 * No `lineHeight` on the Page style. In @react-pdf 4.5.1 that silently drops
 * every `fixed` element, which is how the proposal PDF lost its footer.
 */

export type AgreementPdfData = {
  kind: string;
  title: string;
  bodyMd: string;
  clientName: string | null;
  /** ISO date the agreement was raised. */
  date: string;
  signedName: string | null;
  /** PNG data URL from the signature pad. */
  signatureData: string | null;
  signedAt: string | null;
  signedIp: string | null;
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
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** The word printed across the top. An NDA is not "an agreement" to a reader. */
function wordmarkFor(kind: string): string {
  switch (kind) {
    case "nda":
      return "NDA";
    case "contract":
      return "CONTRACT";
    case "sow":
      return "SCOPE";
    default:
      return "AGREEMENT";
  }
}

// ---- Palette — identical to the proposal and the invoice --------------------
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
  },

  // Header — the proposal's wordmark + rule + three columns.
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
  colLabel: {
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    color: MUTED,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 2,
  },

  // Body — the Markdown the team wrote.
  h1: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: INK,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginTop: 20,
    marginBottom: 8,
    paddingBottom: 5,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
  },
  h2: {
    fontSize: 10.5,
    fontFamily: "Helvetica-Bold",
    color: INK,
    marginTop: 13,
    marginBottom: 4,
  },
  h3: {
    fontSize: 9.5,
    fontFamily: "Helvetica-Bold",
    color: INK,
    marginTop: 10,
    marginBottom: 3,
  },
  paragraph: { marginBottom: 6 },
  listItem: { flexDirection: "row", marginBottom: 3, paddingLeft: 4 },
  bullet: { width: 14, fontFamily: "Helvetica-Bold", color: INK },
  bodyRule: { borderTopWidth: 1, borderTopColor: LINE_SOFT, marginVertical: 12 },

  // Signature block — the proposal's sign-off, doubled for two parties.
  signBlock: { marginTop: 22 },
  signRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 14 },
  signCol: { width: "46%" },
  signLabel: {
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    color: MUTED,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  /** Fixed height on BOTH sides, so the ruled lines meet across the page
   * whether or not a signature image is present. */
  signSpace: { height: 46, justifyContent: "flex-end" },
  signature: { height: 44, objectFit: "contain", objectPosition: "0% 100%" },
  signLine: { borderBottomWidth: 1, borderBottomColor: MUTED },
  signName: { fontSize: 10, fontFamily: "Helvetica-Bold", color: INK, marginTop: 5 },
  signMeta: { fontSize: 7, color: MUTED, marginTop: 2 },

  // Fixed page footer — no lineHeight on Page, or this vanishes.
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

/**
 * The four faces Helvetica ships with in react-pdf. Code borrows Courier —
 * there is no monospace Helvetica, and an inline `code` span in an agreement
 * is a field name or a value that must not be mistaken for prose.
 */
function runStyle(t: { bold: boolean; italic: boolean; code: boolean }) {
  if (t.code) return { fontFamily: "Courier" as const };
  if (t.bold && t.italic) return { fontFamily: "Helvetica-BoldOblique" as const };
  if (t.bold) return { fontFamily: "Helvetica-Bold" as const, color: INK };
  if (t.italic) return { fontFamily: "Helvetica-Oblique" as const };
  // Undefined, not {} — an unmarked run must INHERIT its parent's face, or a
  // heading's own bold would be overridden by its own children.
  return undefined;
}

/** One line of body text, with its inline marks applied. */
function Rich({
  children,
  style,
  minPresenceAhead,
}: {
  children: string;
  style?: Style;
  minPresenceAhead?: number;
}) {
  const tokens = parseInline(children);
  return (
    <Text style={style} minPresenceAhead={minPresenceAhead}>
      {tokens.map((t, i) => (
        <Text key={i} style={runStyle(t)}>
          {t.text}
        </Text>
      ))}
    </Text>
  );
}

function Body({ md }: { md: string }) {
  const blocks = parseMarkdown(md);
  return (
    <View>
      {blocks.map((block, i) => {
        if (block.kind === "rule") return <View key={i} style={styles.bodyRule} />;
        if (block.kind === "heading") {
          const style =
            block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
          // A clause heading never sits orphaned at the foot of a page.
          return (
            <Rich key={i} style={style} minPresenceAhead={54}>
              {block.text}
            </Rich>
          );
        }
        if (block.kind === "list") {
          return (
            <View key={i} style={{ marginBottom: 6 }}>
              {block.items.map((item, j) => (
                <View key={j} style={styles.listItem} wrap={false}>
                  <Text style={styles.bullet}>
                    {block.ordered ? `${j + 1}.` : "•"}
                  </Text>
                  <Rich style={{ flex: 1 }}>{item}</Rich>
                </View>
              ))}
            </View>
          );
        }
        return (
          <Rich key={i} style={styles.paragraph}>
            {block.text}
          </Rich>
        );
      })}
    </View>
  );
}

function AgreementPdfDoc({ data }: { data: AgreementPdfData }) {
  const sig = asset("signature-mark.png");
  const other = data.clientName?.trim() || "the Client";

  return (
    <Document title={data.title} author={AGREEMENT_COMPANY.name}>
      <Page size="A4" style={styles.page} wrap>
        {/* Fixed footer with page numbers */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {AGREEMENT_COMPANY.name} · {AGREEMENT_COMPANY.website} ·{" "}
            {AGREEMENT_COMPANY.email}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>

        {/* Header — proposal-style */}
        <Text style={styles.wordmark}>{wordmarkFor(data.kind)}</Text>
        <View style={{ borderTopWidth: 1, borderTopColor: LINE }} />
        <View style={styles.headerRow}>
          <View style={styles.col}>
            <Text style={styles.bold}>{AGREEMENT_COMPANY.name}</Text>
            <Text>Reg. No. {AGREEMENT_COMPANY.registrationNumber}</Text>
            <Text>{AGREEMENT_COMPANY.phones}</Text>
            <Text>{AGREEMENT_COMPANY.email}</Text>
            {AGREEMENT_COMPANY.addressLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </View>
          <View style={styles.col}>
            <Text style={styles.colLabel}>Between</Text>
            <Text>{AGREEMENT_COMPANY.name}</Text>
            <Text>and {other}</Text>
          </View>
          <View style={styles.col}>
            <Text style={styles.colLabel}>{data.kind}</Text>
            <Text>{data.title}</Text>
            <Text>Dated: {fmtDate(data.date)}</Text>
          </View>
        </View>
        <View style={styles.rule} />

        <Body md={data.bodyMd} />

        {/* Signature block — both parties, kept whole on one page */}
        <View style={styles.signBlock} wrap={false}>
          <View style={styles.rule} />
          <View style={styles.signRow}>
            <View style={styles.signCol}>
              <Text style={styles.signLabel}>For {AGREEMENT_COMPANY.name}</Text>
              <View style={styles.signSpace}>
                {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
                {sig ? <Image src={sig} style={styles.signature} /> : null}
              </View>
              <View style={styles.signLine} />
              <Text style={styles.signName}>{AGREEMENT_COMPANY.signatory}</Text>
              <Text style={styles.signMeta}>{AGREEMENT_COMPANY.email}</Text>
            </View>
            <View style={styles.signCol}>
              <Text style={styles.signLabel}>
                {data.clientName ? `For ${data.clientName}` : "For the Client"}
              </Text>
              <View style={styles.signSpace}>
                {data.signatureData ? (
                  // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt
                  <Image src={data.signatureData} style={styles.signature} />
                ) : null}
              </View>
              <View style={styles.signLine} />
              {/* A space, not a dash: an unsigned copy is meant to be signed
                  by hand, and the caption below already names the line. */}
              <Text style={styles.signName}>{data.signedName ?? " "}</Text>
              {data.signedAt ? (
                <Text style={styles.signMeta}>
                  Signed{" "}
                  {new Date(data.signedAt).toISOString().slice(0, 16).replace("T", " ")}{" "}
                  UTC
                  {data.signedIp ? ` · ${data.signedIp}` : ""}
                </Text>
              ) : (
                <Text style={styles.signMeta}>Name, and date of signature</Text>
              )}
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}

export async function renderAgreementPdf(data: AgreementPdfData): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(<AgreementPdfDoc data={data} />));
}
