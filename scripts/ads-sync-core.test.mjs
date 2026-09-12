import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_INSIGHTS,
  batchByShape,
  classifyRestError,
  describePlan,
  futureStampReason,
  isDay,
  latestTimestamp,
  parseArgs,
  parseDotEnv,
  sampleReason,
  staleWriteReason,
  toEntityRows,
  toInsightRows,
  toIsoTimestamp,
  toSyncRow,
  validatePayload,
} from "./ads-sync-core.mjs";

const FIXTURE = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "fixtures", "ads-sync-sample.json"), "utf8"),
);
const clone = () => structuredClone(FIXTURE);
const errorsOf = (json) => validatePayload(json).errors;

describe("the sample payload", () => {
  it("is valid — the fixture is what the docs point Claude at", () => {
    const result = validatePayload(clone());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("normalises Meta's colon-less offsets to UTC", () => {
    const { payload } = validatePayload(clone());
    expect(payload.entities[0].start_time).toBe("2026-09-12T13:40:00.000Z");
    expect(payload.synced_at).toBe("2026-09-13T15:30:00.000Z");
  });

  it("gives parents to every row", () => {
    const { payload } = validatePayload(clone());
    const campaign = payload.entities.find((e) => e.level === "campaign");
    const adset = payload.entities.find((e) => e.level === "adset");
    expect(campaign.campaign_id).toBe(campaign.id);
    expect(adset.adset_id).toBe(adset.id);
    // The ad insight rows carry no parents in the file; they come from the entities.
    const adRow = payload.insights.find((i) => i.level === "ad");
    expect(adRow.campaign_id).toBe("120244355299530395");
    expect(adRow.adset_id).toBe("120244355301620395");
  });
});

describe("what it refuses", () => {
  it("refuses an unknown top-level key", () => {
    expect(errorsOf({ ...clone(), extra: 1 })).toContain("extra: unknown top-level key (contract v1 does not have it)");
  });

  it("refuses a typo'd entity key rather than dropping it", () => {
    const json = clone();
    json.entities[0].daily_budgt = 2500;
    expect(errorsOf(json)).toContain("entities[0].daily_budgt: unknown key");
  });

  it("refuses Meta's money strings, and says how to fix them", () => {
    const json = clone();
    json.insights[0].spend = "LKR1,234.56";
    const [error] = errorsOf(json);
    expect(error).toMatch(/^insights\[0\]\.spend: expected a number/);
    expect(error).toContain("1234.56");
  });

  it("refuses negative numbers and fractional counts", () => {
    const json = clone();
    json.insights[0].spend = -1;
    json.insights[1].impressions = 10.5;
    json.entities[0].daily_budget = -5;
    const errors = errorsOf(json);
    expect(errors).toContain("insights[0].spend: must not be negative");
    expect(errors).toContain("insights[1].impressions: expected a whole number");
    expect(errors).toContain("entities[0].daily_budget: must not be negative");
  });

  it("refuses ids that are not digit strings", () => {
    const json = clone();
    json.entities[0].id = 120244355299530395; // a number loses precision past 2^53
    json.insights[0].id = "abc";
    const errors = errorsOf(json);
    expect(errors.some((e) => e.startsWith("entities[0].id"))).toBe(true);
    expect(errors.some((e) => e.startsWith("insights[0].id"))).toBe(true);
  });

  it("accepts an act_ prefix on the account and strips it", () => {
    const json = clone();
    json.ad_account_id = "act_1148854332990641";
    expect(validatePayload(json).payload.ad_account_id).toBe("1148854332990641");
  });

  it("refuses bad dates, a reversed window and rows outside it", () => {
    const bad = clone();
    bad.window = { start: "2026-02-30", end: "2026-09-13" };
    expect(errorsOf(bad)).toContain("window.start: expected a real date YYYY-MM-DD");

    const reversed = clone();
    reversed.window = { start: "2026-09-14", end: "2026-09-12" };
    expect(errorsOf(reversed)).toContain("window: start is after end");

    const outside = clone();
    outside.insights[0].date = "2026-09-20";
    expect(errorsOf(outside)[0]).toMatch(/outside the window/);
  });

  it("refuses a timestamp with no offset", () => {
    const json = clone();
    json.entities[0].start_time = "2026-09-12T19:10:00";
    expect(errorsOf(json)[0]).toMatch(/^entities\[0\]\.start_time/);
  });

  it("refuses an ad with no campaign to hang it on", () => {
    const json = clone();
    delete json.entities[2].campaign_id;
    expect(errorsOf(json)).toContain("entities[2].campaign_id: required for an ad");
  });

  it("refuses an ad insight whose campaign it cannot work out", () => {
    const json = clone();
    json.entities = [];
    const errors = errorsOf(json);
    expect(errors.some((e) => e.startsWith("insights[2].campaign_id: required"))).toBe(true);
    // Campaign rows need nothing: the id is the campaign.
    expect(errors.some((e) => e.startsWith("insights[0]"))).toBe(false);
  });

  it("refuses duplicates", () => {
    const json = clone();
    json.entities.push({ ...json.entities[0] });
    json.insights.push({ ...json.insights[0] });
    const errors = errorsOf(json);
    expect(errors.some((e) => e.includes("duplicate id"))).toBe(true);
    expect(errors.some((e) => e.includes("duplicate row"))).toBe(true);
  });

  it("caps the insight array", () => {
    const json = clone();
    json.insights = Array.from({ length: MAX_INSIGHTS + 1 }, () => json.insights[0]);
    expect(errorsOf(json)[0]).toMatch(/^insights: too many/);
  });

  it("checks the notes", () => {
    const json = clone();
    json.notes = { health: "great", recommendations: "do more", mood: "ok" };
    const errors = errorsOf(json);
    expect(errors).toContain("notes.mood: unknown key");
    expect(errors).toContain("notes.health: expected one of good, watch, act");
    expect(errors).toContain("notes.recommendations: expected an array of strings");
  });

  it("collects every error in one pass", () => {
    const json = clone();
    json.version = 2;
    json.currency = "rupees";
    expect(errorsOf(json).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses something that is not an object at all", () => {
    expect(validatePayload(null).ok).toBe(false);
    expect(validatePayload([]).ok).toBe(false);
  });
});

describe("mapping to rows", () => {
  const { payload } = validatePayload(clone());

  it("leaves a key the payload omitted out of the entity row", () => {
    const [campaign, adset] = toEntityRows(payload);
    expect(campaign).not.toHaveProperty("creative");
    expect(campaign).not.toHaveProperty("targeting");
    expect(campaign.daily_budget).toBe(2500);
    expect(adset.targeting.age_min).toBe(30);
    expect(campaign.ad_account_id).toBe("1148854332990641");
    expect(campaign.currency).toBe("LKR");
  });

  it("writes an explicit null through (that is how a field is cleared)", () => {
    const json = clone();
    json.entities[0].lifetime_budget = null;
    const [campaign] = toEntityRows(validatePayload(json).payload);
    expect(campaign.lifetime_budget).toBeNull();
  });

  it("gives every insight row every column — a missing count is zero", () => {
    const rows = toInsightRows(payload);
    const shapes = new Set(rows.map((r) => Object.keys(r).sort().join(",")));
    expect(shapes.size).toBe(1);
    const adRow = rows.find((r) => r.level === "ad");
    expect(adRow.frequency).toBeNull();
    expect(adRow.entity_id).toBe("120244355303630395");
  });

  it("batches rows by shape so PostgREST never NULLs an omitted column", () => {
    const batches = batchByShape(toEntityRows(payload));
    for (const batch of batches) {
      const shapes = new Set(batch.map((r) => Object.keys(r).sort().join(",")));
      expect(shapes.size).toBe(1);
    }
    expect(batches.flat()).toHaveLength(payload.entities.length);
    expect(batchByShape(Array.from({ length: 5 }, (_, i) => ({ i })), 2).map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it("records the sync with the analyst's notes", () => {
    const row = toSyncRow(payload, { entities: 4, insights: 6 });
    expect(row).toMatchObject({
      source: "claude",
      ad_account_id: "1148854332990641",
      window_start: "2026-09-12",
      window_end: "2026-09-13",
      entities_upserted: 4,
      insights_upserted: 6,
      health: "watch",
      // When the numbers were read — not the row's created_at.
      synced_at: "2026-09-13T15:30:00.000Z",
    });
    expect(row.recommendations).toHaveLength(2);
  });

  it("records a sync with no notes as empty, not missing", () => {
    const json = clone();
    delete json.notes;
    const row = toSyncRow(validatePayload(json).payload, { entities: 0, insights: 0 });
    expect(row).toMatchObject({ summary: null, health: null, recommendations: [] });
  });

  it("describes the plan with the campaign's spend", () => {
    const plan = describePlan(payload).join("\n");
    expect(plan).toContain("LKR 2,812.5 spent, 6 conversations");
    expect(plan).toContain("4 (1 campaign, 1 adset, 2 ad)");
  });
});

describe("write guards", () => {
  const fixturesDir = "/repo/scripts/fixtures";
  const { payload } = validatePayload(clone());

  it("refuses a synced_at from the future — it would block every real sync after it", () => {
    const now = new Date("2026-09-13T16:00:00Z");
    expect(futureStampReason("2027-09-13T15:30:00.000Z", now)).toMatch(/is in the future/);
    // A few minutes of clock skew is fine.
    expect(futureStampReason("2026-09-13T16:05:00.000Z", now)).toBeNull();
    expect(futureStampReason("2026-09-13T15:00:00.000Z", now)).toBeNull();
    // It is a write guard, not a contract rule: the payload itself still validates.
    expect(validatePayload({ ...clone(), synced_at: "2027-01-01T00:00:00Z" }).ok).toBe(true);
  });

  it("refuses the fixture by path, wherever it is run from", () => {
    const clean = { ...payload, notes: null };
    expect(sampleReason(clean, { filePath: "/repo/scripts/fixtures/ads-sync-sample.json", fixturesDir })).toMatch(/scripts\/fixtures/);
    expect(sampleReason(clean, { filePath: "/repo/Scripts/Fixtures/copy.json", fixturesDir })).toMatch(/scripts\/fixtures/);
    expect(sampleReason(clean, { filePath: "/tmp/scratch/ads-sync-2026-09-14.json", fixturesDir })).toBeNull();
    // A sibling folder that merely starts with the same name is not the fixtures folder.
    expect(sampleReason(clean, { filePath: "/repo/scripts/fixtures-old/x.json", fixturesDir })).toBeNull();
  });

  it("refuses the fixture by its SAMPLE DATA marker, even copied elsewhere", () => {
    // The committed fixture carries the marker — pin it, so the guard keeps working.
    expect(payload.notes.summary.startsWith("SAMPLE DATA")).toBe(true);
    expect(sampleReason(payload, { filePath: "/tmp/copied.json", fixturesDir })).toMatch(/SAMPLE DATA/);
  });

  it("refuses a payload read before what is stored, allows the same or newer", () => {
    const stored = "2026-09-14T09:00:00+00:00";
    expect(staleWriteReason("2026-09-13T15:30:00.000Z", stored)).toMatch(/roll them back/);
    expect(staleWriteReason("2026-09-14T09:00:00.000Z", stored)).toBeNull();
    expect(staleWriteReason("2026-09-15T09:00:00.000Z", stored)).toBeNull();
    expect(staleWriteReason("2026-09-13T15:30:00.000Z", null)).toBeNull();
  });

  it("takes the latest stored stamp across tables", () => {
    expect(latestTimestamp(["2026-09-13T10:00:00+00:00", undefined, "2026-09-14T10:00:00+00:00", "junk"])).toBe(
      "2026-09-14T10:00:00+00:00",
    );
    expect(latestTimestamp([])).toBeNull();
  });
});

describe("parseArgs", () => {
  it("reads the two supported forms", () => {
    expect(parseArgs(["p.json", "--dry-run"])).toEqual({ ok: true, help: false, dryRun: true, file: "p.json" });
    expect(parseArgs(["--dry-run", "p.json"])).toMatchObject({ ok: true, dryRun: true, file: "p.json" });
    expect(parseArgs(["p.json"])).toEqual({ ok: true, help: false, dryRun: false, file: "p.json" });
    expect(parseArgs(["--help"])).toMatchObject({ ok: true, help: true });
  });

  it("stops on every mistyped dry-run instead of writing for real", () => {
    for (const typo of ["-dry-run", "—dry-run", "–dry-run", "−dry-run", "--dryrun", "--dry_run", "dry-run", "DRY-RUN", "dryrun"]) {
      const result = parseArgs(["p.json", typo]);
      expect(result.ok, typo).toBe(false);
    }
  });

  it("stops on a stray second file and on a missing one", () => {
    expect(parseArgs(["a.json", "b.json"])).toMatchObject({ ok: false });
    expect(parseArgs([])).toMatchObject({ ok: false, error: "missing the payload file" });
    expect(parseArgs(["--dry-run"])).toMatchObject({ ok: false });
  });
});

describe("helpers", () => {
  it("isDay only accepts real days", () => {
    expect(isDay("2026-09-12")).toBe(true);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("12/09/2026")).toBe(false);
  });

  it("toIsoTimestamp accepts Z, +05:30 and +0530, and nothing ambiguous", () => {
    expect(toIsoTimestamp("2026-09-12T13:40:00Z")).toBe("2026-09-12T13:40:00.000Z");
    expect(toIsoTimestamp("2026-09-12T19:10:00+05:30")).toBe("2026-09-12T13:40:00.000Z");
    expect(toIsoTimestamp("2026-09-12T19:10:00+0530")).toBe("2026-09-12T13:40:00.000Z");
    expect(toIsoTimestamp("2026-09-12T19:10:00")).toBeNull();
    expect(toIsoTimestamp("2026-09-12")).toBeNull();
    expect(toIsoTimestamp(1757684400)).toBeNull();
  });

  it("classifies PostgREST failures so a missing migration reads as one", () => {
    expect(classifyRestError({ status: 404, code: "PGRST205", message: "Could not find the table 'public.meta_ad_syncs' in the schema cache" })).toBe("missing_table");
    expect(classifyRestError({ status: 404, code: "42P01", message: "relation \"meta_ad_syncs\" does not exist" })).toBe("missing_table");
    expect(classifyRestError({ status: 400, code: "PGRST204", message: "Could not find the 'raw' column" })).toBe("missing_column");
    expect(classifyRestError({ status: 401, code: undefined, message: "Invalid API key" })).toBe("auth");
    expect(classifyRestError({ status: 409, code: "23505", message: "duplicate" })).toBe("other");
  });

  it("parseDotEnv reads the shapes .env files come in", () => {
    const env = parseDotEnv(
      [
        "# comment",
        "NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co",
        'SUPABASE_SERVICE_ROLE_KEY="quoted value"',
        "export FOO='single'",
        "BAR=plain # trailing comment",
        "",
        "not a line",
      ].join("\n"),
    );
    expect(env).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "quoted value",
      FOO: "single",
      BAR: "plain",
    });
  });
});
