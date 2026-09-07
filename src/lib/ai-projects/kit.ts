import type { ToolDef } from "./tool-core";

/**
 * The client kit (0127): the five files the agency pastes into a client's
 * Next.js repo to complete the link.
 *
 * Rendered per project with its real origin, key and tool names, so wiring a
 * new client up is copy, paste, fill in one TODO. The generated code
 * deliberately uses string concatenation rather than template literals —
 * these files are themselves built inside template literals, and one
 * unescaped backtick would be a bug the agency finds in a client's repo.
 */

export type KitFile = {
  /** Where it goes in the client's project. */
  path: string;
  language: "bash" | "ts" | "tsx";
  what: string;
  body: string;
};

export type KitInput = {
  crmOrigin: string;
  projectKey: string;
  /** Shown once, and only to an admin who is pasting it into a .env. */
  secret: string | null;
  readKey: string | null;
  webhookPath: string;
  agentName: string;
  tools: ToolDef[];
  /** When "endpoint", the kit includes the two calendar routes. */
  calendarProvider: "none" | "endpoint" | "cal_com";
  availabilityPath: string;
  bookPath: string;
  timezone: string;
};

const MISSING_SECRET = "<generate the shared secret on the Backend tab>";
const MISSING_KEY = "<generate the read key on the Backend tab>";

function envFile(input: KitInput): KitFile {
  return {
    path: ".env.local",
    language: "bash",
    what: "Three values. The last two are secrets: server-side only, never NEXT_PUBLIC_.",
    body: [
      "# ARC AI — the link to " + input.agentName + " (added by ARC AI)",
      "ARC_AI_BASE=" + input.crmOrigin,
      "ARC_AI_PROJECT=" + input.projectKey,
      "# Verifies that a lead or tool call really came from ARC.",
      "ARC_AI_SECRET=" + (input.secret ?? MISSING_SECRET),
      "# Reads this site's own leads back. Server-side only.",
      "ARC_AI_READ_KEY=" + (input.readKey ?? MISSING_KEY),
    ].join("\n"),
  };
}

