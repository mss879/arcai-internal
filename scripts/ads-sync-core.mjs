/**
 * The Meta Ads sync payload: its contract, its validation, and its mapping
 * to database rows (0132).
 *
 * The CRM holds no Meta token (the owner's choice, Sept 2026). A Claude Code
 * session with a Meta Ads connector reads the numbers, writes them to a JSON
 * file in the shape below, and `scripts/ads-sync.mjs` upserts it. This file
 * is the pure half of that script: nothing here touches the network, the
 * disk or the environment, so every rule is pinned by
 * scripts/ads-sync-core.test.mjs.
 *
 * Why so strict: the author of the payload is a model transcribing tool
 * output. A typo'd key ("daily_budgt") silently dropped, a spend of
 * "LKR1,234.56" stored as null, or a budget in minor units stored as major
 * would all put a wrong number on a screen people make spending decisions
 * from. So unknown keys are errors, strings are not numbers, and the error
 * says exactly what to fix.
 *
 * PAYLOAD CONTRACT v1 (docs/meta-ads.md has a worked example):
 *
 *   { version: 1,
 *     ad_account_id: "1148854332990641"      (digits; an "act_" prefix is stripped)
 *     currency: "LKR"                         (ISO 4217, the ad account's)
 *     synced_at: ISO timestamp                (when the numbers were read from Meta)
 *     window: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }   (ad-account days, inclusive)
 *     entities: [{ level, id, name, campaign_id?, adset_id?, status?,
 *                  effective_status?, objective?, optimization_goal?,
 *                  daily_budget? (MAJOR units), lifetime_budget?,
 *                  start_time?, end_time?, targeting?, creative?, raw? }]
 *     insights: [{ level, id, campaign_id?, adset_id?, date, spend,
 *                  impressions?, reach?, clicks?, link_clicks?,
 *                  conversations?, frequency?, cpm?, ctr?, raw? }]
 *     notes?: { summary?, health?: "good"|"watch"|"act", recommendations?: string[] } }
 */

export const PAYLOAD_VERSION = 1;
export const MAX_ENTITIES = 500;
export const MAX_INSIGHTS = 2_000;
export const MAX_RECOMMENDATIONS = 12;
export const MAX_RECOMMENDATION_LENGTH = 500;
export const MAX_SUMMARY_LENGTH = 4_000;
export const MAX_NAME_LENGTH = 400;
export const MAX_TEXT_LENGTH = 2_000;
/** Serialised size cap for free-form objects (targeting, raw). */
export const MAX_OBJECT_CHARS = 20_000;
/**
 * How far ahead of the clock synced_at may be (clock skew). Beyond it the
 * stamp is a typo, and a stamp from the future would make every real sync
 * after it look older — and be refused by the stale-write guard.
 */
export const FUTURE_SYNC_TOLERANCE_MS = 10 * 60_000;
/** How the sample fixture marks itself; a payload whose summary starts so is never written. */
export const SAMPLE_MARKER = "SAMPLE DATA";

export const LEVELS = ["campaign", "adset", "ad"];
export const HEALTH = ["good", "watch", "act"];

const TOP_KEYS = ["version", "ad_account_id", "currency", "synced_at", "window", "entities", "insights", "notes"];
const WINDOW_KEYS = ["start", "end"];
const ENTITY_KEYS = [
  "level", "id", "name", "campaign_id", "adset_id", "status", "effective_status",
  "objective", "optimization_goal", "daily_budget", "lifetime_budget",
  "start_time", "end_time", "targeting", "creative", "raw",
];
const CREATIVE_KEYS = ["headline", "body", "description", "prefill", "image_hash", "cta"];
const INSIGHT_KEYS = [
  "level", "id", "campaign_id", "adset_id", "date", "spend", "impressions",
  "reach", "clicks", "link_clicks", "conversations", "frequency", "cpm", "ctr", "raw",
];
const INSIGHT_COUNTS = ["impressions", "reach", "clicks", "link_clicks", "conversations"];
const INSIGHT_RATIOS = ["frequency", "cpm", "ctr"];
const NOTES_KEYS = ["summary", "health", "recommendations"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isDigits = (v) => typeof v === "string" && /^\d{1,32}$/.test(v);

/** True for a real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
export function isDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * An ISO timestamp → canonical UTC ISO, or null.
 *
 * Meta writes offsets without the colon ("2026-09-12T19:10:00+0530"), which
 * JavaScript's Date is not required to parse. The offset is normalised to
 * "+05:30" first, and a timestamp with NO offset is refused: a bare local
 * time is ambiguous by exactly the timezone this whole feature cares about.
 */
export function toIsoTimestamp(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)(Z|[+-]\d{2}:?\d{2})$/i);
  if (!m) return null;
  if (!isDay(m[1])) return null;
  let offset = m[3].toUpperCase();
  if (offset !== "Z" && !offset.includes(":")) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${offset}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Keys on an object that the contract does not know. */
