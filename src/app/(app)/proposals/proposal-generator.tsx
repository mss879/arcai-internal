"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Download,
  FilePlus2,
  Loader2,
  Mic,
  Plus,
  Receipt,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { useDictation } from "@/hooks/use-dictation";
import { cn } from "@/lib/utils";
import { applyOverrides, type PricingGroup } from "@/lib/pricing-catalog";
import { selectionPrices } from "@/lib/proposal-pricing";
import {
  AGENT_PLANS,
  AGENT_TIMELINE,
  BUSINESS_TIERS,
  ECOMMERCE,
  MAINTENANCE,
  buildPricing,
  defaultContent,
  defaultSelection,
  hasItems,
  includedFeatures,
  lineItemFromCatalog,
  money,
  selectionSummary,
  suggestedProjectName,
  type AgentPlatform,
  type BusinessTierKey,
  type MaintenanceKey,
  type ProposalContent,
  type ProposalLineItem,
  type ProposalSection,
  type ProposalSectionsMode,
  type ProposalSelection,
} from "@/lib/proposal";
import type { Client, Proposal } from "@/lib/types";

import {
  INVOICE_HANDOFF_PARAM,
  INVOICE_HANDOFF_SOURCE,
  stashInvoiceDraft,
} from "@/lib/invoice-handoff";

import { generateProposal, saveProposal, updateProposal } from "./actions";
import { downloadProposalPdf } from "./download-pdf";
import { ProposalPdfFrame } from "./proposal-pdf-frame";
import { ItemBuilder, bespokeLine } from "./item-builder";
import { SectionsEditor, cleanSections } from "./section-editor";

type ClientLite = Pick<Client, "id" | "name" | "company">;

/**
 * Which shape this proposal is being written in.
 *
 *   "package" — the original single-package selection. A proposal saved this
 *     way carries no `items` key at all, and every reader treats it exactly as
 *     it always has.
 *   "items"   — the multi-item builder: any number of priced lines off the
 *     live price list, mixed one-time and recurring, which is the only way to
 *     quote a website AND a monthly social retainer on one document.
 *
 * Moving from "package" to "items" is a real change of shape, so it is never
 * done silently — see the conversion notice below.
 */
type Shape = "package" | "items";

/** How much freedom the writer gets over the document's structure. */
type Structure = "auto" | "free" | "fixed";

/** The current lineup — legacy tiers (starter–scale) live only inside old
 * stored proposals and are never offered here. */
const BUSINESS_TIER_OPTIONS: BusinessTierKey[] = [
  "smart_site",
  "smart_business",
  "smart_system",
];

const trimArr = (a: string[]) => a.map((s) => s.trim()).filter(Boolean);

/**
 * The /pricing key of the package the single-package picker is on.
 *
 * This mirrors the private `baseKey()` in proposal-pricing.ts, which resolves a
 * selection to an AMOUNT. Converting to the item builder needs the KEY instead:
 * that is what carries the package's real features across with it. Legacy tiers
 * map to null — they exist only inside old stored proposals and have no entry
 * on the current price list.
 */
function legacyCatalogKey(sel: ProposalSelection): string | null {
  if (sel.type === "business") {
    switch (sel.tier) {
      case "smart_site":
        return "web.smart_site.onetime";
      case "smart_business":
        return "web.smart_business.onetime";
      case "smart_system":
        return "web.smart_system.onetime";
      default:
        return null;
    }
  }
  if (sel.type === "agent") {
    switch (sel.agentPlatform ?? "whatsapp") {
      case "instagram":
        return "ai.instagram_crm.setup";
      case "smart_system_budget":
        return "system.budget.onetime";
      default:
        return "ai.whatsapp_crm.setup";
    }
  }
  switch (sel.platform) {
    case "store":
      return "ecom.store.setup";
    case "smart":
      return "ecom.smart.total";
    default:
      return null;
  }
}

/**
 * Strip empty/whitespace entries so the preview + PDF never show blank rows.
 *
 * SPREADS FIRST, deliberately. This used to rebuild the content object key by
 * key, which silently dropped every key it didn't name — so anything the
 * writer added beyond the fixed skeleton died the moment a proposal passed
 * through this form. Nothing may be lost on a round-trip here.
 */
function clean(c: ProposalContent): ProposalContent {
  const sections = cleanSections(c.sections);
  const out: ProposalContent = {
    ...c,
    overview: c.overview.trim(),
    objectives: c.objectives
      .map((g) => ({ group: g.group.trim(), items: trimArr(g.items) }))
      .filter((g) => g.group && g.items.length),
    keyFeatures: c.keyFeatures
      .map((f) => ({
        heading: f.heading.trim(),
        intro: f.intro.trim(),
        bullets: trimArr(f.bullets),
      }))
      .filter((f) => f.heading),
    educational: {
      intro: c.educational.intro.trim(),
      bullets: trimArr(c.educational.bullets),
      aiAgent: c.educational.aiAgent
        ? {
            intro: c.educational.aiAgent.intro.trim(),
            capabilities: trimArr(c.educational.aiAgent.capabilities),
            note: c.educational.aiAgent.note.trim(),
          }
        : null,
    },
    seo: { bullets: trimArr(c.seo.bullets), whyDedicated: c.seo.whyDedicated.trim() },
    timeline: c.timeline
      .map((t) => ({
        title: t.title.trim(),
        description: t.description.trim(),
        duration: t.duration.trim(),
      }))
      .filter((t) => t.title),
    paymentTerms: trimArr(c.paymentTerms),
    hosting: {
      hosting: c.hosting.hosting.trim(),
      storage: c.hosting.storage.trim(),
      domain: c.hosting.domain.trim(),
    },
    maintenance: trimArr(c.maintenance),
    quality: {
      bullets: trimArr(c.quality.bullets),
      assumptions: trimArr(c.quality.assumptions),
      nextSteps: trimArr(c.quality.nextSteps),
    },
  };
  // PRESENCE of `sections` is what tells the PDF this proposal was composed
  // rather than templated. A proposal with none must come out of here with no
  // key at all — `[]` would re-classify it.
  if (sections) {
    out.sections = sections;
    out.sectionsMode = c.sectionsMode;
  } else {
    delete out.sections;
    delete out.sectionsMode;
  }
  return out;
}