function libFile(): KitFile {
  return {
    path: "lib/arc.ts",
    language: "ts",
    what: "Verifies ARC's signature, and reads this site's leads back. No dependencies.",
    body: [
      'import { createHmac, timingSafeEqual } from "node:crypto";',
      "",
      "/**",
      " * The ARC AI link. Two jobs:",
      " *   verifyArc()  — proves a request really came from ARC before you act on it",
      " *   arcGet()     — reads this site's own leads and conversations back",
      " *",
      " * Both are server-only. ARC_AI_SECRET and ARC_AI_READ_KEY must never be",
      " * exposed to the browser, so never prefix them with NEXT_PUBLIC_.",
      " */",
      "",
      "const WINDOW_SECONDS = 300;",
      "",
      "/**",
      " * Check the signature on an incoming ARC request.",
      " *",
      " * Pass the RAW body text, exactly as it arrived. Verify before you parse:",
      " * signing what your parser produced rather than what was sent is how a",
      " * signature check quietly stops meaning anything.",
      " */",
      "export function verifyArc(request: Request, rawBody: string): { ok: boolean; error?: string } {",
      '  const secret = process.env.ARC_AI_SECRET;',
      '  if (!secret) return { ok: false, error: "ARC_AI_SECRET is not set" };',
      "",
      '  const signature = request.headers.get("x-arc-signature") || "";',
      '  const timestamp = request.headers.get("x-arc-timestamp") || "";',
      '  if (!signature || !timestamp) return { ok: false, error: "missing signature headers" };',
      "",
      "  const sent = Number(timestamp);",
      '  if (!Number.isFinite(sent)) return { ok: false, error: "bad timestamp" };',
      "  if (Math.abs(Math.floor(Date.now() / 1000) - sent) > WINDOW_SECONDS) {",
      '    return { ok: false, error: "stale request" };',
      "  }",
      "",
      '  const expected = "v1=" + createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");',
      "  const a = Buffer.from(expected);",
      "  const b = Buffer.from(signature);",
      '  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "bad signature" };',
      "  return { ok: true };",
      "}",
      "",
      "/** The idempotency key on a write. The same request retried carries the",
      " *  same key, so store it and refuse a repeat. */",
      "export function arcIdempotencyKey(request: Request): string | null {",
      '  return request.headers.get("x-arc-idempotency-key");',
      "}",
      "",
      "export type ArcLead = {",
      "  id: string;",
      "  name: string | null;",
      "  email: string | null;",
      "  phone: string | null;",
      "  company: string | null;",
      "  interest: string | null;",
      "  page_url: string | null;",
      '  status: "new" | "contacted" | "archived";',
      "  conversation_id: string | null;",
      "  captured_at: string;",
      "};",
      "",
      "/** Read from ARC. Server-side only — the key must not reach a browser. */",
      "export async function arcGet<T>(path: string): Promise<T> {",
      '  const base = process.env.ARC_AI_BASE;',
      '  const key = process.env.ARC_AI_READ_KEY;',
      '  if (!base || !key) throw new Error("ARC_AI_BASE and ARC_AI_READ_KEY must be set");',
      "",
      '  const res = await fetch(base + "/api/ai/v1" + path, {',
      '    headers: { Authorization: "Bearer " + key },',
      '    cache: "no-store",',
      "  });",
      "  if (!res.ok) {",
      '    throw new Error("ARC read failed (" + res.status + "): " + (await res.text()).slice(0, 200));',
      "  }",
      "  return (await res.json()) as T;",
      "}",
      "",
      "/** Mark a lead contacted or archived from your own dashboard. */",
      'export async function arcSetLeadStatus(id: string, status: ArcLead["status"]): Promise<void> {',
      '  const base = process.env.ARC_AI_BASE;',
      '  const key = process.env.ARC_AI_READ_KEY;',
      '  if (!base || !key) throw new Error("ARC_AI_BASE and ARC_AI_READ_KEY must be set");',
      "",
      '  const res = await fetch(base + "/api/ai/v1/leads/" + id, {',
      '    method: "PATCH",',
      '    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },',
      "    body: JSON.stringify({ status }),",
      '    cache: "no-store",',
      "  });",
      '  if (!res.ok) throw new Error("Could not update that lead.");',
      "}",
    ].join("\n"),
  };
}