function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

/**
 * Validate a parsed payload and return it normalised.
 *
 *   { ok: true,  errors: [], payload }   — safe to map and write
 *   { ok: false, errors: [...], payload: null }
 *
 * Every problem is collected rather than stopping at the first, so one
 * round of fixes is enough. Error strings name the exact path.
 */
export function validatePayload(json) {
  const errors = [];
  const err = (path, message) => errors.push(`${path}: ${message}`);
  // Validators compare this before and after, to know whether THEY failed.
  err.count = () => errors.length;

  if (!isObject(json)) {
    return { ok: false, errors: ["payload: expected a JSON object"], payload: null };
  }
  for (const key of unknownKeys(json, TOP_KEYS)) err(key, "unknown top-level key (contract v1 does not have it)");

  if (json.version !== PAYLOAD_VERSION) err("version", `expected ${PAYLOAD_VERSION}`);

  // An "act_" prefix is how Meta's own tools print the account; accept it.
  const rawAccount = typeof json.ad_account_id === "string" ? json.ad_account_id.trim().replace(/^act_/, "") : json.ad_account_id;
  if (!isDigits(rawAccount)) err("ad_account_id", "expected a digit string like \"1148854332990641\"");

  const currency = typeof json.currency === "string" ? json.currency.trim().toUpperCase() : null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) err("currency", "expected a 3-letter ISO currency code like \"LKR\"");

  const syncedAt = toIsoTimestamp(json.synced_at);
  if (!syncedAt) err("synced_at", "expected an ISO timestamp with an offset, e.g. \"2026-09-13T21:00:00+05:30\"");

  let window = null;
  if (!isObject(json.window)) {
    err("window", "expected { start: \"YYYY-MM-DD\", end: \"YYYY-MM-DD\" }");
  } else {
    for (const key of unknownKeys(json.window, WINDOW_KEYS)) err(`window.${key}`, "unknown key");
    const { start, end } = json.window;
    if (!isDay(start)) err("window.start", "expected a real date YYYY-MM-DD");
    if (!isDay(end)) err("window.end", "expected a real date YYYY-MM-DD");
    if (isDay(start) && isDay(end)) {
      if (start > end) err("window", "start is after end");
      else window = { start, end };
    }
  }

  // -- entities ---------------------------------------------------------------
  const entities = [];
  if (!Array.isArray(json.entities)) {
    err("entities", "expected an array (it may be empty)");
  } else if (json.entities.length > MAX_ENTITIES) {
    err("entities", `too many (${json.entities.length}); the cap is ${MAX_ENTITIES} per sync`);
  } else {
    const seen = new Set();
    json.entities.forEach((raw, i) => {
      const e = validateEntity(raw, `entities[${i}]`, err);
      if (!e) return;
      if (seen.has(e.id)) err(`entities[${i}].id`, `duplicate id ${e.id}`);
      seen.add(e.id);
      entities.push(e);
    });
  }

  // Parents known from this payload's entities, so an insight row may omit them.
  const parents = new Map(entities.map((e) => [e.id, e]));

  // -- insights ---------------------------------------------------------------
  const insights = [];
  if (!Array.isArray(json.insights)) {
    err("insights", "expected an array (it may be empty)");
  } else if (json.insights.length > MAX_INSIGHTS) {
    err("insights", `too many (${json.insights.length}); the cap is ${MAX_INSIGHTS} per sync — sync a shorter window`);
  } else {
    const seen = new Set();
    json.insights.forEach((raw, i) => {
      const row = validateInsight(raw, `insights[${i}]`, err, parents, window);
      if (!row) return;
      const key = `${row.level}:${row.id}:${row.date}`;
      if (seen.has(key)) err(`insights[${i}]`, `duplicate row for ${row.level} ${row.id} on ${row.date}`);
      seen.add(key);
      insights.push(row);
    });
  }

  // -- notes ------------------------------------------------------------------
  let notes = null;
  if (json.notes !== undefined && json.notes !== null) {
    notes = validateNotes(json.notes, err);
  }

  if (errors.length) return { ok: false, errors, payload: null };
  return {
    ok: true,
    errors: [],
    payload: {
      version: PAYLOAD_VERSION,
      ad_account_id: rawAccount,
      currency,
      synced_at: syncedAt,
      window,
      entities,
      insights,
      notes,
    },
  };
}

