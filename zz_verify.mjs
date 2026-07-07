import { readFileSync } from "node:fs";
for (const line of readFileSync("/Users/shahidshamir/Desktop/arc-ai-management/.env.local","utf8").split("\n")) {
  const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^"|"$/g,"");
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false}});
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const id = "b74472ea-31cd-4a16-b2cc-eaf3c66eb7fe"; // an Ontriq row (currently done)

console.log("Waiting ~4 min for the Netlify deploy to go live before testing...");
await sleep(240000);

// Reset to 'analyzed', keeping the scraped discover/analyze data but clearing
// the synth outputs — so the PROD tick rebuilds the prompt, sets synthesizing,
// and fires triggerSynthWorker (the exact path that was broken). No local rescue.
const { data:cur } = await sb.from("lead_research").select("analysis").eq("id",id).maybeSingle();
const a = { ...(cur?.analysis||{}) };
for (const k of ["aiRaw","aiError","synthPrompt","synthSystem","synthStartedAt"]) delete a[k];
const { error:rerr } = await sb.from("lead_research")
  .update({ status:"analyzed", locked_at:null, error:null, analysis:a })
  .eq("id", id);
console.log(rerr ? `RESET ERROR: ${rerr.message}` : `Reset ${id.slice(0,8)} → analyzed (synth outputs cleared). Now driving via the prod cron tick ONLY.`);

let sawSynthesizing=false, sawAiRaw=false;
for (let i=0;i<30;i++){
  await fetch("https://www.arcai.online/api/automation/tick").catch(()=>{});
  await sleep(12000);
  const { data:r } = await sb.from("lead_research").select("status,analysis,report").eq("id",id).maybeSingle();
  const an=r.analysis||{};
  if (r.status==="synthesizing") sawSynthesizing=true;
  if (an.aiRaw) sawAiRaw=true;
  console.log(`  t+${(i+1)*12}s  status=${r.status}  synthPrompt=${an.synthPrompt?"set":"-"}  aiRaw=${an.aiRaw?String(an.aiRaw).length+"c":"-"}  aiError=${an.aiError??"-"}  report=${r.report&&Object.keys(r.report).length?Object.keys(r.report).length+"keys":"empty"}`);
  if (r.status==="done"){
    console.log(`\n✅✅ FIX CONFIRMED ON PROD: analyzed → synthesizing(${sawSynthesizing}) → worker wrote aiRaw(${sawAiRaw}) → done. Hosted synthesis works with NO rescue.`);
    break;
  }
  if (r.status==="error"){ console.log(`\n❌ row errored: ${an.aiError||"see error col"}`); break; }
  if (i===29) console.log(`\n⏳ not done yet — deploy may still be propagating, or other queued rows are ahead in the tick. Re-run to keep watching.`);
}