function leadRouteFile(input: KitInput): KitFile {
  return {
    path: "app" + input.webhookPath + "/route.ts",
    language: "ts",
    what: "Receives a captured lead. One TODO: put it wherever this business keeps leads.",
    body: [
      'import { arcIdempotencyKey, verifyArc } from "@/lib/arc";',
      "",
      "/**",
      " * A lead from the " + input.agentName + " assistant on this site.",
      " *",
      " * ARC posts here the moment a visitor leaves their details, and retries",
      " * for about nine hours if this endpoint is down — so a deploy in the",
      " * middle of the night loses nothing.",
      " */",
      "",
      'export const runtime = "nodejs";',
      'export const dynamic = "force-dynamic";',
      "",
      "type ArcLeadPayload = {",
      "  event: string;",
      "  test?: boolean;",
      "  lead_id: string | null;",
      "  conversation_id: string | null;",
      "  lead: {",
      "    name: string | null;",
      "    email: string | null;",
      "    phone: string | null;",
      "    company: string | null;",
      "    interest: string | null;",
      "    page_url: string | null;",
      "  } | null;",
      "  conversation: { started_at: string; messages: number; summary: string | null } | null;",
      "};",
      "",
      "export async function POST(request: Request) {",
      "  // Read the body as TEXT and verify it before parsing.",
      "  const raw = await request.text();",
      "  const check = verifyArc(request, raw);",
      "  if (!check.ok) {",
      "    return Response.json({ ok: false, error: check.error }, { status: 401 });",
      "  }",
      "",
      "  const payload = JSON.parse(raw) as ArcLeadPayload;",
      "",
      '  // The "Send test" button on ARC\'s Backend tab. Prove the link works',
      "  // without creating a fake lead.",
      "  if (payload.test) return Response.json({ ok: true, test: true });",
      "",
      "  // The same lead retried carries the same key. Store it and refuse a",
      "  // repeat, or you will have the same person in your CRM twice.",
      "  const key = arcIdempotencyKey(request);",
      "",
      "  // ─────────────────────────────────────────────────────────────────",
      "  // TODO — put the lead where this business keeps its leads.",
      "  //",
      "  //   await db.insert(leads).values({",
      "  //     arcId: payload.lead_id,",
      "  //     idempotencyKey: key,",
      "  //     name: payload.lead?.name,",
      "  //     email: payload.lead?.email,",
      "  //     phone: payload.lead?.phone,",
      "  //     note: payload.lead?.interest,",
      "  //     source: 'website assistant',",
      "  //   });",
      "  //",
      "  // Anything else belongs here too: email the owner, push to their CRM,",
      "  // send a WhatsApp. This endpoint is the one place it all hangs off.",
      "  // ─────────────────────────────────────────────────────────────────",
      "  console.log(",
      '    "[arc] lead",',
      "    payload.lead_id,",
      "    payload.lead?.name,",
      "    payload.lead?.email ?? payload.lead?.phone,",
      "    key,",
      "  );",
      "",
      "  // Answer 2xx or ARC will retry. Answer anything else and it will.",
      "  return Response.json({ ok: true });",
      "}",
    ].join("\n"),
  };
}

function toolsRouteFile(input: KitInput): KitFile {
  const cases: string[] = [];
  for (const tool of input.tools) {
    const fields = (tool.parameters ?? []).map((p) => p.name).join(", ") || "—";
    cases.push('    case "' + tool.name + '": {');
    cases.push("      // " + tool.description);
    cases.push("      // Arguments: " + fields);
    if (tool.kind === "write") {
      cases.push("      // This one WRITES. Check the idempotency key before acting:");
      cases.push("      // the same request retried must not create a second record.");
    }
    cases.push("      // TODO — do the real thing, then return what the agent should say.");
    cases.push('      return Response.json({ ok: true, result: { todo: "' + tool.name + ' is not implemented yet" } });');
    cases.push("    }");
  }
  if (!cases.length) {
    cases.push("    // No tools defined yet. Add one on ARC's Backend tab and this");
    cases.push("    // file will be regenerated with a case for it.");
  }

  return {
    path: "app/api/arc/tools/[tool]/route.ts",
    language: "ts",
    what: "Where the agent asks or acts. One case per tool defined on the project.",
    body: [
      'import { arcIdempotencyKey, verifyArc } from "@/lib/arc";',
      "",
      "/**",
      " * The " + input.agentName + " assistant, asking this site something or doing",
      " * something in it, mid-conversation.",
      " *",
      " * A visitor is waiting on the other end, so be quick: ARC gives up on a",
      " * tool after a few seconds and the agent apologises instead of answering.",
      " *",
      " * Answer shape:",
      " *   { ok: true, result: <anything JSON> }   the agent reads this and replies",
      " *   { ok: true, message: 'in words' }       the agent repeats this",
      " *   { ok: false, error: 'in words' }        the agent tells the visitor",
      " *",
      " * Whatever you return may be read aloud to a stranger on the internet.",
      " * Never put internal ids, prices you would not publish, or another",
      " * customer's details in it.",
      " */",
      "",
      'export const runtime = "nodejs";',
      'export const dynamic = "force-dynamic";',
      "",
      "export async function POST(request: Request, { params }: { params: Promise<{ tool: string }> }) {",
      "  const raw = await request.text();",
      "  const check = verifyArc(request, raw);",
      "  if (!check.ok) {",
      "    return Response.json({ ok: false, error: check.error }, { status: 401 });",
      "  }",
      "",
      "  const { tool } = await params;",
      "  const body = JSON.parse(raw) as { arguments: Record<string, unknown>; conversation_id: string };",
      "  const args = body.arguments || {};",
      "  const idempotencyKey = arcIdempotencyKey(request);",
      "  void args;",
      "  void idempotencyKey;",
      "",
      "  switch (tool) {",
      ...cases,
      "    default:",
      '      return Response.json({ ok: false, error: "Unknown tool." }, { status: 404 });',
      "  }",
      "}",
    ].join("\n"),
  };
}