/** A non-negative finite number; the error names the fix for Meta's strings. */
function checkAmount(value, path, err, { integer = false } = {}) {
  if (typeof value === "string") {
    err(path, `expected a number, got the string ${JSON.stringify(value)} — strip the currency and thousands separators (e.g. "LKR1,234.56" → 1234.56)`);
    return false;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    err(path, "expected a number");
    return false;
  }
  if (value < 0) {
    err(path, "must not be negative");
    return false;
  }
  if (integer && !Number.isInteger(value)) {
    err(path, "expected a whole number");
    return false;
  }
  return true;
}

/** Optional short text: absent → undefined, null → null, else trimmed string. */
function optionalText(value, path, err, max = MAX_TEXT_LENGTH) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    err(path, "expected a string");
    return undefined;
  }
  if (value.length > max) {
    err(path, `too long (${value.length} characters; the cap is ${max})`);
    return undefined;
  }
  return value.trim();
}

/** Optional free-form object, size-capped so a raw dump cannot bloat a row. */
function optionalObject(value, path, err) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isObject(value)) {
    err(path, "expected an object");
    return undefined;
  }
  if (JSON.stringify(value).length > MAX_OBJECT_CHARS) {
    err(path, `too large (over ${MAX_OBJECT_CHARS} characters of JSON)`);
    return undefined;
  }
  return value;
}