export function ProposalGenerator({
  clients,
  priceAmounts,
  editing,
  onExitEdit,
}: {
  clients: ClientLite[];
  /** Live /pricing amounts, keyed by PriceField.key. */
  priceAmounts: Record<string, number>;
  /** A saved proposal being edited, or null for a fresh one. The parent keys
   * this component on the row id, so this is read once at mount. */
  editing?: Proposal | null;
  onExitEdit?: () => void;
}) {
  const router = useRouter();

  /**
   * The saved row as this form sees it. Merged over the defaults exactly the
   * way every other reader does it, so a proposal saved before a field existed
   * simply gets the default for it and nothing is invented.
   */
  const initial = React.useMemo(() => {
    const sel: ProposalSelection = {
      ...defaultSelection(),
      ...((editing?.selection ?? {}) as Partial<ProposalSelection>),
    };
    const cnt: ProposalContent = {
      ...defaultContent(),
      ...((editing?.content ?? {}) as Partial<ProposalContent>),
    };
    return { sel, cnt, shape: (hasItems(sel) ? "items" : "package") as Shape };
  }, [editing]);

  /** The shape the saved row is stored in, or null for a fresh proposal. Fixed
   * for the life of this form — converting must not rewrite what it was. */
  const savedShape: Shape | null = editing ? initial.shape : null;

  const [clientName, setClientName] = React.useState(editing?.client_name ?? "");
  const [projectName, setProjectName] = React.useState(
    editing?.project_name || suggestedProjectName(initial.sel),
  );
  const projectTouched = React.useRef(Boolean(editing?.project_name));
  const [date, setDate] = React.useState(
    editing?.proposal_date || format(new Date(), "yyyy-MM-dd"),
  );
  const [businessDescription, setBusinessDescription] = React.useState("");
  const [selection, setSelection] = React.useState<ProposalSelection>(initial.sel);
  const [content, setContent] = React.useState<ProposalContent>(initial.cnt);
  const [shape, setShape] = React.useState<Shape>(initial.shape);
  const [convertTo, setConvertTo] = React.useState<Shape | null>(null);
  const [structure, setStructure] = React.useState<Structure>("auto");
  const [showFixed, setShowFixed] = React.useState(false);
  const [extraInstructions, setExtraInstructions] = React.useState("");
  const dictation = useDictation((text) =>
    setExtraInstructions((prev) => (prev ? `${prev.trimEnd()} ${text}` : text)),
  );
  const { error: dictationError, clearError: clearDictationError } = dictation;
  React.useEffect(() => {
    if (!dictationError) return;
    toast.error(dictationError);
    clearDictationError();
  }, [dictationError, clearDictationError]);

  const [generating, startGen] = React.useTransition();
  // An existing proposal already has its content — it opens ready to edit,
  // download and re-save without being regenerated first.
  const [generated, setGenerated] = React.useState(Boolean(editing));
  const [saving, setSaving] = React.useState(false);

  /**
   * The live price list with the team's saved edits applied — the same catalog
   * the /pricing page shows, rebuilt here from the amounts the server resolved.
   * Every line the builder offers comes from this, features included, so a
   * proposal can never quote a package that isn't on the price list.
   */
  const catalog: PricingGroup[] = React.useMemo(
    () => applyOverrides(priceAmounts),
    [priceAmounts],
  );

  /**
   * The selection with today's /pricing amounts resolved onto it. Everything
   * downstream — the total, the PDF, the saved row — uses this, so the numbers
   * follow the Pricing page instead of the constants in proposal.ts. Saving
   * freezes them, which is what stops an old proposal re-pricing itself later.
   */
  const priced = React.useMemo(
    () => ({ ...selection, prices: selectionPrices(priceAmounts, selection) }),
    [selection, priceAmounts],
  );
  const pricing = buildPricing(priced);
  const cleaned = clean(content);

  const items = selection.items ?? [];
  const sections = content.sections ?? [];
  const sectionsMode: ProposalSectionsMode = content.sectionsMode ?? "replace_narrative";
  /** Whether the fixed narrative fields still reach the page at all. */
  const narrativePrinted = sections.length === 0 || sectionsMode === "append";
  const termsPrinted = sections.length === 0 || sectionsMode !== "replace_all";

  function patchSelection(patch: Partial<ProposalSelection>) {
    setSelection((prev) => {
      const next = { ...prev, ...patch };
      if (!projectTouched.current) setProjectName(suggestedProjectName(next));
      return next;
    });
  }

  /**
   * Write the line items — or REMOVE the key entirely when the list empties.
   * `items: []` must never be stored: presence of the key is what marks a
   * proposal item-driven, so an empty array would re-classify a proposal that
   * has nothing in it.
   */
  function setItems(next: ProposalLineItem[]) {
    setSelection((prev) => {
      const out = { ...prev };
      if (next.length > 0) out.items = next;
      else {
        delete out.items;
        delete out.notes;
      }
      if (!projectTouched.current) setProjectName(suggestedProjectName(out));
      return out;
    });
  }

  function setNotes(lines: string[]) {
    setSelection((prev) => {
      const out = { ...prev };
      const kept = trimArr(lines);
      if (kept.length > 0) out.notes = lines;
      else delete out.notes;
      return out;
    });
  }

  function setSections(
    next: ProposalSection[],
    mode: ProposalSectionsMode | undefined,
  ) {
    setContent((prev) => {
      const out = { ...prev };
      if (next.length > 0) {
        out.sections = next;
        out.sectionsMode = mode ?? "replace_narrative";
      } else {
        delete out.sections;
        delete out.sectionsMode;
      }
      return out;
    });
  }

  /**
   * The single package turned into the first line of an item-driven proposal,
   * with its features copied across from the price list. Falls back to a
   * bespoke line for a legacy tier that has no entry on the current list, so
   * an old proposal can still be converted without losing its price.
   */
  function seedFromPackage(): ProposalLineItem {
    const line = pricing.lineItems[0];
    const key = legacyCatalogKey(selection);
    if (key) {
      const catalogAmount = priceAmounts[key];
      // Only override when the team is actually charging something else —
      // passing the list price back in would strip a package's "(starts at)".
      const negotiated =
        line && Number.isFinite(line.amount) && line.amount !== catalogAmount
          ? { amount: line.amount, listAmount: line.original }
          : undefined;
      const built = lineItemFromCatalog(catalog, key, negotiated);
      if (built) return built;
    }
    return bespokeLine(
      line?.label ?? selectionSummary(selection),
      line?.amount ?? 0,
      includedFeatures(selection),
    );
  }

  function applyConversion(to: Shape) {
    if (to === "items") {
      if (items.length === 0) setItems([seedFromPackage()]);
      setShape("items");
    } else {
      setItems([]);
      setShape("package");
    }
    setConvertTo(null);
  }

  function requestShape(to: Shape) {
    if (to === shape) return;
    // Converting a SAVED single-package proposal changes how it is stored, and
    // dropping the lines off an item-driven one throws real work away. Both get
    // said out loud before they happen; a brand-new proposal has nothing to
    // lose, so it just switches.
    const needsNotice =
      (to === "items" && savedShape === "package") ||
      (to === "package" && items.length > 0);
    if (needsNotice) setConvertTo(to);
    else applyConversion(to);
  }

  function generate() {
    if (!businessDescription.trim()) {
      toast.error("Add a short business description first.");
      return;
    }
    startGen(async () => {
      const res = await generateProposal({
        businessDescription,
        clientName,
        projectName,
        selection: priced,
        extraInstructions,
        freeSections:
          structure === "auto" ? undefined : structure === "free",
      });
      if (res.ok) {
        setContent((prev) => {
          const next = { ...prev, ...res.content };
          // A run that filled the fixed skeleton returns no sections. Leaving
          // the previous run's sections behind would suppress the narrative it
          // just wrote — the proposal would print the OLD document.
          if (!res.content.sections) {
            delete next.sections;
            delete next.sectionsMode;
          }
          return next;
        });
        setGenerated(true);
        toast.success("Draft ready — edit anything below, then download.");
      } else {
        toast.error(res.error);
      }
    });
  }

  /** Save an existing proposal back over itself; insert a brand-new one. */
  async function persist() {
    const payload = {
      client_name: clientName,
      project_name: projectName,
      proposal_date: date,
      selection: priced,
      content: cleaned,
      grand_total: pricing.oneTimeTotal,
    };
    return editing
      ? updateProposal({ ...payload, id: editing.id })
      : saveProposal(payload);
  }

  /**
   * Turn the finished proposal into an invoice: save it first (so the
   * proposal itself is archived), then hand its customer and priced lines to
   * the invoice generator, which renders them into the branded invoice
   * template ready to review and download.
   */
  async function handleGenerateInvoice() {
    if (!clientName.trim()) {
      toast.error("Add a client name.");
      return;
    }
    setSaving(true);
    const saveRes = await persist();
    if (!saveRes.ok) toast.error(`Couldn't save the proposal: ${saveRes.error}`);

    // ONE-TIME lines only. An invoice bills once, so a monthly retainer or an
    // at-cost pass-through on it would charge the client a recurring fee as a
    // single up-front amount — and the items would no longer sum to the total.
    const billable = pricing.lineItems.filter(
      (l) => (l.recurrence ?? "one_time") === "one_time",
    );
    const skipped = pricing.lineItems.length - billable.length;

    stashInvoiceDraft({
      billToName: clientName.trim(),
      billToDetails: "",
      items: billable.map((l) => ({
        item: l.label,
        description: "",
        total: l.amount,
      })),
      sourceLabel: projectName.trim() || `${clientName.trim()} proposal`,
    });
    setSaving(false);
    if (skipped > 0) {
      toast.info(
        `${skipped} recurring line${skipped === 1 ? "" : "s"} left off the invoice — bill those on their own cycle.`,
      );
    }
    router.push(
      `/invoices?${INVOICE_HANDOFF_PARAM}=${INVOICE_HANDOFF_SOURCE}`,
    );
  }

  async function handleDownload() {
    if (!clientName.trim()) {
      toast.error("Add a client name.");
      return;
    }
    setSaving(true);
    const saveRes = await persist();
    if (saveRes.ok) {
      toast.success(
        editing ? "Saved over the existing proposal." : "Saved to Past proposals.",
      );
      router.refresh();
    } else {
      toast.error(`Couldn't save: ${saveRes.error}`);
    }
    try {
      await downloadProposalPdf({
        client_name: clientName,
        project_name: projectName,
        proposal_date: date,
        selection: priced,
        content: cleaned,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't download the PDF.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            {editing ? "Editing proposal" : "Proposal Generator"}
          </h1>
          <p className="text-sm text-slate-500">
            {editing
              ? `Saved proposal for ${editing.client_name || "this client"} — changes overwrite it.`
              : "Describe the business, pick what they're buying, generate with AI, then edit and download."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editing && onExitEdit && (
            <Button variant="ghost" onClick={onExitEdit}>
              <FilePlus2 className="h-4 w-4" /> New proposal
            </Button>
          )}
          {generated && (
            <>
              <Button
                variant="outline"
                onClick={handleGenerateInvoice}
                disabled={saving}
              >
                <Receipt className="h-4 w-4" /> Generate invoice
              </Button>
              <Button onClick={handleDownload} loading={saving}>
                <Download className="h-4 w-4" />
                {editing ? "Save & download PDF" : "Download PDF"}
              </Button>
            </>
          )}
        </div>
      </div>

      {editing && savedShape === "package" && shape === "package" && (
        <div className="no-print rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-xs text-slate-600">
          <strong className="font-semibold text-slate-800">
            Saved as a single-package proposal.
          </strong>{" "}
          It keeps printing exactly the numbers it was sent with. Switching it to
          multiple packages changes how it&rsquo;s stored — you&rsquo;ll be told
          before that happens.
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(360px,440px)_1fr]">
        {/* ---------- FORM ---------- */}
        <div className="no-print space-y-5">
          <Card title="Client & project">
            <Field label="Client name" required>
              <Input
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="e.g. Green Engineering Systems"
                list="proposal-clients"
              />
              <datalist id="proposal-clients">
                {clients.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.company ?? ""}
                  </option>
                ))}
              </datalist>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Project name">
                <Input
                  value={projectName}
                  onChange={(e) => {
                    projectTouched.current = true;
                    setProjectName(e.target.value);
                  }}
                  placeholder="Website + AI Agent"
                />
              </Field>
              <Field label="Date">
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </Field>
            </div>
          </Card>

          <Card title="Business description">
            <Field
              label="What does this business do?"
              hint="The more detail you give, the more tailored the proposal. Used by the AI only."
            >
              <Textarea
                value={businessDescription}
                onChange={(e) => setBusinessDescription(e.target.value)}
                rows={5}
                placeholder="e.g. A solar energy company in Sri Lanka serving residential, commercial and utility-scale clients…"
              />
            </Field>
          </Card>

          <Card title="What the client is buying">
            <Field
              label="How this proposal is priced"
              hint={
                shape === "items"
                  ? "Any number of packages — website, social retainer, add-ons — each with its own price and billing."
                  : "One package, priced from the list. Switch to multiple if they're buying more than one thing."
              }
            >
              <Segmented
                options={[
                  { value: "package", label: "One package" },
                  { value: "items", label: "Multiple packages" },
                ]}
                value={shape}
                onChange={(v) => requestShape(v as Shape)}
              />
            </Field>

            {convertTo && (
              <ConversionNotice
                to={convertTo}
                seedLabel={pricing.lineItems[0]?.label ?? ""}
                seedAmount={pricing.lineItems[0]?.amount ?? 0}
                itemCount={items.length}
                savedShape={savedShape}
                onConfirm={() => applyConversion(convertTo)}
                onCancel={() => setConvertTo(null)}
              />
            )}

            {shape === "items" ? (
              <>
                <ItemBuilder
                  items={items}
                  catalog={catalog}
                  onChange={setItems}
                />
                <Lines
                  label="Notes under the totals"
                  value={selection.notes ?? []}
                  rows={2}
                  placeholder="e.g. No monthly fee to ARC — the client pays only their own AI usage, at cost."
                  onChange={setNotes}
                />
              </>
            ) : (
              <>
                <Field label="Project type">
                  <Segmented
                    options={[
                      { value: "business", label: "Business website" },
                      { value: "ecommerce", label: "E-commerce" },
                      { value: "agent", label: "AI agent" },
                    ]}
                    value={selection.type}
                    onChange={(v) => {
                      const type = v as ProposalSelection["type"];
                      patchSelection({ type });
                      // The stock timeline talks pages & design — swap it for the
                      // agent deployment plan (and back) while nothing's generated.
                      if (!generated) {
                        setContent((c) => ({
                          ...c,
                          timeline:
                            type === "agent"
                              ? AGENT_TIMELINE
                              : defaultContent().timeline,
                        }));
                      }
                    }}
                  />
                </Field>

                {selection.type === "agent" ? (
                  <>
                    <Field label="Package">
                      <Segmented
                        options={[
                          {
                            value: "whatsapp",
                            label: `WhatsApp — ${money(AGENT_PLANS.whatsapp.price)}`,
                          },
                          {
                            value: "instagram",
                            label: `Instagram — ${money(AGENT_PLANS.instagram.price)}`,
                          },
                          {
                            value: "smart_system_budget",
                            label: `System Budget — ${money(AGENT_PLANS.smart_system_budget.price)}`,
                          },
                        ]}
                        value={selection.agentPlatform ?? "whatsapp"}
                        onChange={(v) =>
                          patchSelection({ agentPlatform: v as AgentPlatform })
                        }
                      />
                    </Field>
                    <p className="text-[11px] text-slate-400">
                      {AGENT_PLANS[selection.agentPlatform ?? "whatsapp"].name} — no
                      website build. CRM included. One-time{" "}
                      {money(AGENT_PLANS[selection.agentPlatform ?? "whatsapp"].price)}
                      , no monthly fee; the client pays only their own AI usage, at
                      cost.
                    </p>
                  </>
                ) : selection.type === "business" ? (
                  <>
                    <Field label="Package">
                      <div className="grid grid-cols-3 gap-2">
                        {BUSINESS_TIER_OPTIONS.map((t) => (
                          <TierButton
                            key={t}
                            tier={t}
                            active={selection.tier === t}
                            onClick={() => patchSelection({ tier: t })}
                          />
                        ))}
                      </div>
                    </Field>
                    <PackageSummary tier={selection.tier} />
                  </>
                ) : (
                  <>
                    <Field label="Package">
                      <Segmented
                        options={[
                          { value: "store", label: `Store — from ${money(ECOMMERCE.store.price)}` },
                          { value: "smart", label: `Smart Store — from ${money(ECOMMERCE.smart.price)}` },
                        ]}
                        value={selection.platform}
                        onChange={(v) =>
                          patchSelection({
                            platform: v as ProposalSelection["platform"],
                          })
                        }
                      />
                    </Field>
                    {selection.platform === "smart" && (
                      <p className="text-[11px] text-slate-400">
                        Store + customer profiles + automations. Extra automations
                        beyond the standard set go in as custom line items at{" "}
                        {money(ECOMMERCE.addons.automation)} each.
                      </p>
                    )}
                    {selection.platform === "custom" && (
                      <div className="space-y-2">
                        <Toggle
                          label={`Payment gateway (+${money(ECOMMERCE.addons.paymentGateway)})`}
                          checked={selection.paymentGateway}
                          onChange={(v) => patchSelection({ paymentGateway: v })}
                        />
                        <Toggle
                          label={`Delivery integration (+${money(ECOMMERCE.addons.delivery)})`}
                          checked={selection.delivery}
                          onChange={(v) => patchSelection({ delivery: v })}
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {(shape === "items" || selection.type !== "agent") && (
              <div className="grid grid-cols-2 gap-3 pt-1">
                <Field label="Maintenance">
                  <Select
                    value={selection.maintenance}
                    onChange={(e) =>
                      patchSelection({
                        maintenance: e.target.value as MaintenanceKey,
                      })
                    }
                  >
                    <option value="none">None</option>
                    <option value="m3">3 months — {money(MAINTENANCE.m3.price)}</option>
                    <option value="m6">6 months — {money(MAINTENANCE.m6.price)}</option>
                    <option value="m12">12 months — {money(MAINTENANCE.m12.price)}</option>
                  </Select>
                </Field>
                <Field label="Monthly SEO">
                  <div className="pt-1.5">
                    <Toggle
                      label="Add monthly SEO"
                      checked={selection.monthlySeo}
                      onChange={(v) => patchSelection({ monthlySeo: v })}
                    />
                  </div>
                </Field>
              </div>
            )}

            <Totals pricing={pricing} />
          </Card>

          <Card title="Extra features the client wants">
            <p className="-mt-1 text-[11px] text-slate-400">
              One-time additions on top of everything above. A negative price is
              a discount.
            </p>
            <div className="space-y-3">
              {(selection.customFeatures || []).map((feat, i) => (
                <div key={i} className="flex gap-2 items-end">
                  <div className="flex-1">
                    <Field label={`Feature ${i + 1}`}>
                      <Input
                        value={feat.name}
                        onChange={(e) => {
                          const updated = [...(selection.customFeatures || [])];
                          updated[i] = { ...updated[i], name: e.target.value };
                          patchSelection({ customFeatures: updated });
                        }}
                        placeholder="e.g. Custom CRM sync"
                      />
                    </Field>
                  </div>
                  <div className="w-32">
                    <Field label="Price (LKR)">
                      <Input
                        type="number"
                        value={feat.price || ""}
                        onChange={(e) => {
                          const updated = [...(selection.customFeatures || [])];
                          updated[i] = { ...updated[i], price: Number(e.target.value) || 0 };
                          patchSelection({ customFeatures: updated });
                        }}
                        placeholder="Price"
                      />
                    </Field>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-slate-400 hover:text-rose-600 mb-1"
                    onClick={() => {
                      const updated = (selection.customFeatures || []).filter((_, j) => j !== i);
                      patchSelection({ customFeatures: updated });
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-center"
                onClick={() => {
                  const updated = [...(selection.customFeatures || []), { name: "", price: 0 }];
                  patchSelection({ customFeatures: updated });
                }}
              >
                <Plus className="h-4 w-4" /> Add custom feature
              </Button>
            </div>
          </Card>

          {/* Anything else — typed or dictated, folded into the AI generation */}
          <section className="rounded-2xl border border-primary-200/70 bg-primary-50/30 p-5 shadow-[var(--shadow-card)]">
            <h2 className="mb-1 text-sm font-semibold text-slate-900">
              Any other instructions?
            </h2>
            <p className="mb-3 text-[11px] text-slate-500">
              Say it however it comes out — hit the mic and talk, or just type.
              Tone, things to emphasise, anything the client mentioned. The AI
              follows it when writing the proposal.
            </p>
            <div className="relative">
              <Textarea
                className="min-h-[96px] resize-y pr-12"
                value={extraInstructions}
                onChange={(e) => setExtraInstructions(e.target.value)}
                placeholder="e.g. they care most about WhatsApp orders — lead with that, keep it short, and mention we can start next week"
              />
              <button
                type="button"
                onClick={dictation.toggle}
                disabled={dictation.status === "transcribing"}
                aria-label={
                  dictation.status === "recording"
                    ? "Stop dictation"
                    : "Dictate instructions"
                }
                title={
                  dictation.status === "recording"
                    ? "Stop dictation"
                    : "Dictate instructions"
                }
                className={cn(
                  "absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-lg transition-colors",
                  dictation.status === "recording"
                    ? "bg-rose-600 text-white hover:bg-rose-700"
                    : "bg-white text-slate-400 ring-1 ring-slate-200 hover:text-primary-600",
                  dictation.status === "transcribing" && "cursor-not-allowed opacity-60",
                )}
              >
                {dictation.status === "transcribing" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : dictation.status === "recording" ? (
                  <Square className="h-3.5 w-3.5 fill-current" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </button>
            </div>
            {(dictation.status === "recording" ||
              dictation.status === "transcribing") && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                {dictation.status === "recording" ? (
                  <>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-rose-500" />
                    Listening — press the square when you&rsquo;re done.
                  </>
                ) : (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Writing down what you said…
                  </>
                )}
              </p>
            )}

            <div className="mt-4">
              <Field
                label="Structure"
                hint="Free-form lets the AI choose the sections this client needs — no SEO heading on a proposal with no SEO in it."
              >
                <Select
                  value={structure}
                  onChange={(e) => setStructure(e.target.value as Structure)}
                >
                  <option value="auto">
                    Let the AI decide (free-form for multi-package)
                  </option>
                  <option value="free">Free-form — the AI designs the sections</option>
                  <option value="fixed">Standard sections</option>
                </Select>
              </Field>
            </div>
          </section>

          {/* Generate */}
          <Button
            onClick={generate}
            loading={generating}
            size="lg"
            className="w-full justify-center"
          >
            <Sparkles className="h-4 w-4" />
            {generated ? "Regenerate with AI" : "Generate proposal with AI"}
          </Button>

          {!generated && (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-5 text-center text-sm text-slate-500">
              Fill in the details above and click{" "}
              <strong>Generate proposal with AI</strong>. The full proposal will
              appear here and on the right — then you can edit any part before
              downloading.
            </div>
          )}

          {generated && (
            <Card title="Written sections">
              <p className="-mt-1 mb-1 text-xs text-slate-400">
                The sections the AI composed for this client, in its order. Edit,
                reorder, add or remove them — the preview updates live.
              </p>
              <SectionsEditor
                sections={sections}
                mode={content.sectionsMode}
                onChange={setSections}
              />
            </Card>
          )}

          {/* Editable content (after generation) */}
          {generated && (
          <Card title="Standard sections">
            {narrativePrinted ? (
              <p className="-mt-1 mb-1 text-xs text-slate-400">
                Edit anything below — the preview updates live. Lists are one item
                per line.
              </p>
            ) : (
              <div className="-mt-1 space-y-2">
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  {termsPrinted
                    ? "Your written sections replace the write-up below, so none of it prints. The terms, maintenance and quality standards still do."
                    : "Your written sections are the whole proposal — only the Investment table and the sign-off print alongside them. Nothing below is on this document."}
                </p>
                <button
                  type="button"
                  onClick={() => setShowFixed((v) => !v)}
                  className="text-[11px] font-semibold text-primary-700 transition hover:text-primary-800"
                >
                  {showFixed ? "Hide" : "Show"} the standard fields anyway
                </button>
              </div>
            )}

            {(narrativePrinted || showFixed) && (
              <>
            <Field label="Overview">
              <Textarea
                value={content.overview}
                onChange={(e) => setContent({ ...content, overview: e.target.value })}
                rows={5}
                placeholder="Intro paragraphs (blank line between paragraphs)…"
              />
            </Field>

            <Repeater
              label="Objectives"
              items={content.objectives}
              onAdd={() =>
                setContent({
                  ...content,
                  objectives: [...content.objectives, { group: "", items: [] }],
                })
              }
              onRemove={(i) =>
                setContent({
                  ...content,
                  objectives: content.objectives.filter((_, j) => j !== i),
                })
              }
              render={(g, i) => (
                <>
                  <Input
                    value={g.group}
                    onChange={(e) =>
                      setContent({
                        ...content,
                        objectives: content.objectives.map((x, j) =>
                          j === i ? { ...x, group: e.target.value } : x,
                        ),
                      })
                    }
                    placeholder="Group, e.g. Brand & Trust"
                  />
                  <Lines
                    value={g.items}
                    rows={3}
                    placeholder="One objective per line"
                    onChange={(items) =>
                      setContent({
                        ...content,
                        objectives: content.objectives.map((x, j) =>
                          j === i ? { ...x, items } : x,
                        ),
                      })
                    }
                  />
                </>
              )}
            />

            <Repeater
              label="Key features"
              items={content.keyFeatures}
              onAdd={() =>
                setContent({
                  ...content,
                  keyFeatures: [
                    ...content.keyFeatures,
                    { heading: "", intro: "", bullets: [] },
                  ],
                })
              }
              onRemove={(i) =>
                setContent({
                  ...content,
                  keyFeatures: content.keyFeatures.filter((_, j) => j !== i),
                })
              }
              render={(f, i) => (
                <>
                  <Input
                    value={f.heading}
                    onChange={(e) =>
                      setContent({
                        ...content,
                        keyFeatures: content.keyFeatures.map((x, j) =>
                          j === i ? { ...x, heading: e.target.value } : x,
                        ),
                      })
                    }
                    placeholder="Heading"
                  />
                  <Input
                    value={f.intro}
                    onChange={(e) =>
                      setContent({
                        ...content,
                        keyFeatures: content.keyFeatures.map((x, j) =>
                          j === i ? { ...x, intro: e.target.value } : x,
                        ),
                      })
                    }
                    placeholder="Short intro"
                  />
                  <Lines
                    value={f.bullets}
                    rows={3}
                    placeholder="One feature per line"
                    onChange={(bullets) =>
                      setContent({
                        ...content,
                        keyFeatures: content.keyFeatures.map((x, j) =>
                          j === i ? { ...x, bullets } : x,
                        ),
                      })
                    }
                  />
                </>
              )}
            />

            <Field label="Educational strategy intro">
              <Textarea
                value={content.educational.intro}
                rows={2}
                onChange={(e) =>
                  setContent({
                    ...content,
                    educational: { ...content.educational, intro: e.target.value },
                  })
                }
                placeholder="Why education matters for this business…"
              />
            </Field>
            <Lines
              label="Educational points"
              value={content.educational.bullets}
              rows={3}
              onChange={(bullets) =>
                setContent({
                  ...content,
                  educational: { ...content.educational, bullets },
                })
              }
            />

            <Lines
              label="SEO points"
              value={content.seo.bullets}
              rows={3}
              onChange={(bullets) =>
                setContent({ ...content, seo: { ...content.seo, bullets } })
              }
            />
            <Field label="Why dedicated pages matter">
              <Textarea
                value={content.seo.whyDedicated}
                rows={2}
                onChange={(e) =>
                  setContent({
                    ...content,
                    seo: { ...content.seo, whyDedicated: e.target.value },
                  })
                }
              />
            </Field>
              </>
            )}

            <Lines
              label="Payment terms"
              value={content.paymentTerms}
              rows={4}
              onChange={(paymentTerms) => setContent({ ...content, paymentTerms })}
            />
            <Lines
              label="Maintenance & support"
              value={content.maintenance}
              rows={4}
              onChange={(maintenance) => setContent({ ...content, maintenance })}
            />

            <Lines
              label="Quality standards"
              value={content.quality.bullets}
              rows={3}
              onChange={(bullets) =>
                setContent({
                  ...content,
                  quality: { ...content.quality, bullets },
                })
              }
            />
            <Lines
              label="Assumptions & exclusions"
              value={content.quality.assumptions}
              rows={3}
              onChange={(assumptions) =>
                setContent({
                  ...content,
                  quality: { ...content.quality, assumptions },
                })
              }
            />
            <Lines
              label="Next steps"
              value={content.quality.nextSteps}
              rows={3}
              onChange={(nextSteps) =>
                setContent({
                  ...content,
                  quality: { ...content.quality, nextSteps },
                })
              }
            />
          </Card>
          )}
        </div>

        {/* ---------- LIVE PREVIEW — the real PDF, exactly as downloaded ---------- */}
        <div className="min-w-0">
          <ProposalPdfFrame
            className="sticky top-4 h-[85vh]"
            payload={{
              client_name: clientName,
              project_name: projectName,
              proposal_date: date,
              selection: priced,
              content: cleaned,
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------------- small building blocks ---------------- */

/**
 * Said out loud before the shape of a stored proposal changes. The rule this
 * enforces: a proposal is never quietly rewritten into the other shape —
 * whoever is editing it decides, knowing what it costs them.
 */
function ConversionNotice({
  to,
  seedLabel,
  seedAmount,
  itemCount,
  savedShape,
  onConfirm,
  onCancel,
}: {
  to: Shape;
  seedLabel: string;
  seedAmount: number;
  itemCount: number;
  savedShape: Shape | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2.5 rounded-xl border border-amber-200 bg-amber-50/70 p-3.5">
      <p className="text-xs font-semibold text-amber-900">
        {to === "items"
          ? "This changes how the proposal is stored"
          : "The lines you've added will be dropped"}
      </p>
      {to === "items" ? (
        <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-amber-800">
          <li>
            <strong>{seedLabel || "The selected package"}</strong> becomes the
            first line at {money(seedAmount)}, with its features copied in from
            the price list.
          </li>
          <li>
            The package picker stops setting the price — the lines do. Nothing is
            re-priced: the figure above is exactly what it is now.
          </li>
          {savedShape === "package" && (
            <li>
              This proposal was <strong>saved in the single-package shape</strong>
              . Saving after this converts it; until you save, the stored one is
              untouched.
            </li>
          )}
        </ul>
      ) : (
        <p className="text-[11px] leading-relaxed text-amber-800">
          {itemCount} line{itemCount === 1 ? "" : "s"} will be removed and the
          proposal goes back to being priced from a single package. The package
          picker&rsquo;s own price takes over.
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={onConfirm}>
          {to === "items" ? "Convert to multiple packages" : "Go back to one package"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The money summary. One-time is what the client pays now (and what the saved
 * proposal's total means); anything recurring is shown on its own so a monthly
 * retainer can never be read as a one-off. */
function Totals({ pricing }: { pricing: ReturnType<typeof buildPricing> }) {
  const monthly = pricing.monthlyTotal ?? 0;
  const yearly = pricing.yearlyTotal ?? 0;
  return (
    <div className="mt-2 space-y-1.5 rounded-xl bg-slate-50 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-500">One-time total</span>
        <span className="text-lg font-bold text-slate-900">
          {money(pricing.oneTimeTotal)}
        </span>
      </div>
      {monthly > 0 && (
        <div className="flex items-center justify-between border-t border-slate-200/70 pt-1.5">
          <span className="text-xs font-medium text-slate-500">Monthly</span>
          <span className="text-sm font-semibold text-slate-700">
            {money(monthly)}/month
          </span>
        </div>
      )}
      {yearly > 0 && (
        <div className="flex items-center justify-between border-t border-slate-200/70 pt-1.5">
          <span className="text-xs font-medium text-slate-500">Yearly</span>
          <span className="text-sm font-semibold text-slate-700">
            {money(yearly)}/year
          </span>
        </div>
      )}
      {pricing.recurringNotes.length > 0 && (
        <ul className="space-y-0.5 border-t border-slate-200/70 pt-1.5">
          {pricing.recurringNotes.map((n, i) => (
            <li key={i} className="text-[11px] leading-snug text-slate-400">
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex w-full rounded-xl border border-slate-200 bg-slate-50 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition",
            value === o.value
              ? "bg-primary-600 text-white shadow-sm"
              : "text-slate-500 hover:text-slate-800",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-medium transition",
        checked
          ? "border-primary-300 bg-primary-50 text-primary-700"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
      )}
    >
      <span
        className={cn(
          "grid h-4 w-4 place-items-center rounded border",
          checked ? "border-primary-500 bg-primary-500 text-white" : "border-slate-300",
        )}
      >
        {checked && "✓"}
      </span>
      {label}
    </button>
  );
}

function TierButton({
  tier,
  active,
  onClick,
}: {
  tier: BusinessTierKey;
  active: boolean;
  onClick: () => void;
}) {
  const t = BUSINESS_TIERS[tier];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-xl border px-3 py-2 text-left transition",
        active
          ? "border-primary-300 bg-primary-50 ring-2 ring-primary-100"
          : "border-slate-200 hover:bg-slate-50",
      )}
    >
      <span className="block text-xs font-bold text-slate-900">{t.name}</span>
      <span className="block text-[11px] text-slate-500">
        {t.pages} pages · {money(t.price)}
      </span>
    </button>
  );
}

function PackageSummary({ tier }: { tier: BusinessTierKey }) {
  const t = BUSINESS_TIERS[tier];
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3 text-xs text-slate-500">
      <span className="font-semibold text-slate-700">{t.name}</span> — {t.pages}{" "}
      pages, {money(t.price)}
      {t.monthlyNote ? ` (${t.monthlyNote})` : ""}.
    </div>
  );
}

function Lines({
  label,
  value,
  onChange,
  rows = 3,
  placeholder,
}: {
  label?: string;
  value: string[];
  onChange: (v: string[]) => void;
  rows?: number;
  placeholder?: string;
}) {
  const body = (
    <Textarea
      value={value.join("\n")}
      rows={rows}
      placeholder={placeholder ?? "One item per line"}
      onChange={(e) => onChange(e.target.value.split("\n"))}
    />
  );
  return label ? <Field label={label}>{body}</Field> : body;
}

function Repeater<T>({
  label,
  items,
  onAdd,
  onRemove,
  render,
}: {
  label: string;
  items: T[];
  onAdd: () => void;
  onRemove: (i: number) => void;
  render: (item: T, i: number) => React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1 rounded-lg bg-primary-50 px-2 py-1 text-xs font-semibold text-primary-700 transition hover:bg-primary-100"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      <div className="space-y-3">
        {items.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400">
            Nothing yet — generate with AI or add manually.
          </p>
        )}
        {items.map((item, i) => (
          <div
            key={i}
            className="space-y-2 rounded-xl border border-slate-100 bg-slate-50/60 p-3"
          >
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label="Remove"
                className="grid h-6 w-6 place-items-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {render(item, i)}
          </div>
        ))}
      </div>
    </div>
  );
}