function dashboardFile(input: KitInput): KitFile {
  return {
    path: "app/admin/leads/page.tsx",
    language: "tsx",
    what: "Their dashboard, on their site. Restyle it to the brand — the data is already theirs.",
    body: [
      'import { arcGet, type ArcLead } from "@/lib/arc";',
      "",
      "/**",
      " * Leads from the " + input.agentName + " assistant.",
      " *",
      " * A server component: the ARC read key stays on the server and never",
      " * reaches the browser. Put this behind whatever login this site already",
      " * has — ARC does not authenticate your staff, only your server.",
      " */",
      "",
      'export const dynamic = "force-dynamic";',
      "",
      "type Summary = {",
      "  totals: { conversations: number; messages: number; leads: number; handoffs: number };",
      "  range: { days: number };",
      "};",
      "",
      "export default async function LeadsPage() {",
      "  const [{ leads }, summary] = await Promise.all([",
      '    arcGet<{ leads: ArcLead[] }>("/leads?limit=100"),',
      '    arcGet<Summary>("/summary?days=30"),',
      "  ]);",
      "",
      "  return (",
      '    <main className="mx-auto max-w-4xl px-6 py-10">',
      '      <h1 className="text-2xl font-semibold tracking-tight">Website assistant</h1>',
      '      <p className="mt-1 text-sm text-gray-500">',
      "        The last {summary.range.days} days.",
      "      </p>",
      "",
      '      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">',
      "        {[",
      '          ["Conversations", summary.totals.conversations],',
      '          ["Messages", summary.totals.messages],',
      '          ["Leads", summary.totals.leads],',
      '          ["Asked for a person", summary.totals.handoffs],',
      "        ].map(([label, value]) => (",
      '          <div key={String(label)} className="rounded-xl border border-gray-200 p-4">',
      '            <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>',
      '            <dd className="mt-1 text-2xl font-semibold">{value}</dd>',
      "          </div>",
      "        ))}",
      "      </dl>",
      "",
      '      <div className="mt-8 overflow-hidden rounded-xl border border-gray-200">',
      '        <table className="w-full text-sm">',
      "          <thead>",
      '            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">',
      '              <th className="px-4 py-3">Who</th>',
      '              <th className="px-4 py-3">Wants</th>',
      '              <th className="px-4 py-3">When</th>',
      '              <th className="px-4 py-3">Status</th>',
      "            </tr>",
      "          </thead>",
      "          <tbody>",
      "            {leads.map((lead) => (",
      '              <tr key={lead.id} className="border-b border-gray-100 last:border-0">',
      '                <td className="px-4 py-3">',
      '                  <div className="font-medium">{lead.name ?? "—"}</div>',
      '                  <div className="text-xs text-gray-500">',
      '                    {[lead.email, lead.phone].filter(Boolean).join(" · ")}',
      "                  </div>",
      "                </td>",
      '                <td className="max-w-sm px-4 py-3 text-gray-600">{lead.interest ?? "—"}</td>',
      '                <td className="px-4 py-3 text-gray-500">',
      '                  {new Date(lead.captured_at).toLocaleDateString("en-GB", {',
      '                    day: "numeric",',
      '                    month: "short",',
      "                  })}",
      "                </td>",
      '                <td className="px-4 py-3">{lead.status}</td>',
      "              </tr>",
      "            ))}",
      "            {leads.length === 0 && (",
      "              <tr>",
      '                <td colSpan={4} className="px-4 py-10 text-center text-gray-500">',
      "                  No leads yet.",
      "                </td>",
      "              </tr>",
      "            )}",
      "          </tbody>",
      "        </table>",
      "      </div>",
      "    </main>",
      "  );",
      "}",
    ].join("\n"),
  };
}

