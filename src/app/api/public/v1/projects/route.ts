import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, DeliveryStage, ProjectStatus } from "@/lib/database.types";
import { balanceDue, settledAmount } from "@/lib/projects";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Open API — projects (BIG-3, 0099).
 *
 *   GET  /api/public/v1/projects        list projects
 *   GET  /api/public/v1/projects?id=…   one project, with its money broken out
 *   POST /api/public/v1/projects        create a project (fires automations)
 *
 * Header: `x-api-key: arc_…`  (or `Authorization: Bearer arc_…`)
 *
 * Same key infrastructure as the leads API. Two things it deliberately does
 * NOT expose, whatever the key:
 *
 *   • cost data — expenses, margin, the internal budget, the risk note. An
 *     API key is for integrating, not for exporting the P&L to a third party.
 *   • `share_token` — handing out portal links over an API is a way to leak
 *     access to a client's project without anyone noticing.
 */

/** Everything an integration may see. Additive-only from here. */
const PUBLIC_COLUMNS =
  "id, name, description, status, delivery_stage, delivery_stage_changed_at, service_type, currency, total_value, deposit_paid, start_date, due_date, created_at, updated_at, client_id, lead_id, quote_id";

async function authenticate(
  request: Request,
): Promise<{ supabase: SupabaseClient<Database> } | NextResponse> {
  const key =
    request.headers.get("x-api-key")?.trim() ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
    "";
  if (!key) {
    return NextResponse.json({ error: "Missing API key." }, { status: 401 });
  }
  const supabase = createAdminClient();
  const { data: apiKey } = await supabase
    .from("api_keys")
    .select("*")
    .eq("key", key)
    .eq("is_active", true)
    .maybeSingle();
  if (!apiKey) {
    return NextResponse.json({ error: "Invalid API key." }, { status: 401 });
  }
  await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", apiKey.id);
  return { supabase };
}

const STATUSES: ProjectStatus[] = [
  "planning",
  "active",
  "on_hold",
  "completed",
  "cancelled",
];
const STAGES: DeliveryStage[] = [
  "onboarding",
  "assets",
  "build",
  "review",
  "delivered",
  "aftercare",
];

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  // ---- One project, with the money broken out --------------------------
  if (id) {
    const { data, error } = await supabase
      .from("projects")
      .select(
        `${PUBLIC_COLUMNS}, client:clients(id, name, company), payments(id, amount, status, paid_at, method), company_payments(id, price_lkr, is_paid, created_at)`,
      )
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = data as any;
    const money = {
      total_value: p.total_value,
      deposit_paid: p.deposit_paid,
      payments: p.payments ?? [],
      company_payments: p.company_payments ?? [],
    };

    return NextResponse.json({
      ok: true,
      project: {
        ...serialise(p),
        client: p.client ?? null,
        // Through the same helpers the UI uses, so an integration can never
        // report a different "received" than the board does (invariant 1).
        received: settledAmount(money),
        balance: balanceDue(money),
        payments: (p.payments ?? []).map(
          (row: { id: string; amount: number; status: string; paid_at: string | null; method: string | null }) => ({
            id: row.id,
            amount: Number(row.amount),
            status: row.status,
            paid_at: row.paid_at,
            method: row.method,
          }),
        ),
      },
    });
  }

  // ---- The list ---------------------------------------------------------
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const status = url.searchParams.get("status");
  const stage = url.searchParams.get("stage");
  const clientId = url.searchParams.get("client_id");

  let q = supabase
    .from("projects")
    .select(`${PUBLIC_COLUMNS}, client:clients(id, name, company)`)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status && (STATUSES as string[]).includes(status))
    q = q.eq("status", status as ProjectStatus);
  if (stage && (STAGES as string[]).includes(stage))
    q = q.eq("delivery_stage", stage as DeliveryStage);
  if (clientId) q = q.eq("client_id", clientId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    projects: (data ?? []).map((p: any) => ({
      ...serialise(p),
      client: p.client ?? null,
    })),
  });
}

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "`name` is required." }, { status: 400 });
  }

  const status = String(body.status ?? "planning");
  if (!(STATUSES as string[]).includes(status)) {
    return NextResponse.json(
      { error: `\`status\` must be one of: ${STATUSES.join(", ")}.` },
      { status: 400 },
    );
  }

  const stage = body.delivery_stage ? String(body.delivery_stage) : null;
  if (stage && !(STAGES as string[]).includes(stage)) {
    return NextResponse.json(
      { error: `\`delivery_stage\` must be one of: ${STAGES.join(", ")}.` },
      { status: 400 },
    );
  }

  // A client_id that doesn't exist would fail on the foreign key with an
  // opaque Postgres error; say so plainly instead.
  const clientId = body.client_id ? String(body.client_id) : null;
  if (clientId) {
    const { data: client } = await supabase
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .maybeSingle();
    if (!client) {
      return NextResponse.json({ error: "No client with that id." }, { status: 400 });
    }
  }

  const { data: created, error } = await supabase
    .from("projects")
    .insert({
      name,
      description: body.description ? String(body.description) : null,
      client_id: clientId,
      // BIG-2 — an integration that knows the chain can record it.
      lead_id: body.lead_id ? String(body.lead_id) : null,
      quote_id: body.quote_id ? String(body.quote_id) : null,
      status: status as ProjectStatus,
      delivery_stage: stage as DeliveryStage | null,
      service_type: body.service_type ? String(body.service_type) : null,
      currency: body.currency ? String(body.currency) : "LKR",
      total_value:
        typeof body.total_value === "number" ? body.total_value : null,
      start_date: body.start_date ? String(body.start_date) : null,
      due_date: body.due_date ? String(body.due_date) : null,
      created_by: null,
    })
    .select(PUBLIC_COLUMNS)
    .single();

  if (error || !created) {
    return NextResponse.json(
      { error: error?.message ?? "Could not create the project." },
      { status: 500 },
    );
  }

  // The same trigger the form and the assistant fire (0096), so a project
  // created over the API runs the same kickoff flow as one created by hand.
  const { fireProjectCreated } = await import("@/lib/project-events");
  await fireProjectCreated(supabase, created.id, "team");

  return NextResponse.json(
    { ok: true, project: serialise(created) },
    { status: 201 },
  );
}

/** Never let a column added later leak by accident — allow-list on the way out. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialise(p: any) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    delivery_stage: p.delivery_stage,
    delivery_stage_changed_at: p.delivery_stage_changed_at,
    service_type: p.service_type,
    currency: p.currency,
    total_value: p.total_value === null ? null : Number(p.total_value),
    start_date: p.start_date,
    due_date: p.due_date,
    created_at: p.created_at,
    updated_at: p.updated_at,
    client_id: p.client_id,
    lead_id: p.lead_id,
    quote_id: p.quote_id,
  };
}
