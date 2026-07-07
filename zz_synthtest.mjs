import { readFileSync } from "node:fs";
for (const line of readFileSync("/Users/shahidshamir/Desktop/arc-ai-management/.env.local","utf8").split("\n")) {
  const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^"|"$/g,"");
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false}});

const id = "b74472ea-31cd-4a16-b2cc-eaf3c66eb7fe"; // oldest stuck Ontriq row
const { data:row } = await sb.from("lead_research").select("analysis").eq("id",id).maybeSingle();
const a = row.analysis || {};
const system = a.synthSystem || "";
const user = a.synthPrompt || "";
console.log(`Prompt loaded: system=${system.length}c  user=${user.length}c`);

const model = process.env.OPENAI_RESEARCH_MODEL || "gpt-5.4-mini";
const effort = process.env.OPENAI_RESEARCH_REASONING_EFFORT || "high";
const isReasoning = /^(o\d|gpt-5)/i.test(model);
console.log(`Calling OpenAI directly: model=${model}  reasoning=${isReasoning}  effort=${effort}  (same keys prod should use)`);

const t0 = Date.now();
try {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ "content-type":"application/json", authorization:`Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(12*60*1000),
    body: JSON.stringify({
      model,
      messages:[{role:"system",content:system},{role:"user",content:user}],
      response_format:{type:"json_object"},
      ...(isReasoning ? {reasoning_effort:effort} : {temperature:0.3}),
    }),
  });
  const secs = ((Date.now()-t0)/1000).toFixed(1);
  if (!res.ok) {
    const body = (await res.text()).slice(0,500);
    console.log(`\n>>> OpenAI returned HTTP ${res.status} after ${secs}s:\n${body}`);
    process.exit(0);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || "";
  console.log(`\n>>> OpenAI OK after ${secs}s. content=${content.length}c  usage=${JSON.stringify(json.usage||{})}`);
  let parsed=false; try { JSON.parse(content); parsed=true; } catch {}
  console.log(`    valid JSON: ${parsed}`);
  console.log(`    preview: ${content.slice(0,240).replace(/\n/g," ")}`);
} catch (e) {
  const secs = ((Date.now()-t0)/1000).toFixed(1);
  console.log(`\n>>> OpenAI threw after ${secs}s: ${e.name}: ${e.message}`);
}
