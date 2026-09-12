#!/usr/bin/env node
/**
 * Write a Meta Ads sync into the CRM (0132).
 *
 *   node scripts/ads-sync.mjs <payload.json> --dry-run   validate and print the plan; writes nothing
 *   node scripts/ads-sync.mjs <payload.json>             validate, then write
 *
 * The CRM holds no Meta token — the owner chose that. A Claude Code session
 * with a Meta Ads connector reads the numbers, writes them to a JSON file
 * (PAYLOAD CONTRACT v1, scripts/ads-sync-core.mjs and docs/meta-ads.md),
 * and runs this. So this script is deliberately narrow, because it is the
 * one thing a model is allowed to run against the production database:
 *
 *   * it writes ONLY meta_ad_entities and meta_ad_insights (upserts) and one
 *     meta_ad_syncs row — no other table, no delete, no update-by-filter;
 *   * it validates the whole file before its first request, so a bad file
 *     writes nothing;
 *   * any argument it does not know stops it (a mistyped --dry-run must not
 *     become a real write), and it refuses the sample fixture outright;
 *   * it checks the three tables exist first, so a database without 0132
 *     gets one clear sentence instead of a half-written sync;
 *   * it refuses a payload read from Meta BEFORE what is already stored, so
 *     an old file can never roll newer numbers back;
 *   * the sync row is written LAST, so "last synced" on /ads only moves
 *     when everything before it landed;
 *   * it never prints the service-role key, or the URL it came with.
 *
 * Credentials: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from
 * the environment, else from .env.local at the repo root. --dry-run needs
 * neither. Exit codes: 0 done (or dry run), 1 invalid payload or a failed
 * write, 2 bad usage or missing credentials.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  batchByShape,
  classifyRestError,
  describePlan,
  futureStampReason,
  latestTimestamp,
  parseArgs,
  parseDotEnv,
  sampleReason,
  staleWriteReason,
  toEntityRows,
  toInsightRows,
  toSyncRow,
  validatePayload,
} from "./ads-sync-core.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES_DIR = path.join(ROOT, "scripts", "fixtures");
const REQUEST_TIMEOUT_MS = 30_000;
const USAGE = "usage: node scripts/ads-sync.mjs <payload.json> [--dry-run]\nSee docs/meta-ads.md for the payload contract.";

function fail(message, code = 1) {
  console.error(`ads-sync: ${message}`);
  process.exit(code);
}

// Strict: an argument it does not know stops the run (parseArgs).
const args = parseArgs(process.argv.slice(2));
if (!args.ok) {
  console.error(`ads-sync: ${args.error}`);
  console.error(USAGE);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const { file, dryRun } = args;

/** The symlink-free absolute path, so the fixture guard cannot be walked around. */
function realPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// -- read and validate ------------------------------------------------------------

const filePath = path.resolve(process.cwd(), file);
let json;
try {
  json = JSON.parse(readFileSync(filePath, "utf8"));
} catch (e) {
  fail(`could not read ${file} as JSON: ${e instanceof Error ? e.message : String(e)}`);
}

const result = validatePayload(json);
if (!result.ok) {
  console.error(`ads-sync: ${file} does not match payload contract v1 — nothing was written.`);
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}
const payload = result.payload;
const entityRows = toEntityRows(payload);
const insightRows = toInsightRows(payload);
const entityBatches = batchByShape(entityRows);
const insightBatches = batchByShape(insightRows);

// What a real run refuses before any request. The dry run lists them too.
const refusals = [
  sampleReason(payload, { filePath: realPath(filePath), fixturesDir: realPath(FIXTURES_DIR) }),
  futureStampReason(payload.synced_at, new Date()),
].filter(Boolean);

console.log(`ads-sync: ${dryRun ? "DRY RUN — nothing will be written" : "writing"} ${file}`);
for (const line of describePlan(payload)) console.log(`  ${line}`);

const env = loadCredentials();

if (dryRun) {
  console.log("  would write:");
  console.log(`    upsert ${entityRows.length} row(s) into meta_ad_entities (on_conflict=id) in ${entityBatches.length} request(s)`);
  console.log(`    upsert ${insightRows.length} row(s) into meta_ad_insights (on_conflict=level,entity_id,date) in ${insightBatches.length} request(s)`);
  console.log("    insert 1 row into meta_ad_syncs");
  console.log(`  credentials for a real run: ${env ? "found" : "MISSING (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)"}`);
  for (const reason of refusals) console.log(`  a real run would be REFUSED: ${reason}`);
  console.log("  a real run also refuses a payload read from Meta before the numbers already stored.");
  process.exit(0);
}

