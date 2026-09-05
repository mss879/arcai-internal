import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { DELIVERY_STAGES } from "@/lib/constants";
import type { DeliveryStage } from "@/lib/types";

import { setProjectStage } from "@/app/(app)/projects/actions";
import { logTime } from "@/app/(app)/projects/plan-actions";

export const runtime = "nodejs";

/**
 * Replay what was done without signal (0119).
 *
 * The page (or the service worker's Background Sync) posts the outbox here
 * once the phone is back online. Every item goes through the SAME server
 * action the tap would have used on the spot — logTime and setProjectStage,
 * never a direct write — so the deposit gate and the launch checklist still
 * apply, and a stage move refused online is refused here with the same words.
 *
 * Items are independent: one refusal does not stop the rest, and the caller
 * drops only the ones acknowledged. Each item carries the client-minted id
 * it was queued under, so the caller can tell which ones to clear.
 */

type OutboxItem = {
  id: string;
  kind: "log_time" | "advance_stage";
  payload: Record<string, unknown>;
};

type ItemResult = { id: string; ok: boolean; error?: string };

const MAX_ITEMS = 50;

export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { items?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const items = (Array.isArray(body?.items) ? body.items : [])
    .filter(
      (i): i is OutboxItem =>
        !!i &&
        typeof i === "object" &&
        typeof (i as OutboxItem).id === "string" &&
        ((i as OutboxItem).kind === "log_time" || (i as OutboxItem).kind === "advance_stage") &&
        typeof (i as OutboxItem).payload === "object",
    )
    .slice(0, MAX_ITEMS);

  const results: ItemResult[] = [];
  for (const item of items) {
    try {
      results.push({ id: item.id, ...(await replay(item, profile.id)) });
    } catch (e) {
      results.push({
        id: item.id,
        ok: false,
        error: e instanceof Error ? e.message : "Failed to replay.",
      });
    }
  }

  return NextResponse.json({ ok: true, results }, { headers: { "Cache-Control": "no-store" } });
}

async function replay(
  item: OutboxItem,
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  const p = item.payload;
  const projectId = typeof p.project_id === "string" ? p.project_id : "";
  if (!projectId) return { ok: false, error: "No project on this item." };

  if (item.kind === "log_time") {
    const res = await logTime({
      project_id: projectId,
      minutes: Number(p.minutes),
      note: typeof p.note === "string" ? p.note : null,
      // The day the work was done, not the day the phone found signal.
      worked_on: typeof p.worked_on === "string" ? p.worked_on.slice(0, 10) : null,
      user_id: userId,
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  const stage = typeof p.stage === "string" ? p.stage : "";
  if (!(DELIVERY_STAGES as readonly string[]).includes(stage)) {
    return { ok: false, error: "Not a delivery stage." };
  }
  const res = await setProjectStage(projectId, stage as DeliveryStage);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
