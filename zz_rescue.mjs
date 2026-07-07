import { readFileSync } from "node:fs";
for (const line of readFileSync("/Users/shahidshamir/Desktop/arc-ai-management/.env.local","utf8").split("\n")) {
  const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^"|"$/g,"");
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false}});

const model = process.env.OPENAI_RESEARCH_MODEL || "gpt-5.4-mini";
const effort = process.env.OPENAI_RESEARCH_REASONING_EFFORT || "high";
const isReasoning = /^(o\d|gpt-5)/i.test(model);

// All Ontriq rows still awaiting synthesis output.
const { data:rows } = await sb.from("lead_research")
  .select("id,company_name,status,analysis")
  .ilike("company_name","%ontriq%")
  .order("updated_at",{ascending:false});
const targets = (rows||[]).filter(r => {
  const a=r.analysis||{}; return a.synthPrompt && !a.aiRaw && r.status!=="done";
});
console.log(`Found ${targets.length} Ontriq row(s) needing synthesis output.`);

async function synth(row){
  const a=row.analysis||{};
  const t0=Date.now();
  try{
    const res = await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{ "content-type":"application/json", authorization:`Bearer ${process.env.OPENAI_API_KEY}` },
      signal:AbortSignal.timeout(12*60*1000),
      body:JSON.stringify({
        model,
        messages:[{role:"system",content:a.synthSystem||""},{role:"user",content:a.synthPrompt||""}],
        response_format:{type:"json_object"},
        ...(isReasoning?{reasoning_effort:effort}:{temperature:0.3}),
      }),
    });
    const secs=((Date.now()-t0)/1000).toFixed(0);
    if(!res.ok){ const b=(await res.text()).slice(0,200); console.log(`  [${row.id.slice(0,8)}] OpenAI ${res.status} after ${secs}s: ${b}`); return; }
    const json=await res.json();
    const content=json.choices?.[0]?.message?.content;
    if(!content){ console.log(`  [${row.id.slice(0,8)}] no content`); return; }
    // Merge aiRaw back so the prod tick's finalizeSynthesis assembles the report.
    const { data:cur } = await sb.from("lead_research").select("analysis").eq("id",row.id).maybeSingle();
    const merged = { ...(cur?.analysis||{}), aiRaw:content, aiError:null };
    const { error } = await sb.from("lead_research").update({ analysis: merged }).eq("id",row.id);
    console.log(`  [${row.id.slice(0,8)}] ✅ wrote aiRaw (${content.length}c) after ${secs}s ${error?("ERR:"+error.message):""}`);
  }catch(e){ console.log(`  [${row.id.slice(0,8)}] threw after ${((Date.now()-t0)/1000).toFixed(0)}s: ${e.message}`); }
}

await Promise.all(targets.map(synth));

// Nudge the prod tick a few times to finalize (each tick finalizes claimable rows).
console.log("\nNudging prod tick to finalize synthesizing rows → done...");
for(let i=0;i<8;i++){
  await fetch("https://www.arcai.online/api/automation/tick").catch(()=>{});
  await new Promise(r=>setTimeout(r,4000));
  const { data:now } = await sb.from("lead_research").select("id,status").ilike("company_name","%ontriq%");
  const summary=(now||[]).map(r=>`${r.id.slice(0,8)}:${r.status}`).join("  ");
  console.log(`  nudge ${i+1}: ${summary}`);
  if((now||[]).every(r=>r.status==="done"||r.status==="error")) { console.log("\n🎉 all Ontriq rows finalized."); break; }
}
