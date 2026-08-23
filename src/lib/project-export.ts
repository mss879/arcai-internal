/**
 * The board, as a file (VIEW-5).
 *
 * Two audiences, two formats: the accountant wants every row and every column
 * in something a spreadsheet opens, and the client who asks what they have
 * spent with you this year wants one branded page.
 *
 * Client-safe: the CSV is built in the browser from what is already on screen,
 * so exporting never re-queries and always matches the filters you can see.
 */

export type ExportRow = {
  name: string;
  client: string;
  status: string;
  stage: string;
  serviceType: string;
  currency: string;
  totalValue: number;
  received: number;
  balance: number;
  marginPercent: number | null;
  dueDate: string | null;
  team: string;
};

const COLUMNS: { key: keyof ExportRow; label: string }[] = [
  { key: "name", label: "Project" },
  { key: "client", label: "Client" },
  { key: "status", label: "Status" },
  { key: "stage", label: "Delivery stage" },
  { key: "serviceType", label: "Service" },
  { key: "currency", label: "Currency" },
  { key: "totalValue", label: "Value" },
  { key: "received", label: "Received" },
  { key: "balance", label: "Balance" },
  { key: "marginPercent", label: "Margin %" },
  { key: "dueDate", label: "Due date" },
  { key: "team", label: "Team" },
];

/**
 * Quote a value for CSV.
 *
 * The leading-character guard is not decoration: a project named "=cmd" or a
 * client called "+44 …" is executed as a formula by Excel and Sheets the
 * moment the file is opened. Prefixing an apostrophe is the standard fix and
 * costs nothing for ordinary text.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

export function projectsToCsv(rows: ExportRow[], opts: { includeMargin: boolean }): string {
  const columns = opts.includeMargin
    ? COLUMNS
    : COLUMNS.filter((c) => c.key !== "marginPercent");

  const lines = [columns.map((c) => cell(c.label)).join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const value = row[c.key];
          // Percentages export as a number so a spreadsheet can total them;
          // a null margin exports as blank rather than a misleading zero.
          if (c.key === "marginPercent") return value === null ? "" : cell(value);
          return cell(value);
        })
        .join(","),
    );
  }
  // A BOM so Excel opens UTF-8 names (Sinhala, Tamil, accents) correctly
  // rather than as mojibake.
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Trigger a browser download of a generated file. Browser-only. */
export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: revoking synchronously can beat the download
  // starting in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
