"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { Download, Plus, Sparkles, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  BUSINESS_TIERS,
  ECOMMERCE,
  MAINTENANCE,
  buildPricing,
  defaultContent,
  defaultSelection,
  money,
  suggestedProjectName,
  type BusinessTierKey,
  type MaintenanceKey,
  type ProposalContent,
  type ProposalSelection,
} from "@/lib/proposal";
import type { Client } from "@/lib/types";

import { generateProposal, saveProposal } from "./actions";
import { downloadProposalPdf } from "./download-pdf";
import { ProposalDocument } from "./proposal-document";

type ClientLite = Pick<Client, "id" | "name" | "company">;
type Scope = "frontend" | "crm" | "ai";

const FRONTEND_TIERS: BusinessTierKey[] = ["starter", "launch"];

function scopeOf(tier: BusinessTierKey): Scope {
  if (tier === "growth") return "crm";
  if (tier === "scale") return "ai";
  return "frontend";
}

const trimArr = (a: string[]) => a.map((s) => s.trim()).filter(Boolean);

/** Strip empty/whitespace entries so the preview + PDF never show blank rows. */
function clean(c: ProposalContent): ProposalContent {
  return {
    overview: c.overview.trim(),
    objectives: c.objectives
      .map((g) => ({ group: g.group.trim(), items: trimArr(g.items) }))
      .filter((g) => g.group && g.items.length),
    websiteStructure: c.websiteStructure
      .map((p) => ({ page: p.page.trim(), description: p.description.trim() }))
      .filter((p) => p.page),
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
}

export function ProposalGenerator({ clients }: { clients: ClientLite[] }) {
  const router = useRouter();

  const [clientName, setClientName] = React.useState("");
  const [projectName, setProjectName] = React.useState(
    suggestedProjectName(defaultSelection()),
  );
  const projectTouched = React.useRef(false);
  const [date, setDate] = React.useState(format(new Date(), "yyyy-MM-dd"));
  const [businessDescription, setBusinessDescription] = React.useState("");
  const [selection, setSelection] = React.useState<ProposalSelection>(
    defaultSelection(),
  );
  const [content, setContent] = React.useState<ProposalContent>(defaultContent());

  const [generating, startGen] = React.useTransition();
  const [generated, setGenerated] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const pricing = buildPricing(selection);
  const cleaned = clean(content);

  function patchSelection(patch: Partial<ProposalSelection>) {
    setSelection((prev) => {
      const next = { ...prev, ...patch };
      if (!projectTouched.current) setProjectName(suggestedProjectName(next));
      return next;
    });
  }

  function setScope(scope: Scope) {
    if (scope === "crm") patchSelection({ type: "business", tier: "growth" });
    else if (scope === "ai") patchSelection({ type: "business", tier: "scale" });
    else
      patchSelection({
        type: "business",
        tier: FRONTEND_TIERS.includes(selection.tier) ? selection.tier : "launch",
      });
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
        selection,
      });
      if (res.ok) {
        setContent((prev) => ({ ...prev, ...res.content }));
        setGenerated(true);
        toast.success("Draft ready — edit anything below, then download.");
      } else {
        toast.error(res.error);
      }
    });
  }

  async function handleDownload() {
    if (!clientName.trim()) {
      toast.error("Add a client name.");
      return;
    }
    setSaving(true);
    const payload = {
      client_name: clientName,
      project_name: projectName,
      proposal_date: date,
      selection,
      content: cleaned,
    };
    const saveRes = await saveProposal({
      ...payload,
      grand_total: pricing.oneTimeTotal,
    });
    if (saveRes.ok) {
      toast.success("Saved to Past proposals.");
      router.refresh();
    } else {
      toast.error(`Couldn't save: ${saveRes.error}`);
    }
    try {
      await downloadProposalPdf(payload);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't download the PDF.",
      );
    } finally {
      setSaving(false);
    }
  }

  const scope = scopeOf(selection.tier);
  const displayDate = date ? format(new Date(date), "dd MMM, yyyy") : "";

  return (
    <div className="space-y-6">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Proposal Generator
          </h1>
          <p className="text-sm text-slate-500">
            Describe the business, pick the package, generate with AI, then edit
            and download.
          </p>
        </div>
        {generated && (
          <Button onClick={handleDownload} loading={saving}>
            <Download className="h-4 w-4" /> Download PDF
          </Button>
        )}
      </div>

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

          <Card title="What the client wants">
            <Field label="Project type">
              <Segmented
                options={[
                  { value: "business", label: "Business website" },
                  { value: "ecommerce", label: "E-commerce" },
                ]}
                value={selection.type}
                onChange={(v) =>
                  patchSelection({ type: v as ProposalSelection["type"] })
                }
              />
            </Field>

            {selection.type === "business" ? (
              <>
                <Field label="Scope">
                  <Segmented
                    options={[
                      { value: "frontend", label: "Front-end only" },
                      { value: "crm", label: "+ Backend CRM" },
                      { value: "ai", label: "+ CRM + AI Agent" },
                    ]}
                    value={scope}
                    onChange={(v) => setScope(v as Scope)}
                  />
                </Field>
                {scope === "frontend" && (
                  <Field label="Design tier">
                    <div className="grid grid-cols-2 gap-2">
                      {FRONTEND_TIERS.map((t) => (
                        <TierButton
                          key={t}
                          tier={t}
                          active={selection.tier === t}
                          onClick={() => patchSelection({ tier: t })}
                        />
                      ))}
                    </div>
                  </Field>
                )}
                <PackageSummary tier={selection.tier} />
              </>
            ) : (
              <>
                <Field label="Platform">
                  <Segmented
                    options={[
                      { value: "shopify", label: "Shopify" },
                      { value: "custom", label: "Custom Next.js" },
                    ]}
                    value={selection.platform}
                    onChange={(v) =>
                      patchSelection({
                        platform: v as ProposalSelection["platform"],
                      })
                    }
                  />
                </Field>
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

            <div className="mt-2 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5">
              <span className="text-sm font-medium text-slate-500">
                One-time total
              </span>
              <span className="text-lg font-bold text-slate-900">
                {money(pricing.oneTimeTotal)}
              </span>
            </div>
          </Card>

          <Card title="Extra features the client wants">
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

          {/* Editable content (after generation) */}
          {generated && (
          <Card title="Edit proposal content">
            <p className="-mt-1 mb-1 text-xs text-slate-400">
              Edit anything below — the preview updates live. Lists are one item
              per line.
            </p>

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
              label="Website structure"
              items={content.websiteStructure}
              onAdd={() =>
                setContent({
                  ...content,
                  websiteStructure: [
                    ...content.websiteStructure,
                    { page: "", description: "" },
                  ],
                })
              }
              onRemove={(i) =>
                setContent({
                  ...content,
                  websiteStructure: content.websiteStructure.filter(
                    (_, j) => j !== i,
                  ),
                })
              }
              render={(p, i) => (
                <>
                  <Input
                    value={p.page}
                    onChange={(e) =>
                      setContent({
                        ...content,
                        websiteStructure: content.websiteStructure.map((x, j) =>
                          j === i ? { ...x, page: e.target.value } : x,
                        ),
                      })
                    }
                    placeholder="Page name"
                  />
                  <Input
                    value={p.description}
                    onChange={(e) =>
                      setContent({
                        ...content,
                        websiteStructure: content.websiteStructure.map((x, j) =>
                          j === i ? { ...x, description: e.target.value } : x,
                        ),
                      })
                    }
                    placeholder="One-line description"
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

        {/* ---------- LIVE PREVIEW ---------- */}
        <div className="overflow-x-auto">
          <ProposalDocument
            clientName={clientName}
            projectName={projectName}
            displayDate={displayDate}
            selection={selection}
            content={cleaned}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------------- small building blocks ---------------- */

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