function validateEntity(raw, path, err) {
  if (!isObject(raw)) {
    err(path, "expected an object");
    return null;
  }
  const before = errCount(err);
  for (const key of unknownKeys(raw, ENTITY_KEYS)) err(`${path}.${key}`, "unknown key");

  if (!LEVELS.includes(raw.level)) err(`${path}.level`, `expected one of ${LEVELS.join(", ")}`);
  if (!isDigits(raw.id)) err(`${path}.id`, "expected a Meta id as a digit string");
  if (typeof raw.name !== "string" || !raw.name.trim()) err(`${path}.name`, "expected a non-empty string");
  else if (raw.name.length > MAX_NAME_LENGTH) err(`${path}.name`, `too long (cap ${MAX_NAME_LENGTH})`);

  for (const key of ["campaign_id", "adset_id"]) {
    if (raw[key] !== undefined && raw[key] !== null && !isDigits(raw[key])) err(`${path}.${key}`, "expected a digit string");
  }
  // Parents are what make a row findable: /ads reads "every ad in this campaign".
  if (raw.level === "adset" && !raw.campaign_id) err(`${path}.campaign_id`, "required for an ad set");
  if (raw.level === "ad" && !raw.campaign_id) err(`${path}.campaign_id`, "required for an ad");
  if (raw.level === "campaign" && raw.campaign_id && raw.campaign_id !== raw.id) {
    err(`${path}.campaign_id`, "a campaign's campaign_id must be its own id");
  }
  if (raw.level === "adset" && raw.adset_id && raw.adset_id !== raw.id) {
    err(`${path}.adset_id`, "an ad set's adset_id must be its own id");
  }

  const out = {
    level: raw.level,
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name.trim() : "",
    campaign_id: raw.level === "campaign" ? raw.id : raw.campaign_id ?? undefined,
    adset_id: raw.level === "adset" ? raw.id : raw.adset_id ?? undefined,
  };

  for (const key of ["status", "effective_status", "objective", "optimization_goal"]) {
    const v = optionalText(raw[key], `${path}.${key}`, err, 100);
    if (v !== undefined) out[key] = v === null ? null : v.toUpperCase();
  }

  for (const key of ["daily_budget", "lifetime_budget"]) {
    if (raw[key] === undefined) continue;
    if (raw[key] === null) out[key] = null;
    else if (checkAmount(raw[key], `${path}.${key}`, err)) out[key] = round2(raw[key]);
  }

  for (const key of ["start_time", "end_time"]) {
    if (raw[key] === undefined) continue;
    if (raw[key] === null) {
      out[key] = null;
      continue;
    }
    const iso = toIsoTimestamp(raw[key]);
    if (!iso) err(`${path}.${key}`, "expected an ISO timestamp with an offset, e.g. \"2026-09-12T19:10:00+0530\"");
    else out[key] = iso;
  }
  if (out.start_time && out.end_time && out.start_time > out.end_time) {
    err(`${path}.end_time`, "is before start_time");
  }

  const targeting = optionalObject(raw.targeting, `${path}.targeting`, err);
  if (targeting !== undefined) out.targeting = targeting;
  const rawObj = optionalObject(raw.raw, `${path}.raw`, err);
  if (rawObj !== undefined) out.raw = rawObj;

  if (raw.creative !== undefined) {
    if (raw.creative === null) {
      out.creative = null;
    } else if (!isObject(raw.creative)) {
      err(`${path}.creative`, "expected an object");
    } else {
      for (const key of unknownKeys(raw.creative, CREATIVE_KEYS)) err(`${path}.creative.${key}`, "unknown key");
      const creative = {};
      for (const key of CREATIVE_KEYS) {
        const v = optionalText(raw.creative[key], `${path}.creative.${key}`, err);
        if (v !== undefined && v !== null && v !== "") creative[key] = v;
      }
      out.creative = creative;
    }
  }

  return errCount(err) === before ? out : null;
}

function validateInsight(raw, path, err, parents, window) {
  if (!isObject(raw)) {
    err(path, "expected an object");
    return null;
  }
  const before = errCount(err);
  for (const key of unknownKeys(raw, INSIGHT_KEYS)) err(`${path}.${key}`, "unknown key");

  if (!LEVELS.includes(raw.level)) err(`${path}.level`, `expected one of ${LEVELS.join(", ")}`);
  if (!isDigits(raw.id)) err(`${path}.id`, "expected a Meta id as a digit string");
  for (const key of ["campaign_id", "adset_id"]) {
    if (raw[key] !== undefined && raw[key] !== null && !isDigits(raw[key])) err(`${path}.${key}`, "expected a digit string");
  }
  if (!isDay(raw.date)) err(`${path}.date`, "expected a real date YYYY-MM-DD");
  else if (window && (raw.date < window.start || raw.date > window.end)) {
    err(`${path}.date`, `${raw.date} is outside the window ${window.start} → ${window.end}`);
  }
  if (raw.spend === undefined) err(`${path}.spend`, "required (0 for a day with no spend)");
  else checkAmount(raw.spend, `${path}.spend`, err);

  for (const key of INSIGHT_COUNTS) {
    if (raw[key] !== undefined && raw[key] !== null) checkAmount(raw[key], `${path}.${key}`, err, { integer: true });
  }
  for (const key of INSIGHT_RATIOS) {
    if (raw[key] !== undefined && raw[key] !== null) checkAmount(raw[key], `${path}.${key}`, err);
  }
  const rawObj = optionalObject(raw.raw, `${path}.raw`, err);

  // Parents: explicit, else the level itself, else the entity in this payload.
  const parent = parents.get(raw.id);
  const campaignId =
    raw.level === "campaign" ? raw.id : raw.campaign_id ?? parent?.campaign_id ?? null;
  const adsetId =
    raw.level === "adset" ? raw.id : raw.adset_id ?? parent?.adset_id ?? null;
  if (raw.level === "campaign" && raw.campaign_id && raw.campaign_id !== raw.id) {
    err(`${path}.campaign_id`, "a campaign row's campaign_id must be its own id");
  }
  if (raw.level !== "campaign" && LEVELS.includes(raw.level) && !campaignId) {
    err(`${path}.campaign_id`, "required for ad set and ad rows (or include the entity in this payload)");
  }

  if (errCount(err) !== before) return null;

  // A day's row is the whole truth for that day: a missing count is 0, a
  // missing ratio is unknown — so re-syncing a day always replaces all of it.
  const row = {
    level: raw.level,
    id: raw.id,
    campaign_id: campaignId,
    adset_id: adsetId,
    date: raw.date,
    spend: round2(raw.spend),
  };
  for (const key of INSIGHT_COUNTS) row[key] = raw[key] ?? 0;
  for (const key of INSIGHT_RATIOS) row[key] = raw[key] ?? null;
  row.raw = rawObj ?? null;
  return row;
}

