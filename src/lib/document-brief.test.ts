import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assembleBrief,
  findDepositPercent,
  parseDocumentDate,
  parseInvoiceText,
  parseProposalText,
} from "./document-brief";

/**
 * Read against the REAL documents — the text unpdf extracts from the invoice
 * and proposal that were uploaded onto the aaraa-aati.com project. If the
 * template changes, these fixtures are what to regenerate.
 */
const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");

describe("parseInvoiceText", () => {
  const inv = parseInvoiceText(fixture("gem-invoice.txt"));

  it("reads the total, what is due today and the balance", () => {
    expect(inv.total).toBe(200_000);
    expect(inv.depositAmount).toBe(140_000);
    expect(inv.balanceAmount).toBe(60_000);
  });

  it("computes the deposit share from the figures, not the prose", () => {
    expect(inv.depositPercent).toBe(70);
    // The whole sentence, joined across the PDF's line wrap.
    expect(inv.termsLine).toBe(
      "Due today is the 70% deposit payable before work commences.",
    );
  });

  it("reads the number, the date (day first) and the currency", () => {
    expect(inv.invoiceNumber).toBe("#00266");
    expect(inv.invoiceDate).toBe("2026-09-03");
    expect(inv.currency).toBe("LKR");
    expect(inv.confidence).toBe("high");
  });

  it("does not mistake the QTY RATE TOTAL column header for the total", () => {
    const text = "ITEM QTY RATE TOTAL\nThing 1 Rs. 5,000 Rs. 5,000\nTOTAL: Rs. 5,000\nDUE TODAY: Rs. 2,500";
    const p = parseInvoiceText(text);
    expect(p.total).toBe(5_000);
    expect(p.depositPercent).toBe(50);
  });

  it("warns when the billed share and the wording disagree", () => {
    const text = "TOTAL: Rs. 100,000\nDUE TODAY: Rs. 50,000\nDue today is the 70% deposit.";
    const p = parseInvoiceText(text);
    expect(p.depositPercent).toBe(50);
    expect(p.confidence).toBe("low");
  });

  it("treats an invoice billed in full as a 100% deposit", () => {
    const p = parseInvoiceText("TOTAL: Rs. 40,000\nDUE TODAY: Rs. 40,000");
    expect(p.depositPercent).toBe(100);
  });
});

describe("parseProposalText", () => {
  const prop = parseProposalText(fixture("gem-proposal.txt"));

  it("reads the title across the line break", () => {
    expect(prop.title).toBe("Gem Sourcing & E-Commerce Platform");
  });

  it("reads the chosen option and its total", () => {
    expect(prop.packageLabel).toMatch(/OPTION B/i);
    expect(prop.total).toBe(200_000);
    expect(prop.depositPercent).toBe(70);
  });

  it("lifts the payment terms verbatim", () => {
    expect(prop.paymentTerms.length).toBeGreaterThanOrEqual(4);
    expect(prop.paymentTerms[0]).toMatch(/^70% deposit is payable before the project commences/);
  });

  it("takes the deliverables off the Investment table, and nothing else", () => {
    expect(prop.deliverables).toHaveLength(11);
    expect(prop.deliverables[0]).toMatch(/Custom front end/);
    expect(prop.deliverables.some((d) => /Interactive 3D sourcing map/.test(d))).toBe(true);
    // Neither the price lines nor the options table may leak into a bullet.
    for (const d of prop.deliverables) {
      expect(d).not.toMatch(/Rs\s*[\d,]/);
      expect(d).not.toMatch(/OPTION/);
      expect(d.length).toBeLessThan(120);
    }
    expect(prop.deliverables[5]).toBe("SEO foundation, analytics, responsive build and launch");
  });

  it("stops the payment terms at the terms, not at the hosting prose", () => {
    expect(prop.paymentTerms).toHaveLength(6);
    expect(prop.paymentTerms[5]).toBe("This quotation is valid for 30 days from the date of this proposal.");
  });

  it("reads the timeline steps with their weeks", () => {
    expect(prop.timeline.map((s) => s.title)).toEqual([
      "Discovery & Kickoff",
      "Design & Direction",
      "Front End & Interactive Map Build",
      "Back End, Payments & Admin",
      "QA, Content Load & Launch",
    ]);
    expect(prop.timeline[1].duration).toBe("Week 1–2");
  });

  it("keeps the assumptions as exclusions and finds an overview summary", () => {
    expect(prop.exclusions.length).toBeGreaterThanOrEqual(3);
    expect(prop.summary).toMatch(/^Sri Lanka's gem trade/);
    expect(prop.confidence).toBe("high");
  });
});

describe("assembleBrief", () => {
  it("prefers the invoice for pricing and keeps the proposal's scope", () => {
    const brief = assembleBrief({
      invoice: parseInvoiceText(fixture("gem-invoice.txt")),
      proposal: parseProposalText(fixture("gem-proposal.txt")),
      readAt: "2026-09-06T00:00:00.000Z",
    });
    expect(brief.pricing.from).toBe("invoice_pdf");
    expect(brief.pricing.total).toBe(200_000);
    expect(brief.pricing.depositPercent).toBe(70);
    expect(brief.proposal?.deliverables.length).toBeGreaterThan(0);
    expect(brief.warnings).toEqual([]);
  });

  it("says so when the invoice and the proposal disagree", () => {
    const brief = assembleBrief({
      invoice: parseInvoiceText("TOTAL: Rs. 150,000\nDUE TODAY: Rs. 75,000"),
      proposal: parseProposalText(fixture("gem-proposal.txt")),
    });
    expect(brief.pricing.total).toBe(150_000);
    expect(brief.pricing.depositPercent).toBe(50);
    expect(brief.warnings.join("\n")).toMatch(/invoice is for 150,000 but the proposal says 200,000/);
    expect(brief.warnings.join("\n")).toMatch(/50% deposit; the proposal's terms say 70%/);
  });

  it("falls back to the proposal's terms when there is no invoice", () => {
    const brief = assembleBrief({ invoice: null, proposal: parseProposalText(fixture("gem-proposal.txt")) });
    expect(brief.pricing.from).toBe("proposal_pdf");
    expect(brief.pricing.depositAmount).toBe(140_000);
  });

  it("warns instead of guessing when no deposit share is stated", () => {
    const brief = assembleBrief({ invoice: parseInvoiceText("TOTAL: Rs. 80,000"), proposal: null });
    expect(brief.pricing.depositPercent).toBeNull();
    expect(brief.warnings.join("\n")).toMatch(/standard 70\/30 split applies/);
  });
});

describe("helpers", () => {
  it("finds a deposit share however it is phrased", () => {
    expect(findDepositPercent("A 50% advance is payable")?.percent).toBe(50);
    expect(findDepositPercent("Payable on signing (60%): Rs 6,000")?.percent).toBe(60);
    expect(findDepositPercent("deposit of 40% to start")?.percent).toBe(40);
    expect(findDepositPercent("30 days validity")).toBeNull();
  });
  it("reads dates day-first, as the invoice prints them", () => {
    expect(parseDocumentDate("03/09/2026")).toBe("2026-09-03");
    expect(parseDocumentDate("03 Sept 2026")).toBe("2026-09-03");
    expect(parseDocumentDate("2026-09-03")).toBe("2026-09-03");
  });
});
