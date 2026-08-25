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
  recurrenceSuffix,
  type ProposalBody,
  type ProposalContent,
  type ProposalSection,
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

  // What a line item includes, printed inside the DESCRIPTION cell. The note
  // treatment (7.5 / muted) so the features read as detail under the thing
  // being bought, not as a second column of their own.
  itemFeatRow: { flexDirection: "row", marginTop: 2 },
  itemFeatDot: { width: 8, fontSize: 7.5, color: MUTED },
  itemFeatText: { flex: 1, fontSize: 7.5, color: MUTED },

  // Two-column grid for a free-form "features" body. Cells are laid out two at
  // a time rather than by flexWrap alone, so a grid that crosses a page break
  // paginates as whole rows.
  gridRow: { flexDirection: "row", flexWrap: "wrap" },
  gridCell: { width: "50%", paddingRight: 10, marginBottom: 6 },
});

/**
 * How many feature bullets a single Investment line may print. Capped because
 * the row is atomic: a line carrying a dozen bullets would grow taller than the
 * printable area, and react-pdf answers that with blank pages.
 */
const ITEM_FEATURE_CAP = 8;

/**
 * Whether a row is short enough to stay on one page. The fixed sections can
 * assume tight strings; a free-form section is model-written and unbounded, so
 * anything long is allowed to split rather than risk an unsplittable block.
 */
function atomic(...parts: (string | undefined)[]): boolean {
  return parts.reduce((n, part) => n + (part ? part.length : 0), 0) <= 320;
}

/** Trimmed, non-empty strings out of a value that arrived as stored JSON. */
function textList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((x) => x.trim());
}

/** A trimmed string, or "" for anything that is not one. */
function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

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

/** Feature bullets under a line item's label, in the muted note treatment. */
function ItemFeatures({ items }: { items: string[] }) {
  const shown = items.slice(0, ITEM_FEATURE_CAP);
  if (!shown.length) return null;
  return (
    <View style={{ marginTop: 3 }}>
      {shown.map((f, i) => (
        <View style={styles.itemFeatRow} key={i}>
          <Text style={styles.itemFeatDot}>•</Text>
          <Text style={styles.itemFeatText}>{f}</Text>
        </View>
      ))}
    </View>
  );
}

/** Entries of an array-ish value that are objects carrying a non-empty `field`. */
function named(v: unknown, field: "heading" | "title"): boolean {
  return (
    Array.isArray(v) &&
    v.some((x) => !!x && typeof x === "object" && text((x as Record<string, unknown>)[field]) !== "")
  );
}

/**
 * Whether a body will actually PUT INK ON THE PAGE.
 *
 * Recognising the eight `kind` names is not enough. `SectionBody` returns null
 * for a known shape whose payload is empty — `{ kind: "bullets", items: [] }`
 * draws nothing — and a section built only from those used to survive
 * `freeSections()` anyway. That cost the document twice: it printed a numbered
 * heading with a blank underneath it, and because ANY surviving free section
 * suppresses the fixed narrative, Overview, Objectives, Key Features,
 * Educational Strategy, SEO and Timeline all silently vanished with it. So the
 * emptiness test lives here, mirroring exactly what `SectionBody` draws.
 */
function drawsSomething(b: { kind?: unknown } & Record<string, unknown>): boolean {
  switch (b.kind) {
    case "prose":
      return textList(b.paragraphs).length > 0;
    case "bullets":
      return textList(b.items).length > 0;
    case "groups":
      return named(b.groups, "heading");
    case "steps":
    case "timeline":
      return named(b.steps, "title");
    case "features":
      return named(b.items, "title");
    // A table draws a row for every entry that is an array, which is the same
    // test `SectionBody` applies before it decides it has a table at all.
    case "table":
      return Array.isArray(b.rows) && b.rows.some((r) => Array.isArray(r));
    case "note":
      return text(b.text) !== "";
    default:
      return false;
  }
}

/**
 * The bodies of a section that this renderer can actually draw. Sections are
 * written by the agent and stored as raw JSON, so anything malformed is dropped
 * HERE — one bad body must never throw inside renderToBuffer, which is the
 * download, the emailed file and the preview all at once.
 */
