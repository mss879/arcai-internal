#!/usr/bin/env node
/**
 * Does the live database actually have what the migrations say it has?
 *
 * 0025_content_studio and 0060_notices were never applied, and nobody
 * noticed for roughly sixty migrations. They stayed invisible because the
 * things that would normally shout were all built to stay quiet: 0081's
 * audit-trigger loop skips a missing table with `if to_regclass(...) is not
 * null`, database.types.ts is hand-written so TypeScript was happy, and the
 * app carries 27+ `// 0NNN not applied` fallbacks that render an empty
 * screen instead of raising. A half-applied database ships green through CI
 * and reports healthy.
 *
 * So this is the missing check. It parses every `create table public.X` and
 * every `alter table public.X add column Y` out of supabase/migrations/,
 * asks the live database what it actually has, and exits non-zero on a
 * difference.
 *
 * Columns matter as much as tables, and are easier to miss: a migration that
 * only ALTERs adds no table, so a table-only check calls it clean. 0128 is
 * exactly that shape — one added column and one index — and would have been
 * invisible here.
 *
 *   node scripts/schema-audit.mjs              check, exit 1 on drift
 *   node scripts/schema-audit.mjs --json       machine-readable report
 *   node scripts/schema-audit.mjs --record-baseline
 *                                             stamp every migration file as
 *                                             applied (run ONCE, only when
 *                                             the check above is clean)
 *
 * Run it BEFORE and AFTER every apply. Before catches a database that had
 * already drifted; after catches a file that half-applied.
 *
 * It reads the live table list from PostgREST's OpenAPI spec at
 * `GET <url>/rest/v1/`, which returns every exposed table in ONE request.
 * Probing tables one at a time over HTTP takes minutes and times out.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. It only
 * ever reads, except for --record-baseline, which writes schema_migrations.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

const asJson = process.argv.includes("--json");
const recordBaseline = process.argv.includes("--record-baseline");

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !KEY) {
  console.error(
    "schema-audit: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n" +
      "They are in .env.local; this script never writes them anywhere.",
  );
  process.exit(2);
}

/** Every migration file, in apply order. */
function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Tables the migrations create, and the file that creates each.
 *
 * A table may be created in one file and dropped in another; `drop table`
 * is rare here and is tracked so a deliberately-removed table does not
 * read as drift.
 */
function expectedTables() {
  const created = new Map();
  const dropped = new Set();
  for (const file of migrationFiles()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    // Strip line comments so a table named only in prose is not counted.
    const code = sql.replace(/--[^\n]*/g, "");
    for (const m of code.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
    )) {
      const name = m[1].toLowerCase();
      if (!created.has(name)) created.set(name, file);
      dropped.delete(name);
    }
    for (const m of code.matchAll(
      /drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
    )) {
      dropped.add(m[1].toLowerCase());
    }
  }
  for (const name of dropped) created.delete(name);
  return created;
}

/**
 * Columns the migrations add with `alter table ... add column`.
 *
 * Only the ALTER form: columns inside a `create table` body arrive with the
 * table, and a table that exists at all almost always has them. The ALTER
 * form is the one that half-applies invisibly.
 *
 * Returns Map<table, Map<column, file>>.
 */
function expectedColumns() {
  const wanted = new Map();
  for (const file of migrationFiles()) {
    const code = readFileSync(path.join(MIGRATIONS, file), "utf8")
      .replace(/--[^\n]*/g, "");
    for (const stmt of code.split(";")) {
      const head = /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/i.exec(stmt);
      if (!head) continue;
      const table = head[1].toLowerCase();
      for (const m of stmt.matchAll(
        /add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi,
      )) {
        const col = m[1].toLowerCase();
        if (!wanted.has(table)) wanted.set(table, new Map());
        if (!wanted.get(table).has(col)) wanted.get(table).set(col, file);
      }
      for (const m of stmt.matchAll(
        /drop\s+column\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?/gi,
      )) {
        wanted.get(table)?.delete(m[1].toLowerCase());
      }
    }
  }
  return wanted;
}

