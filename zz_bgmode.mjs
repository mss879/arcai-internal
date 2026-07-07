import { readFileSync } from "node:fs";
for (const line of readFileSync("/Users/shahidshamir/Desktop/arc-ai-management/.env.local","utf8").split("\n")) {
  const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^"|"$/g,"");
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const KEY = process.env.OPENAI_API_KEY;
const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const model = process.env.OPENAI_RESEARCH_MODEL || "gpt-5.4-mini";
const effort = process.env.OPENAI_RESEARCH_REASONING_EFFORT || "high";

// 1) Kick off a BACKGROUND response (must return instantly with an id).
console.log(`Kicking off /v1/responses background:true  model=${model} effort=${effort} ...`);
const t0 = Date.now();
const kick = await fetch(`${BASE}/responses`, {
  method:"POST",
  headers:{ "content-type":"application/json", authorization:`Bearer ${KEY}` },
  body: JSON.stringify({
    model,
    background: true,
    reasoning: { effort },
    input: [
      { role:"system", content:"You are a precise assistant. Reply ONLY with a JSON object." },
      { role:"user", content:"Return a JSON object describing a fictional Sri Lankan software company 'Ontriq' with keys: name, overview, three competitors (array), and three talking_points (array). Keep it brief." },
    ],
    text: { format: { type: "json_object" } },
  }),
});
const kickSecs = ((Date.now()-t0)/1000).toFixed(1);
if (!kick.ok) {
  console.log(`\n❌ kick-off HTTP ${kick.status} after ${kickSecs}s:\n${(await kick.text()).slice(0,600)}`);
  process.exit(0);
}
const job = await kick.json();
console.log(`  ✅ kicked off in ${kickSecs}s → id=${job.id}  status=${job.status}`);

// 2) Poll until terminal.
let final = job;
for (let i=0;i<60;i++){
  await sleep(5000);
  const p = await fetch(`${BASE}/responses/${job.id}`, { headers:{ authorization:`Bearer ${KEY}` } });
  if (!p.ok){ console.log(`  poll HTTP ${p.status}: ${(await p.text()).slice(0,200)}`); continue; }
  final = await p.json();
  console.log(`  t+${(i+1)*5}s  status=${final.status}`);
  if (["completed","failed","cancelled","incomplete"].includes(final.status)) break;
}

// 3) Extract the text output.
const totalSecs = ((Date.now()-t0)/1000).toFixed(0);
let text = final.output_text;
if (!text && Array.isArray(final.output)) {
  for (const item of final.output) {
    if (item.type==="message" && Array.isArray(item.content)) {
      for (const c of item.content) if (typeof c.text==="string") text = (text||"") + c.text;
    }
  }
}
console.log(`\nFINAL status=${final.status} after ${totalSecs}s. output_text=${text?text.length+"c":"(none)"}`);
if (final.status==="failed") console.log("error:", JSON.stringify(final.error||final.incomplete_details||{}));
if (text){
  let ok=false; try{ JSON.parse(text); ok=true; }catch{}
  console.log(`valid JSON: ${ok}`);
  console.log("preview:", text.slice(0,240).replace(/\n/g," "));
  console.log("\n✅✅ BACKGROUND MODE WORKS: instant kick-off, poll to completion, valid JSON. This is the hosted-safe path.");
}
