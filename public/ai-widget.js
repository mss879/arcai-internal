/*! ARC AI website assistant — served by the CRM, dropped on a client's site as
    <script src="https://<crm>/ai-widget.js" data-project="pk_…" async></script>
    Vanilla JS, Shadow DOM, no dependencies. Talks to /api/ai/* on the host it
    was loaded from. Keep this file dependency-free and under ~15 KB. */
(function () {
  "use strict";
  var WIDGET_VERSION = "1.0.0";
  var script = document.currentScript;
  if (!script || window.__arcAiWidget) return;
  var KEY = script.getAttribute("data-project") || "";
  if (!/^pk_[A-Za-z0-9]{24}$/.test(KEY)) return;
  var PREVIEW = script.getAttribute("data-preview") === "1";
  var AUTO_OPEN = script.getAttribute("data-open") === "1";
  var BASE;
  try { BASE = new URL(script.src).origin; } catch (e) { return; }
  var API = BASE + "/api/ai";
  window.__arcAiWidget = { version: WIDGET_VERSION };

  /* ---------- storage ---------- */
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function read(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function rand(len) {
    var out = "", chars = "abcdefghijklmnopqrstuvwxyz0123456789", a = new Uint8Array(len);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a); else for (var i = 0; i < len; i++) a[i] = Math.random() * 256;
    for (var j = 0; j < len; j++) out += chars[a[j] % chars.length];
    return out;
  }
  var visitor = read("arcai:v"); if (!visitor) { visitor = "v_" + rand(20); store("arcai:v", visitor); }
  var SESSION_IDLE_MS = 24 * 3600 * 1000;
  function sessionKey() {
    var s = read("arcai:s:" + KEY);
    if (!s || !s.key || Date.now() - (s.at || 0) > SESSION_IDLE_MS) { s = { key: "s_" + rand(24), at: Date.now() }; store("arcai:s:" + KEY, s); }
    return s.key;
  }
  function touchSession() { var s = read("arcai:s:" + KEY); if (s) { s.at = Date.now(); store("arcai:s:" + KEY, s); } }
  function newSession() { var s = { key: "s_" + rand(24), at: Date.now() }; store("arcai:s:" + KEY, s); return s.key; }
  var session = sessionKey();
  function tKey() { return "arcai:t:" + KEY + ":" + session; }
  var transcript = read(tKey()) || [];
  function saveTranscript() { store(tKey(), transcript.slice(-50)); }

  /* ---------- config ---------- */
  var cfg = null;
  function loadConfig(cb) {
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem("arcai:c:" + KEY) || "null"); } catch (e) {}
    if (cached && Date.now() - cached.at < 5 * 60000 && !PREVIEW) return cb(cached.cfg);
    fetch(API + "/config?p=" + encodeURIComponent(KEY), { credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) { if (c) { try { sessionStorage.setItem("arcai:c:" + KEY, JSON.stringify({ at: Date.now(), cfg: c })); } catch (e) {} } cb(c); })
      .catch(function () { cb(null); });
  }

  /* ---------- markdown-lite → DOM (never innerHTML with model text) ---------- */
  function inline(text, into) {
    var re = /(\*\*(.+?)\*\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|((?:https?:\/\/)[^\s<]+[^\s<.,;:!?)\]])/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) into.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2]) { var b = document.createElement("strong"); b.textContent = m[2]; into.appendChild(b); }
      else if (m[4]) { into.appendChild(link(m[5], m[4])); }
      else { into.appendChild(link(m[6], m[6].replace(/^https?:\/\//, ""))); }
      last = re.lastIndex;
    }
    if (last < text.length) into.appendChild(document.createTextNode(text.slice(last)));
  }
  function link(href, label) { var a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = label; return a; }
  function render(text, into) {
    while (into.firstChild) into.removeChild(into.firstChild);
    var lines = text.split("\n"), list = null, para = null;
    function closeList() { if (list) { into.appendChild(list); list = null; } }
    function closePara() { if (para) { into.appendChild(para); para = null; } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var bullet = line.match(/^\s*[-•*]\s+(.*)$/), head = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (bullet) { closePara(); if (!list) list = document.createElement("ul"); var li = document.createElement("li"); inline(bullet[1], li); list.appendChild(li); continue; }
      closeList();
      if (!line.trim()) { closePara(); continue; }
      if (head) { closePara(); var h = document.createElement("p"); var s = document.createElement("strong"); inline(head[1], s); h.appendChild(s); into.appendChild(h); continue; }
      if (!para) para = document.createElement("p"); else para.appendChild(document.createElement("br"));
      inline(line, para);
    }
    closeList(); closePara();
  }

  /* ---------- SSE parser (port of stream-core.createSseParser) ---------- */
  function sseParser() {
    var buffer = "";
    return function (chunk) {
      buffer += chunk; var out = [], idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        var frame = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
        frame.split("\n").forEach(function (l) { if (l.indexOf("data:") === 0) { var p = l.slice(5).trim(); if (p) { try { out.push(JSON.parse(p)); } catch (e) {} } } });
        idx = buffer.indexOf("\n\n");
      }
      return out;
    };
  }

  /* ---------- UI ---------- */
  var CSS = "\
:host{all:initial}*{box-sizing:border-box}\
.arc{position:fixed;bottom:20px;z-index:2147483000;font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased}\
.arc.right{right:20px}.arc.left{left:20px}\
.launch{width:56px;height:56px;border-radius:999px;border:0;cursor:pointer;background:var(--arc-primary);color:#fff;box-shadow:0 10px 30px rgba(15,23,42,.25);display:grid;place-items:center;overflow:hidden;padding:0;transition:transform .15s}.launch:hover{transform:scale(1.05)}.launch img{width:100%;height:100%;object-fit:cover}.launch svg{width:26px;height:26px}\
.panel{position:absolute;bottom:68px;width:380px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 100px);background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(15,23,42,.28);display:none;flex-direction:column;overflow:hidden}\
.arc.right .panel{right:0}.arc.left .panel{left:0}.arc.open .panel{display:flex}\
.head{display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--arc-primary);color:#fff}\
.head .av{width:36px;height:36px;border-radius:999px;background:rgba(255,255,255,.25);display:grid;place-items:center;overflow:hidden;flex:none}.head .av img{width:100%;height:100%;object-fit:cover}.head .av svg{width:20px;height:20px}\
.head .t{flex:1;min-width:0}.head .n{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.head .s{font-size:12px;opacity:.85;display:flex;align-items:center;gap:6px}.head .s i{width:7px;height:7px;border-radius:99px;background:#4ade80;display:inline-block}\
.head button{background:transparent;border:0;color:#fff;cursor:pointer;opacity:.85;padding:6px;border-radius:8px;font-size:12px}.head button:hover{opacity:1;background:rgba(255,255,255,.15)}\
.msgs{flex:1;overflow-y:auto;padding:14px;background:#f8fafc;display:flex;flex-direction:column;gap:10px}\
.m{max-width:86%;padding:9px 12px;border-radius:14px;white-space:normal;word-wrap:break-word;overflow-wrap:anywhere}.m p{margin:0}.m p+p{margin-top:6px}.m ul{margin:4px 0 0 18px;padding:0}.m a{color:inherit;text-decoration:underline}\
.m.u{align-self:flex-end;background:var(--arc-user);color:#fff;border-bottom-right-radius:4px}.m.a{align-self:flex-start;background:var(--arc-agent);color:#0f172a;border-bottom-left-radius:4px}\
.m.u a{color:#fff}.m.sys{align-self:center;background:transparent;color:#64748b;font-size:12px;text-align:center}\
.dots{display:inline-flex;gap:4px;padding:4px 0}.dots i{width:6px;height:6px;border-radius:99px;background:#94a3b8;animation:b 1s infinite}.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}@keyframes b{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-4px);opacity:1}}\
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px;background:#f8fafc}.chips button{border:1px solid #e2e8f0;background:#fff;border-radius:999px;padding:6px 11px;font-size:12px;cursor:pointer;color:#334155}.chips button:hover{border-color:var(--arc-primary);color:var(--arc-primary)}\
.act{display:inline-block;margin-top:6px;background:var(--arc-primary);color:#fff!important;text-decoration:none!important;padding:8px 12px;border-radius:10px;font-weight:600;font-size:13px}\
.foot{border-top:1px solid #e2e8f0;background:#fff}\
.row{display:flex;align-items:flex-end;gap:8px;padding:10px 12px}\
textarea{flex:1;resize:none;border:1px solid #e2e8f0;border-radius:12px;padding:9px 11px;font:inherit;max-height:110px;outline:none;background:#fff;color:#0f172a}textarea:focus{border-color:var(--arc-primary);box-shadow:0 0 0 3px rgba(0,0,0,.05)}\
.send{width:40px;height:40px;border:0;border-radius:12px;background:var(--arc-primary);color:#fff;cursor:pointer;display:grid;place-items:center;flex:none}.send:disabled{opacity:.5;cursor:default}.send svg{width:18px;height:18px}\
.brand{text-align:center;font-size:11px;color:#94a3b8;padding:0 0 8px}.brand a{color:#94a3b8;text-decoration:none}\
.lead{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:12px;align-self:stretch}.lead input{width:100%;border:1px solid #e2e8f0;border-radius:10px;padding:8px 10px;font:inherit;margin-top:6px}.lead button{margin-top:8px;width:100%;border:0;background:var(--arc-primary);color:#fff;border-radius:10px;padding:9px;font-weight:600;cursor:pointer}.lead p{margin:0;font-size:13px;color:#334155}\
@media (max-width:640px){.arc.open .panel{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;border-radius:0}.arc.open .launch{display:none}}\
@media (prefers-reduced-motion:reduce){.dots i{animation:none}}";

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/></svg>';
  var ICON_BOT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>';

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function mount(c) {
    cfg = c;
    var host = el("div"); host.id = "arc-ai-widget";
    var root = host.attachShadow({ mode: "open" });
    var style = el("style"); style.textContent = CSS; root.appendChild(style);
    var wrap = el("div", "arc " + (c.position === "left" ? "left" : "right"));
    wrap.style.setProperty("--arc-primary", c.primary_color || "#f97316");
    wrap.style.setProperty("--arc-user", c.user_bubble_color || c.primary_color || "#f97316");
    wrap.style.setProperty("--arc-agent", c.agent_bubble_color || "#e2e8f0");

    var launch = el("button", "launch"); launch.setAttribute("aria-label", "Open chat with " + (c.agent_name || "the assistant"));
    if (c.avatar_url) { var im = el("img"); im.src = c.avatar_url; im.alt = ""; launch.appendChild(im); } else launch.innerHTML = ICON_CHAT;

    var panel = el("div", "panel"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", c.agent_name || "Assistant");
    var head = el("div", "head");
    var av = el("div", "av"); if (c.avatar_url) { var im2 = el("img"); im2.src = c.avatar_url; im2.alt = ""; av.appendChild(im2); } else av.innerHTML = ICON_BOT;
    var t = el("div", "t"); t.appendChild(el("div", "n", c.agent_name || "Assistant"));
    var st = el("div", "s"); st.appendChild(el("i")); st.appendChild(document.createTextNode(c.business_name ? c.business_name : "Online")); t.appendChild(st);
    var reset = el("button", null, "New chat"); reset.title = "Start a new conversation";
    var close = el("button", null, "✕"); close.setAttribute("aria-label", "Close chat");
    head.appendChild(av); head.appendChild(t); head.appendChild(reset); head.appendChild(close);

    var msgs = el("div", "msgs"); msgs.setAttribute("aria-live", "polite");
    var chips = el("div", "chips");
    var foot = el("div", "foot"), row = el("div", "row");
    var input = el("textarea"); input.rows = 1; input.placeholder = "Type a message…"; input.setAttribute("aria-label", "Your message"); input.maxLength = 2000;
    var send = el("button", "send"); send.innerHTML = ICON_SEND; send.setAttribute("aria-label", "Send");
    row.appendChild(input); row.appendChild(send); foot.appendChild(row);
    if (c.show_branding !== false) { var br = el("div", "brand"); var ba = el("a", null, "Powered by ARC AI"); ba.href = "https://www.arcai.agency"; ba.target = "_blank"; ba.rel = "noopener"; br.appendChild(ba); foot.appendChild(br); }
    panel.appendChild(head); panel.appendChild(msgs); panel.appendChild(chips); panel.appendChild(foot);
    wrap.appendChild(panel); wrap.appendChild(launch); root.appendChild(wrap); document.body.appendChild(host);

    var busy = false;
    function bubble(role, text) {
      var m = el("div", "m " + (role === "user" ? "u" : role === "assistant" ? "a" : "sys"));
      if (role === "assistant") render(text, m); else m.textContent = text;
      msgs.appendChild(m); msgs.scrollTop = msgs.scrollHeight; return m;
    }
    function actionButton(into, label, href) { var a = el("a", "act", label); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; into.appendChild(a); msgs.scrollTop = msgs.scrollHeight; }
    function showChips() {
      while (chips.firstChild) chips.removeChild(chips.firstChild);
      if (transcript.length || !(c.suggested_questions || []).length) return;
      (c.suggested_questions || []).slice(0, 4).forEach(function (q) { var b = el("button", null, q); b.onclick = function () { ask(q); }; chips.appendChild(b); });
    }
    function restore() {
      while (msgs.firstChild) msgs.removeChild(msgs.firstChild);
      if (!transcript.length && c.welcome_message) bubble("assistant", c.welcome_message);
      transcript.forEach(function (m) { var b = bubble(m.role, m.text); if (m.booking) actionButton(b, "Book a time", m.booking); });
      showChips();
    }
    function leadForm(note) {
      if (!c.lead_capture) return;
      var f = el("div", "lead"); f.appendChild(el("p", null, note || "Leave your details and the team will get back to you."));
      var name = el("input"); name.placeholder = "Your name"; var email = el("input"); email.placeholder = "Email"; email.type = "email"; var phone = el("input"); phone.placeholder = "Phone"; var msg = el("input"); msg.placeholder = "What do you need?";
      var b = el("button", null, "Send my details");
      f.appendChild(name); f.appendChild(email); f.appendChild(phone); f.appendChild(msg); f.appendChild(b);
      b.onclick = function () {
        b.disabled = true;
        fetch(API + "/lead?p=" + encodeURIComponent(KEY), { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit",
          body: JSON.stringify({ session: session, name: name.value, email: email.value, phone: phone.value, message: msg.value, page: location.href, preview: PREVIEW }) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) { if (res.ok) { f.textContent = "Thanks — the team will be in touch."; } else { b.disabled = false; alert(res.j && res.j.error ? res.j.error : "Please check your details."); } })
          .catch(function () { b.disabled = false; });
      };
      msgs.appendChild(f); msgs.scrollTop = msgs.scrollHeight;
    }

    function ask(text) {
      text = (text || "").trim(); if (!text || busy) return;
      busy = true; send.disabled = true; input.value = ""; autosize();
      while (chips.firstChild) chips.removeChild(chips.firstChild);
      bubble("user", text); transcript.push({ role: "user", text: text }); saveTranscript(); touchSession();
      var reply = bubble("assistant", ""); var dots = el("span", "dots"); dots.innerHTML = "<i></i><i></i><i></i>"; reply.appendChild(dots);
      var got = "", booking = null, ended = false;
      function finish(final) {
        ended = true; busy = false; send.disabled = false;
        if (final != null) got = final;
        if (got) { render(got, reply); if (booking) actionButton(reply, "Book a time", booking); transcript.push({ role: "assistant", text: got, booking: booking }); saveTranscript(); }
        else if (reply.parentNode && !reply.childNodes.length) reply.parentNode.removeChild(reply);
        msgs.scrollTop = msgs.scrollHeight;
      }
      function fail(code, message) {
        if (reply.parentNode) reply.parentNode.removeChild(reply);
        bubble("sys", message || "Something went wrong. Please try again.");
        if (code === "busy" || code === "rate_limited" || code === "disabled") leadForm();
        if (code === "session_full") { session = newSession(); transcript = []; saveTranscript(); }
        busy = false; send.disabled = false; ended = true;
      }
      fetch(API + "/chat?p=" + encodeURIComponent(KEY), { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit",
        body: JSON.stringify({ session: session, visitor: visitor, message: text, page: { url: location.href, title: document.title, referrer: document.referrer || null }, preview: PREVIEW }) })
        .then(function (r) {
          if (!r.ok || !r.body) { return r.json().then(function (j) { fail(j && j.code, j && j.error); }, function () { fail("failed"); }); }
          var reader = r.body.getReader(), dec = new TextDecoder(), parse = sseParser();
          function pump() {
            return reader.read().then(function (res) {
              if (res.done) { if (!ended) finish(); return; }
              parse(dec.decode(res.value, { stream: true })).forEach(function (ev) {
                if (ended) return;
                if (ev.type === "delta") { if (dots.parentNode) dots.parentNode.removeChild(dots); got += ev.text; render(got, reply); msgs.scrollTop = msgs.scrollHeight; }
                else if (ev.type === "tool") { if (!got) { dots.textContent = ""; var s = el("em", null, ev.label); dots.appendChild(s); } }
                else if (ev.type === "action") { if (ev.kind === "booking" && ev.url) booking = ev.url; }
                else if (ev.type === "done") { finish(ev.reply || got); }
                else if (ev.type === "error") { fail(ev.code, ev.message); }
              });
              return pump();
            });
          }
          return pump();
        })
        .catch(function () { if (!ended) fail("failed"); });
    }

    function autosize() { input.style.height = "auto"; input.style.height = Math.min(110, input.scrollHeight) + "px"; }
    input.addEventListener("input", autosize);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input.value); } });
    send.onclick = function () { ask(input.value); };
    function open() { wrap.classList.add("open"); launch.setAttribute("aria-expanded", "true"); restore(); setTimeout(function () { input.focus(); msgs.scrollTop = msgs.scrollHeight; }, 50); }
    function shut() { wrap.classList.remove("open"); launch.setAttribute("aria-expanded", "false"); }
    launch.onclick = function () { wrap.classList.contains("open") ? shut() : open(); };
    close.onclick = shut;
    reset.onclick = function () { session = newSession(); transcript = []; saveTranscript(); restore(); input.focus(); };
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && wrap.classList.contains("open")) shut(); });
    window.arcAi = { open: open, close: shut, ask: function (q) { open(); ask(q); } };
    if (AUTO_OPEN) open();
  }

  function boot() { loadConfig(function (c) { if (c && c.enabled) mount(c); }); }
  if (document.body) boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
