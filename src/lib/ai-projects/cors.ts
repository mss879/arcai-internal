import "server-only";

import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

import { isCrmOrigin, originAllowed, requestOrigin } from "./origin-core";
import { isPublicKey, loadByKey, type AiProjectWithClient } from "./projects";
import type { ToolDef } from "./tool-core";
import type { AiErrorCode } from "./stream-core";

/**
 * The gate in front of every /api/ai route (0126).
 *
 * A request carries the project's public key in `?p=` and the browser's
 * `Origin`. The key finds the project; the origin must be on its allow-list
 * (or be the CRM's own, which is how the Deploy tab previews). Only a
 * matching origin is ever echoed in `Access-Control-Allow-Origin`; a foreign
 * one gets a response the browser will not let its script read.
 */

export function crmOrigin(): string | null {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || null;
}

export function corsHeaders(origin: string | null, methods = "GET, POST, OPTIONS"): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export type Gate =
  | {
      ok: true;
      project: AiProjectWithClient;
      /** 0127 — the project's enabled custom tools, loaded in the same read. */
      tools: ToolDef[];
      origin: string;
      /** The request came from the CRM itself — the Deploy tab's preview. */
      preview: boolean;
      /** Active, or previewed from the CRM. */
      enabled: boolean;
      headers: Record<string, string>;
    }
  | { ok: false; status: number; code: AiErrorCode; error: string; headers: Record<string, string> };

export async function gateRequest(request: Request, methods?: string): Promise<Gate> {
  const url = new URL(request.url);
  const key = url.searchParams.get("p") ?? "";
  const origin = requestOrigin(request.headers.get("origin"), request.headers.get("referer"));
  const bare = corsHeaders(null, methods);

  if (!isPublicKey(key)) return { ok: false, status: 404, code: "forbidden", error: "Unknown project.", headers: bare };
  if (!origin) return { ok: false, status: 403, code: "forbidden", error: "This request must come from a website.", headers: bare };

  const loaded = await loadByKey(createAdminClient(), key);
  const project = loaded?.project ?? null;
  if (!project || project.status === "archived") {
    return { ok: false, status: 404, code: "forbidden", error: "Unknown project.", headers: bare };
  }
  const crm = crmOrigin();
  if (!originAllowed(origin, project.allowed_origins ?? [], crm)) {
    return { ok: false, status: 403, code: "forbidden", error: "This website is not allowed to use this assistant.", headers: bare };
  }
  const preview = isCrmOrigin(origin, crm);
  const enabled = project.status === "active" || preview;
  return { ok: true, project, tools: loaded?.tools ?? [], origin, preview, enabled, headers: corsHeaders(origin, methods) };
}

/** A JSON reply with the gate's CORS headers. */
export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): NextResponse {
  return NextResponse.json(body, { status: init.status ?? 200, headers: init.headers ?? {} });
}

/** The preflight: 204, echoing the origin only when the project allows it. */
export async function preflight(request: Request, methods: string): Promise<NextResponse> {
  const gate = await gateRequest(request, methods);
  return new NextResponse(null, { status: 204, headers: gate.headers });
}