function calendarFile(input: KitInput): KitFile {
  return {
    path: "app" + input.availabilityPath + "/route.ts  (+ " + input.bookPath + ")",
    language: "ts",
    what: "The two calendar routes. Their server talks to whatever diary the business actually uses.",
    body: [
      "// ─── app" + input.availabilityPath + "/route.ts ───────────────────",
      'import { verifyArc } from "@/lib/arc";',
      "",
      "/**",
      " * What is free on a date.",
      " *",
      " * The agent calls this before it offers any time, so whatever this",
      " * returns is what a stranger will be told is available. Times are in " + input.timezone + ".",
      " *",
      " * This is the right place for a Google or Outlook token: on the",
      " * business's own server, under their own control — not in the agency's",
      " * CRM. ARC never sees the calendar, only the free times you return.",
      " */",
      "",
      'export const runtime = "nodejs";',
      'export const dynamic = "force-dynamic";',
      "",
      "export async function POST(request: Request) {",
      "  const raw = await request.text();",
      "  const check = verifyArc(request, raw);",
      "  if (!check.ok) return Response.json({ ok: false, error: check.error }, { status: 401 });",
      "",
      "  const { arguments: args } = JSON.parse(raw) as { arguments: { date?: string } };",
      '  const date = String(args?.date || "");',
      "  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) {",
      '    return Response.json({ ok: false, error: "Ask for the date as YYYY-MM-DD." });',
      "  }",
      "",
      "  // TODO — ask the real diary. Google Calendar freeBusy, Outlook, or a",
      "  // bookings table in this site's own database.",
      '  const times = ["09:00", "10:30", "14:00", "15:30"];',
      "",
      "  return Response.json({",
      "    ok: true,",
      '    result: { date, free: times.length > 0, times, timezone: "' + input.timezone + '" },',
      "  });",
      "}",
      "",
      "",
      "// ─── app" + input.bookPath + "/route.ts ───────────────────────────",
      'import { arcIdempotencyKey, verifyArc } from "@/lib/arc";',
      "",
      "/**",
      " * Take the booking.",
      " *",
      " * ARC will only call this after the visitor has confirmed a specific",
      " * time out loud, but treat it as untrusted anyway: re-check the slot is",
      " * still free before you write it. Two visitors can agree to the same",
      " * time thirty seconds apart.",
      " */",
      "",
      "export async function POST(request: Request) {",
      "  const raw = await request.text();",
      "  const check = verifyArc(request, raw);",
      "  if (!check.ok) return Response.json({ ok: false, error: check.error }, { status: 401 });",
      "",
      "  const { arguments: args } = JSON.parse(raw) as {",
      "    arguments: { date?: string; time?: string; name?: string; email?: string; notes?: string };",
      "  };",
      "  // The same booking retried carries the same key. Store it and return",
      "  // the original result rather than booking twice.",
      "  const key = arcIdempotencyKey(request);",
      "",
      "  // TODO — re-check the slot, then write the booking and send whatever",
      "  // confirmation this business normally sends.",
      '  console.log("[arc] booking", key, args);',
      "",
      "  return Response.json({",
      "    ok: true,",
      "    result: { booked: true, date: args.date, time: args.time },",
      '    message: "Booked for " + args.date + " at " + args.time + ". A confirmation is on its way.",',
      "  });",
      "}",
    ].join("\n"),
  };
}

/** The whole kit, rendered for one project. */
export function buildKit(input: KitInput): KitFile[] {
  return [
    envFile(input),
    libFile(),
    leadRouteFile(input),
    toolsRouteFile(input),
    ...(input.calendarProvider === "endpoint" ? [calendarFile(input)] : []),
    dashboardFile(input),
  ];
}
