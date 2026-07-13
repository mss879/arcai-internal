"use client";

import * as React from "react";
import { Download, Save, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import {
  PRICING_CATALOG,
  type PriceField,
  type PricingOverrides,
} from "@/lib/pricing-catalog";

import { savePricing, sendPricing } from "./actions";
import { downloadPricingPdf } from "./download-pricing-pdf";

// Flatten the code defaults once — used to detect which prices changed so we
// only persist real overrides (untouched keys fall back to the catalog).
const DEFAULTS: Record<string, number> = {};
for (const g of PRICING_CATALOG) {
  for (const p of g.packages) {
    for (const f of p.prices) DEFAULTS[f.key] = f.amount;
  }
}

type Values = Record<string, string>;

function initialValuesFrom(overrides: PricingOverrides): Values {
  const out: Values = {};
  for (const key of Object.keys(DEFAULTS)) {
    const o = overrides[key];
    out[key] = String(typeof o === "number" && Number.isFinite(o) ? o : DEFAULTS[key]);
  }
  return out;
}

/** Turn the on-screen values into a minimal { key: amount } override map. */
function overridesFrom(values: Values): PricingOverrides {
  const out: PricingOverrides = {};
  for (const [key, raw] of Object.entries(values)) {
    if (raw.trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n !== DEFAULTS[key]) out[key] = Math.round(n);
  }
  return out;
}

export function PricingView({
  initialOverrides,
}: {
  initialOverrides: PricingOverrides;
}) {
  const initial = React.useMemo(
    () => initialValuesFrom(initialOverrides),
    [initialOverrides],
  );
  const [values, setValues] = React.useState<Values>(initial);
  const [baseline, setBaseline] = React.useState<Values>(initial);
  const [saving, setSaving] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [sendOpen, setSendOpen] = React.useState(false);

  const dirty = React.useMemo(
    () => JSON.stringify(values) !== JSON.stringify(baseline),
    [values, baseline],
  );

  function setPrice(key: string, raw: string) {
    setValues((prev) => ({ ...prev, [key]: raw }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await savePricing(overridesFrom(values));
      if (res.ok) {
        setBaseline(values);
        toast.success("Pricing saved.");
      } else {
        toast.error(res.error);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      await downloadPricingPdf(overridesFrom(values));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pricing"
        description="Edit any price, then save, download a PDF, or email it to a client."
        actions={
          <>
            <Button variant="outline" onClick={handleDownload} loading={downloading}>
              <Download className="h-4 w-4" /> Download PDF
            </Button>
            <Button variant="outline" onClick={() => setSendOpen(true)}>
              <Send className="h-4 w-4" /> Send pricing
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={!dirty}>
              <Save className="h-4 w-4" /> {dirty ? "Save changes" : "Saved"}
            </Button>
          </>
        }
      />

      {dirty && (
        <p className="text-xs font-medium text-amber-600">
          You have unsaved changes — Download &amp; Send use your current edits, but Save to keep
          them.
        </p>
      )}

      <div className="space-y-8">
        {PRICING_CATALOG.map((group) => (
          <section key={group.key} className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{group.title}</h2>
              {group.subtitle && (
                <p className="text-sm text-slate-500">{group.subtitle}</p>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {group.packages.map((pkg) => (
                <div
                  key={pkg.key}
                  className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-slate-900">{pkg.name}</h3>
                    {pkg.badge && (
                      <span className="rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-semibold text-primary-700">
                        {pkg.badge}
                      </span>
                    )}
                  </div>
                  {pkg.tagline && (
                    <p className="mt-0.5 text-xs font-medium text-primary-700">{pkg.tagline}</p>
                  )}

                  {pkg.features && pkg.features.length > 0 && (
                    <ul className="mt-3 space-y-1">
                      {pkg.features.map((f, i) => (
                        <li key={i} className="flex gap-2 text-sm text-slate-600">
                          <span className="text-primary-500">•</span>
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                    {pkg.prices.length === 0 ? (
                      <p className="text-sm font-semibold text-primary-700">
                        {pkg.note ?? "Free"}
                      </p>
                    ) : (
                      pkg.prices.map((f) => (
                        <PriceInput
                          key={f.key}
                          field={f}
                          value={values[f.key] ?? ""}
                          onChange={(raw) => setPrice(f.key, raw)}
                        />
                      ))
                    )}
                  </div>

                  {pkg.prices.length > 0 && pkg.note && (
                    <p className="mt-3 text-xs text-slate-400">{pkg.note}</p>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <SendModal
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        overrides={overridesFrom(values)}
      />
    </div>
  );
}

function PriceInput({
  field,
  value,
  onChange,
}: {
  field: PriceField;
  value: string;
  onChange: (raw: string) => void;
}) {
  const symbol = field.currency === "USD" ? "$" : "Rs";
  return (
    <div>
      <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {field.label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        {field.prefix && <span className="text-xs text-slate-400">{field.prefix}</span>}
        <span className="text-sm font-semibold text-slate-500">{symbol}</span>
        <Input
          type="number"
          min={0}
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-36"
        />
        {field.suffix && <span className="text-xs text-slate-400">{field.suffix}</span>}
      </div>
    </div>
  );
}

function SendModal({
  open,
  onClose,
  overrides,
}: {
  open: boolean;
  onClose: () => void;
  overrides: PricingOverrides;
}) {
  const [email, setEmail] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [sending, setSending] = React.useState(false);

  async function handleSend() {
    setSending(true);
    try {
      const res = await sendPricing({ to: email, overrides, message });
      if (res.ok) {
        toast.success(`Pricing sent to ${email}.`);
        setEmail("");
        setMessage("");
        onClose();
      } else {
        toast.error(res.error);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send pricing"
      description="Email the current pricing as a branded PDF attachment."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSend} loading={sending} disabled={!email.trim()}>
            <Send className="h-4 w-4" /> Send
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium text-slate-700">Recipient email</label>
          <Input
            type="email"
            placeholder="client@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-slate-700">Message (optional)</label>
          <Textarea
            placeholder="Hi — here's our pricing as discussed. Let me know if you have any questions!"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="mt-1"
          />
        </div>
      </div>
    </Modal>
  );
}