function renderableBodies(v: unknown): ProposalBody[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (b): b is ProposalBody =>
      !!b && typeof b === "object" && drawsSomething(b as Record<string, unknown>),
  );
}

/**
 * The free-form sections worth printing: a real heading and at least one body
 * this renderer understands. A section that survives this filter is guaranteed
 * to draw something, so it can safely consume a section number.
 */
function freeSections(c: ProposalContent): ProposalSection[] {
  if (!Array.isArray(c.sections)) return [];
  return c.sections.filter(
    (s): s is ProposalSection =>
      !!s && typeof s === "object" && text(s.heading) !== "" && renderableBodies(s.body).length > 0,
  );
}

/**
 * One body of a free-form section, drawn with the styles the fixed sections
 * already use. The agent chooses the CONTENT and the ORDER; it never chooses
 * the layout, which is what keeps a bespoke proposal looking like an ARC AI
 * proposal. An unknown shape renders nothing rather than throwing.
 */
function SectionBody({ body }: { body: ProposalBody }): React.ReactElement | null {
  switch (body.kind) {
    case "prose": {
      const paras = textList(body.paragraphs);
      if (!paras.length) return null;
      return (
        <>
          {paras.map((para, i) => (
            <Text style={styles.para} key={i}>
              {para}
            </Text>
          ))}
        </>
      );
    }

    case "bullets":
      return <Bullets items={textList(body.items)} />;

    case "groups": {
      const groups = (Array.isArray(body.groups) ? body.groups : []).filter(
        (g) => g && text(g.heading) !== "",
      );
      if (!groups.length) return null;
      return (
        <>
          {groups.map((g, i) => (
            <View key={i} style={{ marginBottom: 6 }}>
              <Text style={styles.subHead}>{text(g.heading)}</Text>
              {text(g.intro) ? <Text style={styles.para}>{text(g.intro)}</Text> : null}
              <Bullets items={textList(g.items)} />
            </View>
          ))}
        </>
      );
    }

    case "steps": {
      const steps = (Array.isArray(body.steps) ? body.steps : []).filter(
        (st) => st && text(st.title) !== "",
      );
      if (!steps.length) return null;
      return (
        <>
          {steps.map((st, i) => {
            const description = text(st.description);
            return (
              <View
                style={styles.tlRow}
                key={i}
                wrap={!atomic(text(st.title), description)}
              >
                <View style={styles.tlChip}>
                  <Text style={styles.tlChipText}>{String(i + 1).padStart(2, "0")}</Text>
                </View>
                <View style={styles.tlBody}>
                  <Text style={styles.tlTitle}>{text(st.title)}</Text>
                  {description ? <Text>{description}</Text> : null}
                </View>
              </View>
            );
          })}
        </>
      );
    }

    case "timeline": {
      const steps = (Array.isArray(body.steps) ? body.steps : []).filter(
        (st) => st && text(st.title) !== "",
      );
      if (!steps.length) return null;
      return (
        <>
          {steps.map((st, i) => {
            const description = text(st.description);
            const duration = text(st.duration);
            return (
              <View
                style={styles.tlRow}
                key={i}
                wrap={!atomic(text(st.title), description, duration)}
              >
                <View style={styles.tlChip}>
                  <Text style={styles.tlChipText}>{String(i + 1).padStart(2, "0")}</Text>
                </View>
                <View style={styles.tlBody}>
                  <Text style={styles.tlTitle}>{text(st.title)}</Text>
                  {description ? <Text>{description}</Text> : null}
                  {duration ? <Text style={styles.tlDuration}>{duration}</Text> : null}
                </View>
              </View>
            );
          })}
        </>
      );
    }

    case "features": {
      const items = (Array.isArray(body.items) ? body.items : []).filter(
        (it) => it && text(it.title) !== "",
      );
      if (!items.length) return null;
      // Paired into rows of two so the grid breaks between rows, never inside
      // one: a flexWrap container split across a page is where react-pdf
      // duplicates cells.
      const rows: (typeof items)[] = [];
      for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
      return (
        <View>
          {rows.map((pair, i) => (
            <View
              style={styles.gridRow}
              key={i}
              wrap={!pair.every((it) => atomic(text(it.title), text(it.description)))}
            >
              {pair.map((it, j) => (
                <View style={styles.gridCell} key={j}>
                  <Text style={styles.bold}>{text(it.title)}</Text>
                  {text(it.description) ? (
                    <Text style={{ color: MUTED }}>{text(it.description)}</Text>
                  ) : null}
                </View>
              ))}
              {/* Keeps a lone last cell at half width instead of stretching. */}
              {pair.length === 1 ? <View style={styles.gridCell} /> : null}
            </View>
          ))}
        </View>
      );
    }

    case "table": {
      const rows = (Array.isArray(body.rows) ? body.rows : []).filter((r) => Array.isArray(r));
      if (!rows.length) return null;
      const columns = Array.isArray(body.columns) ? body.columns : [];
      const head = [text(columns[0]), text(columns[1])];
      // Percentages only — the Investment grid is built the same way, and a
      // stray unit here would collapse the whole row.
      const labelWidth = /^\d{1,2}(\.\d+)?%$/.test(text(body.labelWidth))
        ? text(body.labelWidth)
        : "32%";
      const valueWidth = `${100 - Number.parseFloat(labelWidth)}%`;
      return (
        <View>
          {head[0] || head[1] ? (
            <View style={styles.tHead} minPresenceAhead={40}>
              <Text style={[styles.hCell, styles.th, { width: labelWidth }]}>
                {head[0].toUpperCase()}
              </Text>
              <Text style={[styles.hCell, styles.th, styles.vLine, { width: valueWidth }]}>
                {head[1].toUpperCase()}
              </Text>
            </View>
          ) : null}
          {rows.map((r, i) => {
            const label = text(r[0]);
            const value = text(r[1]);
            return (
              <View style={styles.tRow} key={i} wrap={!atomic(label, value)}>
                <Text style={[styles.bCell, { width: labelWidth }]}>{label}</Text>
                <Text style={[styles.bCell, styles.vSoft, { width: valueWidth }]}>{value}</Text>
              </View>
            );
          })}
        </View>
      );
    }

    case "note":
      return text(body.text) ? <Text style={styles.note}>{text(body.text)}</Text> : null;

    default:
      // Unknown shape, from a newer writer or a hand-edited row: print nothing.
      return null;
  }
}

