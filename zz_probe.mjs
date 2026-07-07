import { readFileSync } from "node:fs";
for (const line of readFileSync("/Users/shahidshamir/Desktop/arc-ai-management/.env.local","utf8").split("\n")) {
  const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^"|"$/g,"");
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false}});

// Oldest stuck Ontriq row (closest to stale/giveup — completing it is most useful)
const id = "b74472ea-31cd-4a16-b2cc-eaf3c66eb7fe";

const read = async () => (await sb.from("lead_research")
  .select("status,analysis,report").eq("id",id).maybeSingle()).data;

const before = await read();
console.log(`BEFORE: status=${before.status}  aiRaw=${before.analysis?.aiRaw?"present":"null"}  aiError=${before.analysis?.aiError??"null"}  synthPrompt=${before.analysis?.synthPrompt?String(before.analysis.synthPrompt).length+"c":"MISSING"}`);

console.log("\nDirectly POSTing the prod synth worker with this REAL id (bypasses the app's triggerSynthWorker)...");
const res = await fetch("https://www.arcai.online/.netlify/functions/research-synthesize-background",{
  method:"POST", headers:{"content-type":"application/json"},
  body:JSON.stringify({id}), signal:AbortSignal.timeout(25000)
});
console.log(`  worker HTTP response: ${res.status} (202 = background accepted, runs async)`);

console.log("\nWatching the row for the worker's write-back (aiRaw = success, aiError = recorded failure)...");
for (let i=0;i<16;i++){
  await new Promise(r=>setTimeout(r,15000));
  const r = await read(); const a=r.analysis||{};
  console.log(`  t+${(i+1)*15}s  status=${r.status}  aiRaw=${a.aiRaw?String(a.aiRaw).length+"c":"null"}  aiError=${a.aiError??"null"}  report=${r.report&&Object.keys(r.report).length?Object.keys(r.report).length+"keys":"empty"}`);
  if (a.aiRaw){ console.log("\n>>> WORKER WROTE aiRaw. The worker + its env (OpenAI/Supabase keys) WORK when invoked directly."); break; }
  if (a.aiError){ console.log(`\n>>> WORKER WROTE aiError: ${a.aiError}`); break; }
  if (r.status==="done"){ console.log("\n>>> ROW REACHED done."); break; }
}
