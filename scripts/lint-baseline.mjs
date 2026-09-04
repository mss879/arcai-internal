#!/usr/bin/env node
/**
 * ESLint gate that fails only on NEW errors.
 *
 * This repo carries a small number of long-standing lint errors in files
 * nobody is working on. Blocking CI on them would mean either fixing code
 * unasked or turning lint off; neither is right. So the check is per-file and
 * relative: a file may keep the errors it already had, and may not gain any.
 *
 *   node scripts/lint-baseline.mjs           check against lint-baseline.json
 *   node scripts/lint-baseline.mjs --write   record the current counts
 *
 * Files absent from the baseline must be clean. Files in the baseline that no
 * longer exist (e.g. work-in-progress that is not committed) simply pass — the
 * baseline is an upper bound, never a requirement.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE = path.join(ROOT, "lint-baseline.json");
const write = process.argv.includes("--write");

/** Run ESLint over the repo and return its JSON report. */
function runEslint() {
  // ESLint exits non-zero when it finds errors, which is the normal case here.
  // Only a crash (no parsable stdout) is a real failure.
  let stdout;
  try {
    stdout = execFileSync("npx", ["eslint", "--format", "json", "."], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    stdout = e.stdout;
    if (!stdout) {
      console.error(e.stderr || e.message);
      process.exit(2);
    }
  }
  const start = stdout.indexOf("[");
  if (start < 0) {
    console.error("eslint produced no JSON report:\n" + stdout);
    process.exit(2);
  }
  return JSON.parse(stdout.slice(start));
}

/** file (repo-relative, posix) -> error count, for files with at least one. */
function errorCounts(report) {
  const counts = {};
  for (const result of report) {
    if (!result.errorCount) continue;
    const rel = path.relative(ROOT, result.filePath).split(path.sep).join("/");
    counts[rel] = result.errorCount;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

const counts = errorCounts(runEslint());
const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

if (write) {
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + "\n");
  console.log(`Wrote lint-baseline.json: ${total} error(s) across ${Object.keys(counts).length} file(s).`);
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error("lint-baseline.json is missing or unreadable. Run: node scripts/lint-baseline.mjs --write");
  process.exit(2);
}

const regressions = Object.entries(counts)
  .map(([file, count]) => ({ file, count, allowed: baseline[file] ?? 0 }))
  .filter((r) => r.count > r.allowed);

if (regressions.length) {
  console.error("New ESLint errors above the baseline:\n");
  for (const r of regressions) {
    console.error(`  ${r.file}: ${r.count} error(s), baseline allows ${r.allowed}`);
  }
  console.error("\nFix them, or — if they are genuinely pre-existing — run:");
  console.error("  node scripts/lint-baseline.mjs --write\n");
  process.exit(1);
}

console.log(`ESLint at or below baseline: ${total} error(s) across ${Object.keys(counts).length} file(s).`);
