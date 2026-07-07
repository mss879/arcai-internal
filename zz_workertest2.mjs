import { readFileSync } from "node:fs";
for (const line of readFileSync("/Users/shahidshamir/Desktop/arc-ai-management/.env.local","utf8").split("\n")) {
  const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^"|"$/g,"");
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false}});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const id = "b74472ea-31cd-4a16-b2cc-eaf3c66eb7fe";

// Exactly what the FIXED app now sends: id + creds in the body.
console.log("POSTing the DEPLOYED worker with creds in the body (mirrors the fixed app)...");
const res = await fetch("https://www.arcai.online/.netlify/functions/research-synthesize-background",{
  method:"POST", headers:{"content-type":"application/json"},
  body:JSON.stringify({
    id,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    openaiKey: process.env.OPENAI_API_KEY,
  }),
  signal:AbortSignal.timeout(25000),
});
console.log(`  worker HTTP: ${res.status} (202 = background accepted)`);

console.log("Watching for write-back (aiRaw = new worker code ran with body creds)...");
for (let i=0;i<12;i++){
  await sleep(15000);
  const { data:r } = await sb.from("lead_research").select("status,analysis").eq("id",id).maybeSingle();
  const a=r.analysis||{};
  console.log(`  t+${(i+1)*15}s  status=${r.status}  aiRaw=${a.aiRaw?String(a.aiRaw).length+"c":"-"}  aiError=${a.aiError??"-"}`);
  if (a.aiRaw){ console.log("\n✅ DEPLOYED WORKER WORKS with body creds — the worker fix is live. Any remaining hang is the app→worker trigger (base URL)."); break; }
  if (a.aiError){ console.log(`\n⚠️ worker wrote aiError (now observable, no longer silent): ${a.aiError}`); break; }
}
