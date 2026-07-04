"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import type { CrmField, Pipeline, PipelineStage } from "@/lib/types";

import { importLeads, type ImportRow } from "../actions";

/** Minimal CSV parser handling quotes, commas and newlines in fields. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const TARGETS = [
  { value: "", label: "— skip column —" },
  { value: "title", label: "Lead title" },
  { value: "contact_name", label: "Contact name" },
  { value: "contact_email", label: "Email" },
  { value: "contact_phone", label: "Phone" },
  { value: "company", label: "Company" },
  { value: "value", label: "Deal value" },
  { value: "notes", label: "Notes" },
  { value: "tags", label: "Tags (comma separated)" },
] as const;

/** Guess a mapping from the header name. */
function guessTarget(header: string): string {
  const h = header.toLowerCase();
  if (/(^|\s)(name|full name|contact)($|\s)/.test(h) && !h.includes("company"))
    return "contact_name";
  if (h.includes("email")) return "contact_email";
  if (h.includes("phone") || h.includes("mobile") || h.includes("tel")) return "contact_phone";
  if (h.includes("company") || h.includes("business") || h.includes("org")) return "company";
  if (h.includes("value") || h.includes("amount") || h.includes("budget")) return "value";
  if (h.includes("note") || h.includes("message") || h.includes("comment")) return "notes";
  if (h.includes("tag")) return "tags";
  if (h.includes("title") || h.includes("deal") || h.includes("lead")) return "title";
  return "";
}