/** A numbered section the agent wrote itself, in the fixed sections' clothes. */
function FreeSection({ no, section }: { no: number; section: ProposalSection }) {
  return (
    <Section no={no} title={text(section.heading)}>
      {renderableBodies(section.body).map((body, i) => (
        <SectionBody body={body} key={i} />
      ))}
    </Section>
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

  // The agent's own sections. ABSENT — which is every proposal saved before
  // they existed — leaves `free` empty, every flag below true and both lists
  // empty, so the fixed skeleton renders through exactly the code path it
  // always has. Presence is the only discriminator; nothing is backfilled.
  const free = freeSections(c);
  const mode = c.sectionsMode ?? "replace_narrative";
  // "replace_narrative" (the default) drops the six narrative sections rather
  // than printing, say, an SEO heading on a proposal with no SEO in it.
  const showNarrative = !free.length || mode === "append";
  // "replace_all" also drops the closing terms — the agent has written its own.
  const showFixedTail = !free.length || mode !== "replace_all";
  const sectionsBefore = free.filter((sec) => sec.placement !== "after");
  const sectionsAfter = free.filter((sec) => sec.placement === "after");

  // Ongoing money, printed BELOW the one-time total and under a rule, so a
  // retainer can never be read as part of the figure due on signature.
  const monthlyTotal = pricing.monthlyTotal ?? 0;
  const yearlyTotal = pricing.yearlyTotal ?? 0;
  const hasOngoing =
    monthlyTotal > 0 || yearlyTotal > 0 || pricing.recurringNotes.length > 0;

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
        {showNarrative && c.overview ? (
          <Section no={n()} title="Overview">
            {c.overview.split("\n\n").map((p, i) => (
              <Text style={styles.para} key={i}>
                {p}
              </Text>
            ))}
          </Section>
        ) : null}

        {showNarrative && c.objectives.length ? (
          <Section no={n()} title="Objectives">
            {c.objectives.map((g, i) => (
              <View key={i} style={{ marginBottom: 6 }}>
                <Text style={styles.subHead}>{g.group}</Text>
                <Bullets items={g.items} />
              </View>
            ))}
          </Section>
        ) : null}

        {showNarrative && c.keyFeatures.length ? (
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

        {showNarrative &&
        (c.educational.intro || c.educational.bullets.length || c.educational.aiAgent) ? (
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

        {showNarrative && (c.seo.bullets.length || c.seo.whyDedicated) ? (
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

        {showNarrative && c.timeline.length ? (
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

        {/* The agent's sections, in its order. n() is called here, in reading
            order, so free-form and fixed sections share one numbering run. */}
        {sectionsBefore.map((sec, i) => (
          <FreeSection no={n()} section={sec} key={`${sec.id}-${i}`} />
        ))}

        <Section no={n()} title="Investment">
          <View style={styles.tHead} minPresenceAhead={40}>
            <Text style={[styles.hCell, styles.cDesc, styles.th]}>DESCRIPTION</Text>
            <Text style={[styles.hCell, styles.cAmount, styles.th, styles.vLine, styles.right]}>
              AMOUNT
            </Text>
          </View>
          {pricing.lineItems.map((l, i) => {
            // What the client is actually buying, printed under the thing they
            // are buying it as. A legacy line carries none of these and takes
            // the plain single-Text cell below, unchanged.
            const feats = textList(l.features);
            // Work charged through at cost carries no figure at all; everything
            // else states how often it is charged, straight off the line's
            // recurrence rather than out of any stored text.
            const amountText =
              l.recurrence === "at_cost"
                ? "At cost"
                : `${money(l.amount)}${recurrenceSuffix(l.recurrence) ?? ""}`;
            return (
              <View
                style={styles.tRow}
                key={i}
                // Rows stay atomic exactly as they always have; only a features
                // list long enough to outgrow a page is allowed to split.
                wrap={feats.length > 0 && !atomic(l.label, ...feats)}
              >
                {feats.length ? (
                  <View style={[styles.bCell, styles.cDesc]}>
                    <Text>{l.label}</Text>
                    <ItemFeatures items={feats} />
                  </View>
                ) : (
                  <Text style={[styles.bCell, styles.cDesc]}>{l.label}</Text>
                )}
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
                  {amountText}
                </Text>
              </View>
            );
          })}
          <View
            style={styles.totals}
            // Atomic, as it always has been. Only an unusually long list of
            // recurring notes — which no legacy proposal can produce — is let
            // through to split rather than risk an unbreakable block.
            wrap={pricing.recurringNotes.length > 8}
          >
            <View style={styles.totalLine}>
              <Text style={styles.bold}>ONE-TIME TOTAL:</Text>
              <Text style={styles.bold}>{money(pricing.oneTimeTotal)}</Text>
            </View>
            {hasOngoing ? (
              <>
                <View style={styles.totalRule} />
                {monthlyTotal > 0 ? (
                  <View style={styles.totalLine}>
                    <Text style={styles.bold}>MONTHLY TOTAL:</Text>
                    <Text style={styles.bold}>{money(monthlyTotal)}/month</Text>
                  </View>
                ) : null}
                {yearlyTotal > 0 ? (
                  <View style={styles.totalLine}>
                    <Text style={styles.bold}>YEARLY TOTAL:</Text>
                    <Text style={styles.bold}>{money(yearlyTotal)}/year</Text>
                  </View>
                ) : null}
                {pricing.recurringNotes.length ? (
                  <View style={{ width: 230, paddingTop: 4 }}>
                    {pricing.recurringNotes.map((r, i) => (
                      <Text style={styles.note} key={i}>
                        {r}
                      </Text>
                    ))}
                  </View>
                ) : null}
              </>
            ) : null}
          </View>
        </Section>

        {sectionsAfter.map((sec, i) => (
          <FreeSection no={n()} section={sec} key={`${sec.id}-${i}`} />
        ))}

        {showFixedTail && (c.paymentTerms.length || c.hosting.hosting) ? (
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

        {showFixedTail && c.maintenance.length ? (
          <Section no={n()} title="Maintenance & Support">
            <Bullets items={c.maintenance} />
          </Section>
        ) : null}

        {showFixedTail &&
        (c.quality.bullets.length ||
          c.quality.assumptions.length ||
          c.quality.nextSteps.length) ? (
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
