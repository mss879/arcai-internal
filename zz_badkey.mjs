import { readFileSync } from "node:fs";
for (const line of readFileSync("/Users/shahidshamir/Desktop/arc-ai-management/.env.local","utf8").split("\n")) {
  const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^"|"$/g,"");
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false}});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const id = "b74472ea-31cd-4a16-b2cc-eaf3c66eb7fe";

// Clear any aiRaw/aiError first so we can see a fresh write unambiguously.
const { data:cur } = await sb.from("lead_research").select("analysis").eq("id",id).maybeSingle();
const a = { ...(cur?.analysis||{}) }; delete a.aiRaw; delete a.aiError;
await sb.from("lead_research").update({ analysis:a }).eq("id",id);

console.log("POSTing DEPLOYED worker with a DELIBERATELY BAD openai key (fails in ~1s if the code runs)...");
const res = await fetch("https://www.arcai.online/.netlify/functions/research-synthesize-background",{
  method:"POST", headers:{"content-type":"application/json"},
  body:JSON.stringify({
    id,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    openaiKey: "sk-deliberately-invalid-key-for-probe",
  }),
  signal:AbortSignal.timeout(25000),
});
console.log(`  worker HTTP: ${res.status}`);

for (let i=0;i<12;i++){
  await sleep(10000);
  const { data:r } = await sb.from("lead_research").select("analysis").eq("id",id).maybeSingle();
  const an=r.analysis||{};
  console.log(`  t+${(i+1)*10}s  aiRaw=${an.aiRaw?"set":"-"}  aiError=${an.aiError?String(an.aiError).slice(0,90):"-"}`);
  if (an.aiError){ console.log("\n>>> FUNCTION EXECUTES + reaches OpenAI. So the good-key run is being KILLED by a timeout → the -background budget is NOT applying. That's the real bug."); break; }
  if (an.aiRaw){ console.log("\n>>> unexpected success"); break; }
  if (i===11) console.log("\n>>> STILL nothing even with a fast-failing bad key → the function body is NOT executing at all (bad/incomplete deploy, or background functions aren't running on this site).");
}