export function ImportWizard({
  pipelines,
  stages,
  customFields,
}: {
  pipelines: Pipeline[];
  stages: PipelineStage[];
  customFields: CrmField[];
}) {
  const router = useRouter();
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [headers, setHeaders] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<string[][]>([]);
  const [mapping, setMapping] = React.useState<string[]>([]);
  const [pipelineId, setPipelineId] = React.useState(pipelines[0]?.id ?? "");
  const [stageId, setStageId] = React.useState("");
  const [dedupe, setDedupe] = React.useState(true);
  const [fireAutomations, setFireAutomations] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [result, setResult] = React.useState<{ imported: number; skipped: number } | null>(null);

  const pipelineStages = stages.filter((s) => s.pipeline_id === pipelineId);
  const effectiveStage = stageId || pipelineStages[0]?.id || "";

  const targetOptions = [
    ...TARGETS,
    ...customFields.map((f) => ({ value: `custom.${f.key}`, label: `Custom: ${f.label}` })),
  ];

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseCsv(String(reader.result ?? ""));
      if (parsed.length < 2) {
        toast.error("The file needs a header row and at least one data row.");
        return;
      }
      const [head, ...body] = parsed;
      setHeaders(head.map((h) => h.trim()));
      setRows(body);
      setMapping(head.map((h) => guessTarget(h)));
      setStep(2);
    };
    reader.readAsText(file);
  }

  const built: ImportRow[] = React.useMemo(() => {
    return rows.map((row) => {
      const lead: ImportRow = { title: "" };
      const custom: Record<string, unknown> = {};
      mapping.forEach((target, i) => {
        const raw = (row[i] ?? "").trim();
        if (!target || !raw) return;
        if (target.startsWith("custom.")) custom[target.slice(7)] = raw;
        else if (target === "value") lead.value = Number(raw.replace(/[^0-9.-]/g, "")) || null;
        else if (target === "tags")
          lead.tags = raw.split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
        else (lead as Record<string, unknown>)[target] = raw;
      });
      if (Object.keys(custom).length) lead.custom = custom;
      if (!lead.title) {
        lead.title =
          lead.contact_name ||
          lead.company ||
          lead.contact_email ||
          lead.contact_phone ||
          "";
      }
      if (lead.tags === undefined) lead.tags = ["imported"];
      return lead;
    });
  }, [rows, mapping]);

  const validRows = built.filter((r) => r.title.trim());

  async function handleImport() {
    setImporting(true);
    const res = await importLeads({
      pipeline_id: pipelineId,
      stage_id: effectiveStage,
      rows: validRows,
      dedupe,
      fireAutomations,
    });
    setImporting(false);
    if (res.ok) {
      setResult({ imported: res.imported, skipped: res.skipped });
      setStep(3);
    } else toast.error(res.error);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/crm"
          className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:text-slate-800"
          aria-label="Back to CRM"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <PageHeader
          title="Import leads from CSV"
          description="Upload the messy Excel export, map its columns, skip duplicates — done in a minute."
        />
      </div>

      {/* Steps indicator */}
      <div className="flex items-center gap-2 text-xs font-semibold">
        {["Upload", "Map columns", "Done"].map((label, i) => (
          <React.Fragment key={label}>
            {i > 0 && <span className="h-px w-8 bg-slate-200" />}
            <span
              className={cn(
                "rounded-full px-3 py-1",
                step === i + 1
                  ? "bg-primary-600 text-white"
                  : step > i + 1
                    ? "bg-emerald-50 text-emerald-600"
                    : "bg-slate-100 text-slate-400",
              )}
            >
              {i + 1}. {label}
            </span>
          </React.Fragment>
        ))}
      </div>

      {step === 1 && (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-slate-300 bg-white px-6 py-16 text-center transition-colors hover:border-primary-300 hover:bg-primary-50/20">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-900 text-white">
            <Upload className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800">
              Drop your CSV here or click to browse
            </p>
            <p className="mt-1 text-xs text-slate-400">
              First row must be headers (Name, Phone, Email, …). Save Excel files as CSV first.
            </p>
          </div>
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </label>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <FileSpreadsheet className="h-4 w-4 text-slate-400" />
              Map your columns
              <span className="font-normal text-slate-400">
                — {rows.length} rows, {validRows.length} importable
              </span>
            </h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {headers.map((header, i) => (
                <div key={i} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                  <p className="truncate text-xs font-semibold text-slate-600">{header}</p>
                  <p className="mt-0.5 truncate text-[11px] text-slate-400">
                    e.g. “{rows[0]?.[i] ?? ""}”
                  </p>
                  <Select
                    value={mapping[i] ?? ""}
                    onChange={(e) =>
                      setMapping((prev) => prev.map((m, j) => (j === i ? e.target.value : m)))
                    }
                    className="mt-2"
                  >
                    {targetOptions.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <h3 className="text-sm font-semibold text-slate-900">Where they land</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Pipeline">
                <Select
                  value={pipelineId}
                  onChange={(e) => {
                    setPipelineId(e.target.value);
                    setStageId("");
                  }}
                >
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Stage">
                <Select value={effectiveStage} onChange={(e) => setStageId(e.target.value)}>
                  {pipelineStages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="mt-3 space-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={dedupe}
                  onChange={(e) => setDedupe(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-primary-600"
                />
                Skip rows whose email or phone already exists (recommended)
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={fireAutomations}
                  onChange={(e) => setFireAutomations(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-primary-600"
                />
                Run “lead created” automations for imported leads
                <span className="text-xs text-amber-600">
                  (careful — this can SMS every imported contact)
                </span>
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              onClick={handleImport}
              loading={importing}
              disabled={validRows.length === 0 || !pipelineId || !effectiveStage}
            >
              Import {validRows.length} lead{validRows.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && result && (
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 px-6 py-12 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
          <h3 className="mt-3 text-lg font-bold text-emerald-800">
            {result.imported} lead{result.imported === 1 ? "" : "s"} imported
          </h3>
          <p className="mt-1 text-sm text-emerald-700">
            {result.skipped > 0 && `${result.skipped} skipped (duplicates or missing data). `}
            They&apos;re tagged “imported” so you can filter them on the board.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button onClick={() => router.push(`/crm?p=${pipelineId}`)}>Open the board</Button>
            <Button
              variant="outline"
              onClick={() => {
                setStep(1);
                setResult(null);
                setRows([]);
                setHeaders([]);
              }}
            >
              Import another file
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