/** Every table PostgREST exposes, in one request. */
async function liveTables() {
  const res = await fetch(`${URL_.replace(/\/$/, "")}/rest/v1/`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) {
    throw new Error(
      `PostgREST spec request failed: ${res.status} ${res.statusText}`,
    );
  }
  const spec = await res.json();
  const names = new Set();
  for (const p of Object.keys(spec.paths ?? {})) {
    if (p === "/" || !p.startsWith("/")) continue;
    const name = p.slice(1);
    if (name && !name.includes("/") && !name.startsWith("rpc")) names.add(name);
  }
  // The same spec carries every column, so this stays one request.
  const columns = new Map();
  for (const [name, def] of Object.entries(spec.definitions ?? {})) {
    columns.set(name, new Set(Object.keys(def?.properties ?? {})));
  }
  return { names, columns };
}

/** Stamp every migration file into schema_migrations. */
async function stampBaseline(files) {
  const rows = files.map((f) => ({
    version: f.replace(/\.sql$/, ""),
    note: "recorded by schema-audit --record-baseline",
  }));
  const res = await fetch(
    `${URL_.replace(/\/$/, "")}/rest/v1/schema_migrations?on_conflict=version`,
    {
      method: "POST",
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Could not write schema_migrations: ${res.status} ${await res.text()}\n` +
        "Apply 0129_access_boundary.sql first — it creates the table.",
    );
  }
  return rows.length;
}

const expected = expectedTables();
const expectedCols = expectedColumns();
const { names: live, columns: liveCols } = await liveTables();

const missing = [...expected.entries()]
  .filter(([name]) => !live.has(name))
  .map(([name, file]) => ({ table: name, declared_in: file }));

// Columns are only checked on tables that exist — a missing table is
// already reported, and listing all its columns again is noise.
const missingColumns = [];
for (const [table, cols] of expectedCols) {
  if (!live.has(table)) continue;
  const have = liveCols.get(table);
  if (!have) continue;
  for (const [col, file] of cols) {
    if (!have.has(col)) {
      missingColumns.push({ table, column: col, declared_in: file });
    }
  }
}

// Views and PostgREST-exposed extras are not drift; only report tables the
// migrations never mention, which usually means someone made one by hand.
const unexpected = [...live].filter((name) => !expected.has(name));

const report = {
  ok: missing.length === 0 && missingColumns.length === 0,
  migrations: migrationFiles().length,
  expected_tables: expected.size,
  live_tables: live.size,
  missing,
  missing_columns: missingColumns,
  unexpected,
};

if (recordBaseline) {
  if (!report.ok) {
    console.error(
      "schema-audit: refusing to record a baseline while the schema has drifted.\n" +
        "Fix it first — a baseline recorded now would assert an apply history\n" +
        "that is not true.",
    );
    process.exit(1);
  }
  const n = await stampBaseline(migrationFiles());
  console.log(`schema-audit: recorded ${n} migrations as applied.`);
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (report.ok) {
  console.log(
    `schema-audit: OK — ${report.expected_tables} tables and every added ` +
      `column from ${report.migrations} migrations are live.`,
  );
  if (unexpected.length) {
    console.log(
      `  (${unexpected.length} live object(s) no migration creates: ` +
        `${unexpected.join(", ")} — views and extensions are expected here.)`,
    );
  }
  process.exit(0);
}

console.error("schema-audit: DRIFT\n");
if (missing.length) {
  console.error(`${missing.length} table(s) missing:`);
  for (const m of missing) {
    console.error(`  ${m.table}  — declared in ${m.declared_in}`);
  }
  console.error("");
}
if (missingColumns.length) {
  console.error(`${missingColumns.length} column(s) missing:`);
  for (const m of missingColumns) {
    console.error(`  ${m.table}.${m.column}  — declared in ${m.declared_in}`);
  }
  console.error("");
}
console.error(
  "\nThe app will NOT crash on these; it degrades quietly and renders empty\n" +
    "screens. Apply the migrations above, then run this again.",
);
process.exit(1);