function validateNotes(raw, err) {
  if (!isObject(raw)) {
    err("notes", "expected an object");
    return null;
  }
  for (const key of unknownKeys(raw, NOTES_KEYS)) err(`notes.${key}`, "unknown key");
  const out = { summary: null, health: null, recommendations: [] };

  const summary = optionalText(raw.summary, "notes.summary", err, MAX_SUMMARY_LENGTH);
  if (summary) out.summary = summary;

  if (raw.health !== undefined && raw.health !== null) {
    if (!HEALTH.includes(raw.health)) err("notes.health", `expected one of ${HEALTH.join(", ")}`);
    else out.health = raw.health;
  }

  if (raw.recommendations !== undefined && raw.recommendations !== null) {
    if (!Array.isArray(raw.recommendations)) {
      err("notes.recommendations", "expected an array of strings");
    } else if (raw.recommendations.length > MAX_RECOMMENDATIONS) {
      err("notes.recommendations", `too many (cap ${MAX_RECOMMENDATIONS})`);
    } else {
      raw.recommendations.forEach((rec, i) => {
        const v = optionalText(rec, `notes.recommendations[${i}]`, err, MAX_RECOMMENDATION_LENGTH);
        if (v === null || v === undefined) {
          if (rec === null) err(`notes.recommendations[${i}]`, "expected a string");
          return;
        }
        if (v) out.recommendations.push(v);
      });
    }
  }
  return out;
}