if (refusals.length) fail(`refusing to write: ${refusals.join("; ")}. Nothing was written.`);

if (!env) {
  fail("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed — set them in the environment or .env.local.", 2);
}

// -- write --------------------------------------------------------------------------

try {
  await preflight();
  for (const batch of entityBatches) {
    await rest("POST", "meta_ad_entities", "?on_conflict=id", batch, "resolution=merge-duplicates,return=minimal");
  }
  for (const batch of insightBatches) {
    await rest("POST", "meta_ad_insights", "?on_conflict=level,entity_id,date", batch, "resolution=merge-duplicates,return=minimal");
  }
  await rest(
    "POST",
    "meta_ad_syncs",
    "",
    toSyncRow(payload, { entities: entityRows.length, insights: insightRows.length }),
    "return=minimal",
  );
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

console.log(
  `ads-sync: done — ${entityRows.length} entit${entityRows.length === 1 ? "y" : "ies"} and ${insightRows.length} insight row(s) upserted, sync recorded. Open /ads to read it.`,
);

// -- helpers ------------------------------------------------------------------------

/** URL + key from the environment, falling back to .env.local. Never printed. */
function loadCredentials() {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const envFile = path.join(ROOT, ".env.local");
  if ((!url || !key) && existsSync(envFile)) {
    const parsed = parseDotEnv(readFileSync(envFile, "utf8"));
    url ||= parsed.NEXT_PUBLIC_SUPABASE_URL;
    key ||= parsed.SUPABASE_SERVICE_ROLE_KEY;
  }
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

/**
 * Before the first write: all three tables answer (else one clear sentence
 * about 0132), and nothing stored for this account was read from Meta after
 * this payload was. Entities are checked as well as syncs because a sync
 * that died half-way wrote entities but no sync row.
 */
async function preflight() {
  const newest = `?ad_account_id=eq.${encodeURIComponent(payload.ad_account_id)}&select=synced_at&order=synced_at.desc&limit=1`;
  const [entities, syncs] = await Promise.all([
    rest("GET", "meta_ad_entities", newest).then((res) => res.json()),
    rest("GET", "meta_ad_syncs", newest).then((res) => res.json()),
    rest("GET", "meta_ad_insights", "?select=id&limit=1"),
  ]);
  const stored = latestTimestamp([...entities, ...syncs].map((row) => row?.synced_at));
  const stale = staleWriteReason(payload.synced_at, stored);
  if (stale) throw new Error(`refusing to write: ${stale} Nothing was written.`);
}

/**
 * One PostgREST request. Throws a readable Error on failure — naming the
 * table and what to do, never echoing the key or the project URL.
 */
async function rest(method, table, query, body, prefer) {
  let res;
  try {
    res = await fetch(`${env.url}/rest/v1/${table}${query}`, {
      method,
      headers: {
        apikey: env.key,
        Authorization: `Bearer ${env.key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? "timed out" : e instanceof Error ? e.message : String(e);
    throw new Error(`${method} ${table}: request failed (${reason}).`);
  }
  if (res.ok) return res;

  const text = await res.text().catch(() => "");
  let detail = {};
  try {
    detail = JSON.parse(text);
  } catch {
    detail = { message: text.slice(0, 300) };
  }
  const kind = classifyRestError({ status: res.status, code: detail.code, message: detail.message });
  if (kind === "missing_table") {
    throw new Error(
      `${table} does not exist — migration 0132_meta_ads.sql has not been applied to this database. Apply it (see docs/ops.md, "Meta Ads (0132)") and run this again. Nothing was written.`,
    );
  }
  if (kind === "missing_column") {
    throw new Error(
      `${table} is missing a column this script writes (${detail.message ?? "unknown column"}). The database is behind this script — apply supabase/migrations/0133_meta_ad_syncs_synced_at.sql (and 0132 before it, if needed). Nothing was written.`,
    );
  }
  if (kind === "auth") {
    throw new Error(`${method} ${table}: refused (${res.status}). SUPABASE_SERVICE_ROLE_KEY must be the service-role key, not the anon key.`);
  }
  throw new Error(`${method} ${table}: ${res.status} ${detail.code ?? ""} ${detail.message ?? ""}`.replace(/\s+/g, " ").trim());
}
