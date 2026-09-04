import "server-only";

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

import { INVOICE_COMPANY } from "@/lib/invoice";
import { parseMarkdown } from "@/lib/markdown";

/**
 * The signed copy of an agreement, as a PDF (0117).
 *
 * This is the artefact both sides keep, so it has to carry the evidence: who
 * typed their name, the signature they drew, when, and from where. The body
 * is the Markdown the team wrote, rendered through the same parser the public
 * page uses — so the document somebody signed and the document that gets
 * filed are the same words in the same order.
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

const styles = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 56,
    paddingHorizontal: 46,
    fontSize: 9.5,
    color: "#0f172a",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 2,
    borderBottomColor: "#0f172a",
    paddingBottom: 10,
    marginBottom: 18,
  },
  company: { fontSize: 13, fontWeight: "bold" },
  companyLine: { fontSize: 7.5, color: "#64748b", marginTop: 2 },
  kind: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 },
  title: { fontSize: 15, fontWeight: "bold", marginTop: 2, textAlign: "right" },
  meta: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  metaLabel: { fontSize: 7.5, color: "#94a3b8", textTransform: "uppercase" },
  metaValue: { fontSize: 10, marginTop: 2 },
  h1: { fontSize: 12.5, fontWeight: "bold", marginTop: 14, marginBottom: 5 },
  h2: { fontSize: 11, fontWeight: "bold", marginTop: 12, marginBottom: 4 },
  h3: { fontSize: 10, fontWeight: "bold", marginTop: 10, marginBottom: 3 },
  paragraph: { marginBottom: 7 },
  listItem: { flexDirection: "row", marginBottom: 3, paddingLeft: 6 },
  bullet: { width: 12 },
  rule: {
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    marginVertical: 10,
  },
  signBlock: {
    marginTop: 26,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 14,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  signCol: { width: "47%" },
  signLabel: { fontSize: 7.5, color: "#94a3b8", textTransform: "uppercase" },
  signature: { height: 46, marginTop: 4, objectFit: "contain" },
  signLine: {
    borderBottomWidth: 1,
    borderBottomColor: "#94a3b8",
    marginTop: 44,
  },
  signName: { fontSize: 10, fontWeight: "bold", marginTop: 4 },
  signMeta: { fontSize: 7, color: "#94a3b8", marginTop: 2 },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 46,
    right: 46,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: "#94a3b8",
  },
});

function Body({ md }: { md: string }) {
  const blocks = parseMarkdown(md);
  return (
    <View>
      {blocks.map((block, i) => {
        if (block.kind === "rule") return <View key={i} style={styles.rule} />;
        if (block.kind === "heading") {
          const style =
            block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
          return (
            <Text key={i} style={style}>
              {block.text}
            </Text>
          );
        }
        if (block.kind === "list") {
          return (
            <View key={i} style={{ marginBottom: 7 }}>
              {block.items.map((item, j) => (
                <View key={j} style={styles.listItem}>
                  <Text style={styles.bullet}>
                    {block.ordered ? `${j + 1}.` : "•"}
                  </Text>
                  <Text style={{ flex: 1 }}>{item}</Text>
                </View>
              ))}
            </View>
          );
        }
        return (
          <Text key={i} style={styles.paragraph}>
            {block.text}
          </Text>
        );
      })}
    </View>
  );
}

export async function renderAgreementPdf(data: AgreementPdfData): Promise<Buffer> {
  const doc = (
    <Document title={data.title}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View>
            <Text style={styles.company}>{INVOICE_COMPANY.name}</Text>
            <Text style={styles.companyLine}>
              {INVOICE_COMPANY.addressLines.join(" · ")}
            </Text>
            <Text style={styles.companyLine}>
              {INVOICE_COMPANY.email} · {INVOICE_COMPANY.phones}
            </Text>
          </View>
          <View>
            <Text style={styles.kind}>{data.kind}</Text>
            <Text style={styles.title}>{data.title}</Text>
          </View>
        </View>

        <View style={styles.meta}>
          <View>
            <Text style={styles.metaLabel}>Between</Text>
            <Text style={styles.metaValue}>{INVOICE_COMPANY.name}</Text>
            <Text style={styles.metaValue}>and {data.clientName ?? "the Client"}</Text>
          </View>
          <View>
            <Text style={styles.metaLabel}>Dated</Text>
            <Text style={styles.metaValue}>{data.date}</Text>
          </View>
        </View>

        <Body md={data.bodyMd} />

        <View style={styles.signBlock} wrap={false}>
          <View style={styles.signCol}>
            <Text style={styles.signLabel}>For {INVOICE_COMPANY.name}</Text>
            <View style={styles.signLine} />
            <Text style={styles.signName}>{INVOICE_COMPANY.name}</Text>
          </View>
          <View style={styles.signCol}>
            <Text style={styles.signLabel}>
              {data.clientName ? `For ${data.clientName}` : "Client"}
            </Text>
            {data.signatureData ? (
              <Image style={styles.signature} src={data.signatureData} />
            ) : (
              <View style={styles.signLine} />
            )}
            <Text style={styles.signName}>{data.signedName ?? "—"}</Text>
            {data.signedAt && (
              <Text style={styles.signMeta}>
                Signed {new Date(data.signedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
                {data.signedIp ? ` · ${data.signedIp}` : ""}
              </Text>
            )}
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text>
            {INVOICE_COMPANY.name} · {INVOICE_COMPANY.website}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );

  return renderToBuffer(doc);
}