/** How many errors the collector holds (see `err.count` in validatePayload). */
function errCount(err) {
  return err.count();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// -- mapping ------------------------------------------------------------------

/**
 * Entity rows for `meta_ad_entities`.
 *
 * A key left out of the payload is left out of the row, so the upsert does
 * not touch that column: "not reported this time" must not erase a
 * creative synced last time. An explicit null does clear it.
 */
export function toEntityRows(payload) {
  return payload.entities.map((e) => {
    const row = {
      id: e.id,
      level: e.level,
      ad_account_id: payload.ad_account_id,
      name: e.name,
      currency: payload.currency,
      synced_at: payload.synced_at,
    };
    for (const key of [
      "campaign_id", "adset_id", "status", "effective_status", "objective",
      "optimization_goal", "daily_budget", "lifetime_budget", "start_time",
      "end_time", "targeting", "creative", "raw",
    ]) {
      if (e[key] !== undefined) row[key] = e[key];
    }
    return row;
  });
}

/** Insight rows for `meta_ad_insights` — every row carries every column. */
export function toInsightRows(payload) {
  return payload.insights.map((i) => ({
    level: i.level,
    entity_id: i.id,
    campaign_id: i.campaign_id,
    adset_id: i.adset_id,
    date: i.date,
    spend: i.spend,
    currency: payload.currency,
    impressions: i.impressions,
    reach: i.reach,
    clicks: i.clicks,
    link_clicks: i.link_clicks,
    conversations: i.conversations,
    frequency: i.frequency,
    cpm: i.cpm,
    ctr: i.ctr,
    raw: i.raw,
    synced_at: payload.synced_at,
  }));
}

/** The one `meta_ad_syncs` row that marks the sync complete. */
export function toSyncRow(payload, counts) {
  return {
    source: "claude",
    ad_account_id: payload.ad_account_id,
    window_start: payload.window.start,
    window_end: payload.window.end,
    entities_upserted: counts.entities,
    insights_upserted: counts.insights,
    summary: payload.notes?.summary ?? null,
    health: payload.notes?.health ?? null,
    recommendations: payload.notes?.recommendations ?? [],
    // When the numbers were READ from Meta. created_at (the database's now())
    // is only when this row landed; "last synced" and the stale-sync rule on
    // /ads read this, so an old payload can never pass for fresh.
    synced_at: payload.synced_at,
  };
}

// -- write guards -------------------------------------------------------------

/**
 * Why this payload must never be written for real, or null.
 *
 * The sample fixture carries the LIVE account, campaign and ad ids — so it
 * exercises the real shape — with invented numbers dated inside the live
 * flight. Written for real, it would overwrite those days' actual spend and
 * become the latest "Claude's read". Two independent tells, either enough:
 * the file sits under scripts/fixtures/, or its summary starts with
 * SAMPLE_MARKER. Paths should be real (symlink-resolved) and absolute.
 */
export function sampleReason(payload, { filePath, fixturesDir }) {
  // Lower-cased: the Mac's filesystem is case-insensitive, so Scripts/Fixtures is the same folder.
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const file = norm(filePath);
  const dir = norm(fixturesDir);
  if (dir && (file === dir || file.startsWith(`${dir}/`))) {
    return "the file is under scripts/fixtures/ — sample data, for --dry-run only";
  }
  const summary = payload?.notes?.summary;
  if (typeof summary === "string" && summary.trimStart().toUpperCase().startsWith(SAMPLE_MARKER)) {
    return `notes.summary starts with "${SAMPLE_MARKER}" — sample data, for --dry-run only`;
  }
  return null;
}

/**
 * Why this synced_at cannot be written, or null: it is ahead of the clock
 * by more than FUTURE_SYNC_TOLERANCE_MS. A write guard rather than a
 * contract rule, so a dry run of a payload stamped ahead (the fixture)
 * still validates; the real run is what must not store it.
 */
export function futureStampReason(syncedAt, now) {
  const at = Date.parse(syncedAt);
  if (!Number.isFinite(at) || !(now instanceof Date)) return null;
  if (at <= now.getTime() + FUTURE_SYNC_TOLERANCE_MS) return null;
  return `synced_at ${new Date(at).toISOString()} is in the future — use the time you read Meta. A future stamp would make every real sync after it look older, and be refused`;
}

/** The latest of some timestamps (unparseable ones ignored), or null. */
export function latestTimestamp(values) {
  let best = null;
  let bestMs = -Infinity;
  for (const value of values) {
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * Why writing this payload would roll newer numbers back, or null.
 *
 * Upserts merge whatever they are given, so without this an older payload
 * (a scratchpad file from yesterday, re-run) would replace today's rows for
 * the days it covers. Equal is allowed: re-running the same payload after a
 * failed write is how a half-finished sync is finished.
 */
export function staleWriteReason(payloadSyncedAt, storedSyncedAt) {
  const stored = storedSyncedAt ? Date.parse(storedSyncedAt) : NaN;
  const incoming = Date.parse(payloadSyncedAt);
  if (!Number.isFinite(stored) || !Number.isFinite(incoming)) return null;
  if (incoming >= stored) return null;
  return `this payload was read from Meta at ${new Date(incoming).toISOString()}, before the numbers already stored (read ${new Date(stored).toISOString()}). Writing it would roll them back — read Meta again and write a fresh payload.`;
}

// -- the command line ---------------------------------------------------------

// Every dash a keyboard, autocorrect or a model might put in front of a flag.
const DASH_START = /^[-‐-―−﹘﹣－]/;

/**
 * `node scripts/ads-sync.mjs <payload.json> [--dry-run]`, parsed strictly.
 *
 *   { ok: true, help, dryRun, file }  or  { ok: false, error }
 *
 * Anything the script does not know is an error, never skipped: a dry-run
 * typed "-dry-run", "—dry-run" (an autocorrected em dash) or "dry-run" must
 * stop the run, not fall through to a real write against production.
 */
export function parseArgs(argv) {
  let dryRun = false;
  let help = false;
  const files = [];
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (DASH_START.test(arg)) {
      return { ok: false, error: `unknown option ${JSON.stringify(arg)} — the only options are --dry-run and --help, with two ASCII hyphens` };
    } else if (/^(dry[-_ ]?run|help)$/i.test(arg)) {
      return { ok: false, error: `${JSON.stringify(arg)} looks like an option without its dashes — did you mean --${arg.toLowerCase().startsWith("h") ? "help" : "dry-run"}?` };
    } else files.push(arg);
  }
  if (help) return { ok: true, help: true, dryRun, file: files[0] ?? null };
  if (files.length === 0) return { ok: false, error: "missing the payload file" };
  if (files.length > 1) {
    return { ok: false, error: `expected exactly one payload file, got ${files.length}: ${files.map((f) => JSON.stringify(f)).join(", ")}` };
  }
  return { ok: true, help: false, dryRun, file: files[0] };
}

/**
 * Split rows into batches that share one exact key set.
 *
 * PostgREST builds a bulk insert's column list from the rows it is given;
 * mixing shapes would write NULL into the columns a row left out — the very
 * thing toEntityRows is careful not to do. Batches are also capped in size.
 */
export function batchByShape(rows, size = 500) {
  const groups = new Map();
  for (const row of rows) {
    const shape = Object.keys(row).sort().join(",");
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(row);
  }
  const out = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += size) out.push(group.slice(i, i + size));
  }
  return out;
}

