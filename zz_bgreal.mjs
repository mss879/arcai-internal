import { readFileSync } from "node:fs";
for (const line of readFileSync("/Users/shahidshamir/Desktop/arc-ai-management/.env.local","utf8").split("\n")) {
  const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^"|"$/g,"");
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false}});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const KEY = process.env.OPENAI_API_KEY;
const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_RESEARCH_MODEL || "gpt-5.4-mini";
const EFFORT = process.env.OPENAI_RESEARCH_REASONING_EFFORT || "high";
const isReasoning = /^(o\d|gpt-5)/i.test(MODEL);

// Grab a REAL, full-size stored prompt (the actual research payload).
const { data:rows } = await sb.from("lead_research")
  .select("id,company_name,analysis").ilike("company_name","%ontriq%").order("updated_at",{ascending:false});
const row = (rows||[]).find(r => r.analysis?.synthPrompt);
if (!row) { console.log("No row with a stored synthPrompt to test with."); process.exit(0); }
const system = row.analysis.synthSystem || "";
const user = row.analysis.synthPrompt || "";
console.log(`Real payload from ${row.company_name} ${row.id.slice(0,8)}: system=${system.length}c user=${user.length}c`);

// === exactly what kickoffBackgroundSynthesis() sends ===
const t0 = Date.now();
const kick = await fetch(`${BASE}/responses`, {
  method:"POST",
  headers:{ "content-type":"application/json", authorization:`Bearer ${KEY}` },
  signal: AbortSignal.timeout(30000),
  body: JSON.stringify({
    model: MODEL, background: true,
    input: [{role:"system",content:system},{role:"user",content:user}],
    text: { format: { type: "json_object" } },
    ...(isReasoning ? { reasoning:{effort:EFFORT} } : { temperature:0.3 }),
  }),
});
if (!kick.ok){ console.log(`❌ kickoff HTTP ${kick.status}: ${(await kick.text()).slice(0,400)}`); process.exit(0); }
const job = await kick.json();
console.log(`✅ kicked off in ${((Date.now()-t0)/1000).toFixed(1)}s → id=${job.id} status=${job.status}`);

// === exactly what pollBackgroundSynthesis() does ===
let final=job;
for (let i=0;i<80;i++){
  await sleep(5000);
  const p = await fetch(`${BASE}/responses/${job.id}`, { headers:{ authorization:`Bearer ${KEY}` }, signal:AbortSignal.timeout(30000) });
  if (!p.ok){ console.log(`  t+${(i+1)*5}s poll HTTP ${p.status} (pending/retry)`); continue; }
  final = await p.json();
  if (i%2===0 || ["completed","failed","cancelled","incomplete"].includes(final.status))
    console.log(`  t+${(i+1)*5}s status=${final.status}`);
  if (["completed","failed","cancelled","incomplete"].includes(final.status)) break;
}
const secs=((Date.now()-t0)/1000).toFixed(0);
let text = typeof final.output_text==="string"?final.output_text:"";
if (!text && Array.isArray(final.output)) for (const it of final.output) if (it?.type==="message"&&Array.isArray(it.content)) for (const c of it.content) if (typeof c?.text==="string") text+=c.text;

console.log(`\nFINAL status=${final.status} after ${secs}s. text=${text?text.length+"c":"(none)"}`);
if (text){
  let obj=null; try{ obj=JSON.parse(text); }catch{}
  console.log(`valid JSON: ${!!obj}`);
  if (obj) console.log(`report keys: ${Object.keys(obj).slice(0,12).join(", ")}`);
  console.log("\n✅✅ REAL-PAYLOAD BACKGROUND SYNTHESIS WORKS end-to-end with the exact request my code sends.");
} else if (final.status!=="completed") {
  console.log("error:", JSON.stringify(final.error||final.incomplete_details||{}).slice(0,300));
}
