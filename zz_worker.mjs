import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local","utf8").split("\n")) { const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2]; }
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false}});
const { data:rows } = await sb.from("lead_research").select("id,status,analysis").ilike("company_name","%Ceylon Tea%").order("updated_at",{ascending:false}).limit(1);
const row = rows[0]; const id=row.id;
console.log(`Ceylon row ${id}  status=${row.status}  synthPrompt=${row.analysis?.synthPrompt?"present":"MISSING"}`);
console.log("Directly invoking the prod worker with this real id (no secret, like local)...");
const res = await fetch("https://www.arcai.online/.netlify/functions/research-synthesize-background",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id}),signal:AbortSignal.timeout(25000)});
console.log("  worker responded:", res.status, "(202 = accepted, runs async)");
console.log("Watching for aiRaw (worker success) / aiError (worker recorded a failure)...");
const read=async()=>(await sb.from("lead_research").select("status,analysis,report").eq("id",id).maybeSingle()).data;
for(let i=0;i<12;i++){ await new Promise(r=>setTimeout(r,15000)); const r=await read(); const a=r.analysis||{};
  console.log(`  t+${(i+1)*15}s status=${r.status} aiRaw=${a.aiRaw?String(a.aiRaw).length+"c":"no"} aiError=${a.aiError??"-"}`);
  if(a.aiRaw){ console.log("\n✅ WORKER WORKS — wrote aiRaw. env is fine; the app just couldn't reach it (base-URL issue in triggerSynthWorker). Fixable."); break; }
  if(a.aiError){ console.log(`\n❌ WORKER RECORDED ERROR: ${a.aiError}`); break; }
  if(r.status==="done"){ console.log("\n🎉 DONE"); break; }
}