/** A readable plan of what a sync will write — what `--dry-run` prints. */
export function describePlan(payload) {
  const byLevel = (items) =>
    LEVELS.map((level) => `${items.filter((x) => x.level === level).length} ${level}`).join(", ");
  const days = [...new Set(payload.insights.map((i) => i.date))].sort();
  const lines = [
    `account   ${payload.ad_account_id} (${payload.currency})`,
    `window    ${payload.window.start} → ${payload.window.end}`,
    `synced_at ${payload.synced_at}`,
    `entities  ${payload.entities.length} (${byLevel(payload.entities)})`,
    `insights  ${payload.insights.length} (${byLevel(payload.insights)})${days.length ? `, days ${days[0]} → ${days[days.length - 1]}` : ""}`,
  ];
  for (const campaign of payload.entities.filter((e) => e.level === "campaign")) {
    const rows = payload.insights.filter((i) => i.level === "campaign" && i.id === campaign.id);
    const spend = round2(rows.reduce((n, r) => n + r.spend, 0));
    const conversations = rows.reduce((n, r) => n + r.conversations, 0);
    lines.push(`campaign  ${campaign.id} "${campaign.name}" — ${payload.currency} ${spend.toLocaleString("en-US")} spent, ${conversations} conversations over ${rows.length} day row(s)`);
  }
  if (payload.notes) {
    lines.push(`notes     health=${payload.notes.health ?? "—"}, ${payload.notes.recommendations.length} recommendation(s)${payload.notes.summary ? ", summary present" : ""}`);
  }
  return lines;
}

// -- PostgREST errors ---------------------------------------------------------

/**
 * What a failed PostgREST call means, from its status and body.
 *
 *   "missing_table"   0132 is not applied (42P01, or PGRST205 from the schema cache)
 *   "missing_column"  0132 is half-applied or older than this script (42703 / PGRST204)
 *   "auth"            the key is wrong or is not the service-role key
 *   "other"           anything else — print it as-is
 *
 * The first two get a sentence that says what to run, because the raw
 * PostgREST text ("relation does not exist") reads like a bug in the script.
 */
export function classifyRestError({ status, code, message }) {
  const text = String(message ?? "");
  if (code === "42P01" || code === "PGRST205" || /could not find the table|relation .* does not exist/i.test(text)) {
    return "missing_table";
  }
  if (code === "42703" || code === "PGRST204" || /could not find the .* column|column .* does not exist/i.test(text)) {
    return "missing_column";
  }
  if (status === 401 || status === 403 || code === "42501") return "auth";
  return "other";
}

// -- .env.local ---------------------------------------------------------------

/**
 * Parse dotenv text into a plain object. KEY=VALUE per line; `#` comments,
 * blank lines and an `export ` prefix are ignored; matching single or double
 * quotes around a value are removed. Values are never logged by the caller.
 */
export function parseDotEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}
