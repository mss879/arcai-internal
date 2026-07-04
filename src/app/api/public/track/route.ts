import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Website visitor intelligence.
 *
 *   GET  /api/public/track          → the embeddable JS snippet
 *   POST /api/public/track          → records one event
 *
 * Drop this on any site you manage:
 *   <script src="https://<app-host>/api/public/track" data-site="client-x" async></script>
 *
 * The snippet records pageviews, form starts, form abandons and form
 * submits into `visitor_events`, which powers the Website Visitors panel
 * on the AI & Intelligence page.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const js = `
(function () {
  var script = document.currentScript;
  var SITE = (script && script.getAttribute("data-site")) || "default";
  var API = "${origin}/api/public/track";
  var KEY = "_arc_sid";
  var sid = null;
  try {
    sid = localStorage.getItem(KEY);
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(KEY, sid);
    }
  } catch (e) { sid = "anon-" + Date.now().toString(36); }

  function send(kind, meta) {
    try {
      var body = JSON.stringify({
        site: SITE, session_id: sid, kind: kind,
        path: location.pathname, referrer: document.referrer || null,
        meta: meta || {}
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(API, new Blob([body], { type: "application/json" }));
      } else {
        fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true });
      }
    } catch (e) {}
  }

  send("pageview", {});

  var formsTouched = {};
  document.addEventListener("focusin", function (e) {
    var form = e.target && e.target.form;
    if (!form) return;
    var id = form.id || form.getAttribute("name") || "form";
    if (!formsTouched[id]) {
      formsTouched[id] = { started: Date.now(), submitted: false };
      send("form_start", { form_id: id });
    }
  });
  document.addEventListener("submit", function (e) {
    var form = e.target;
    var id = (form && (form.id || form.getAttribute("name"))) || "form";
    if (formsTouched[id]) formsTouched[id].submitted = true;
    send("form_submit", { form_id: id });
  }, true);
  window.addEventListener("pagehide", function () {
    for (var id in formsTouched) {
      if (!formsTouched[id].submitted) {
        send("form_abandon", {
          form_id: id,
          seconds: Math.round((Date.now() - formsTouched[id].started) / 1000)
        });
      }
    }
  });
})();`;

  return new NextResponse(js, {
    headers: {
      ...CORS,
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON." }, { status: 400, headers: CORS });
  }

  const kind = String(body.kind ?? "pageview");
  if (!["pageview", "form_start", "form_abandon", "form_submit", "click"].includes(kind)) {
    return NextResponse.json({ error: "Bad kind." }, { status: 400, headers: CORS });
  }

  try {
    const supabase = createAdminClient();
    await supabase.from("visitor_events").insert({
      site: String(body.site ?? "default").slice(0, 100),
      session_id: String(body.session_id ?? "anon").slice(0, 100),
      kind: kind as "pageview",
      path: String(body.path ?? "/").slice(0, 500),
      referrer: body.referrer ? String(body.referrer).slice(0, 500) : null,
      meta: (typeof body.meta === "object" && body.meta ? body.meta : {}) as Record<string, unknown>,
    });
    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Track failed." },
      { status: 500, headers: CORS },
    );
  }
}
