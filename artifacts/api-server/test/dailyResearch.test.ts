import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runCycle, getFeed } from "../src/command/cycle";
import { sha } from "../src/command/engines";
import { compareInventory, researchDaily, validDailyRecord } from "../src/command/dailyResearch";
import { billingMonth, openStore } from "../src/command/store";
import { type Model } from "../src/command/genesis";
import { GetCommandFeedResponse } from "@workspace/api-zod";

const ok=(text='{"version":1,"method":"match-by-id"}')=>Response.json({
  candidates:[{finishReason:"STOP",content:{parts:[{text}]}}],
  usageMetadata:{promptTokenCount:100,candidatesTokenCount:10},
});
const free:Model={name:"gemini-free-fixture",key:"private-free-key",tier:"free",context:4000,inputMicrosPerMillion:0,outputMicrosPerMillion:0};
const paid:Model={name:"gemini-paid-fixture",key:"private-paid-key",tier:"paid",context:4000,inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000,billableOutputLimit:256};

test("billing month follows Pacific daylight and standard time boundaries",()=>{
  assert.equal(billingMonth(new Date("2026-03-01T07:59:59Z")),"2026-02");
  assert.equal(billingMonth(new Date("2026-03-01T08:00:00Z")),"2026-03");
  assert.equal(billingMonth(new Date("2026-04-01T06:59:59Z")),"2026-03");
  assert.equal(billingMonth(new Date("2026-04-01T07:00:00Z")),"2026-04");
  assert.equal(billingMonth(new Date("2026-12-01T08:00:00Z")),"2026-12");
});

test("production-like daily research needs explicit gates and scheduled work remains AI-free",async()=>{
  const f=await fixture();
  try {
    let calls=0;
    const request:typeof fetch=async(url)=>{
      calls++;
      return String(url).endsWith(":countTokens")?Response.json({totalTokens:100}):ok();
    };
    const options={kind:"daily-review",runId:"daily-2026-01-01",models:[free],ledger:f.store,env:f.env,request};
    const disabledEnv={...f.env,NODE_ENV:"production",COMMAND_ENABLE_GENESIS_AI:"0"};
    assert.equal((await researchDaily({...options,env:disabledEnv})).externalAiCalls,0);
    assert.equal(calls,0);
    const env={...f.env,NODE_ENV:"production",COMMAND_FREE_PROVIDER_KEY:free.key,
      COMMAND_FREE_MODEL_NAME:free.name,COMMAND_FREE_MODEL_CONTEXT:"4000"};
    const productionStore={...f.store,production:true};
    const run=await runCycle(productionStore,"daily-review",new Date(),async()=>"Source checked (HTTP 200)",{env,request});
    assert.equal(run?.learning.externalAiCalls,2);assert.equal(calls,2);
    const scheduled=await runCycle(productionStore,"scheduled",new Date(),async()=>"Source checked (HTTP 200)",{env,request});
    assert.equal(scheduled?.learning.externalAiCalls,0);assert.equal(calls,2);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),"daily-research-"));
  const text="\ufeffApproved fixture Ω\r\nfull trailing bytes \n";
  const path=join(dir,"seed");
  await writeFile(path,text);
  const env={COMMAND_STORE:"sqlite",COMMAND_SQLITE_PATH:join(dir,"db.sqlite"),COMMAND_ENABLE_GENESIS_AI:"1",COMMAND_ENABLE_DAILY_GENESIS:"1",
    COMMAND_GENESIS_PATH:path,COMMAND_GENESIS_SHA256:sha(text),COMMAND_GENESIS_VERSION:"fixture",
    COMMAND_ENABLE_PAID_AI:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"50000",COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"50000"};
  return {dir,text,path,env,store:openStore(env)};
}

test("daily research verifies full bytes on count, retries and paid fallback and retains reservations",async()=>{
  const f=await fixture();
  try {
    const calls:string[]=[];
    const request:typeof fetch=async (url,options)=>{
      const body=JSON.parse(String(options?.body)),count=String(url).endsWith(":countTokens");
      const payload=count?body.generateContentRequest:body;
      assert.deepEqual(Buffer.from(payload.systemInstruction.parts[0].text),Buffer.from(f.text));
      assert.equal(sha(payload.systemInstruction.parts[0].text),f.env.COMMAND_GENESIS_SHA256);
      assert.equal(JSON.stringify(body).includes("private suggestion"),false);
      calls.push(`${String(url).includes("-paid-")?"paid":"free"}:${count?"count":"generate"}`);
      if(count)return Response.json({totalTokens:100});
      return String(url).includes("-paid-")?ok():Response.json({}, {status:503});
    };
    const result=await researchDaily({kind:"daily-review",runId:"daily-2026-01-01",models:[free,paid],ledger:f.store,env:f.env,request});
    assert.ok(result.record && validDailyRecord(result.record));
    assert.deepEqual(calls,["free:count","free:generate","free:generate","paid:count","paid:generate"]);
    assert.equal(result.externalAiCalls,5);assert.equal(result.paidAiCalls,1);assert.equal(result.costMicros,110);
    const metrics=await f.store.allRunMetrics();
    assert.equal(metrics.monthlyPaidAiReservedMicros,8000);assert.equal(metrics.monthlyPaidAiSpendMicros,110);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

const approvedSeedPath=process.env.COMMAND_GENESIS_TEST_SEED_PATH;
test("pinned approved Seed stays byte-identical through production-like AI fallback and later AI-free reuse",
  {skip:!approvedSeedPath},async()=>{
    if(!approvedSeedPath)return;
    const f=await fixture();
    try {
      const expectedChecksum="8199eb2b080c6ac56f71443c1506173f8227dc9df58a145801b56e9e2fd538c6";
      const bytes=await readFile(approvedSeedPath);
      assert.equal(bytes.length,463_037);
      assert.equal(sha(bytes),expectedChecksum);
      const env={...f.env,NODE_ENV:"production",COMMAND_ENABLE_GENESIS_AI:"1",COMMAND_ENABLE_DAILY_GENESIS:"1",
        COMMAND_ENABLE_PAID_AI:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"50000",COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"50000",
        COMMAND_GENESIS_PATH:approvedSeedPath,COMMAND_GENESIS_VERSION:"1.1.0",COMMAND_GENESIS_SHA256:expectedChecksum,
        COMMAND_FREE_PROVIDER_KEY:free.key,COMMAND_FREE_MODEL_NAME:free.name,COMMAND_FREE_MODEL_CONTEXT:"600000",
        COMMAND_PAID_PROVIDER_KEY:paid.key,COMMAND_PAID_MODEL_NAME:paid.name,COMMAND_PAID_MODEL_CONTEXT:"600000",
        COMMAND_PAID_MODEL_INPUT_MICROS_PER_MILLION:"10000",COMMAND_PAID_MODEL_OUTPUT_MICROS_PER_MILLION:"10000",
        COMMAND_PAID_MODEL_BILLABLE_OUTPUT_LIMIT:"256"};
      const calls:string[]=[];
      let paidGenerations=0;
      const request:typeof fetch=async(url,options)=>{
        const body=JSON.parse(String(options?.body));
        const count=String(url).endsWith(":countTokens");
        const payload=count?body.generateContentRequest:body;
        const sent=Buffer.from(payload.systemInstruction.parts[0].text,"utf8");
        assert.equal(sent.length,bytes.length);
        assert.equal(sha(sent),expectedChecksum);
        assert.ok(sent.equals(bytes),"every provider request contains the exact approved Seed bytes");
        const isPaid=String(url).includes("-paid-");
        calls.push(`${isPaid?"paid":"free"}:${count?"count":"generate"}`);
        if(count)return Response.json({totalTokens:400_000});
        if(!isPaid)return Response.json({}, {status:503});
        if(++paidGenerations===1)return Response.json({}, {status:503});
        return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:'{"version":1,"method":"match-by-id"}'}]}}],
          usageMetadata:{promptTokenCount:400_000,candidatesTokenCount:10}});
      };
      const date=new Date("2026-11-20T00:05:00Z");
      const productionStore={...f.store,production:true};
      const first=await runCycle(productionStore,"daily-review",date,async()=>"Source checked (HTTP 200)",{env,request});
      assert.ok(first);
      assert.deepEqual(calls,["free:count","free:generate","free:generate","paid:count","paid:generate","paid:generate"]);
      assert.equal(first.learning.externalAiCalls,6);
      assert.equal(first.learning.paidAiCalls,2);
      const saved=(await f.store.dailyResearch())[0];
      assert.ok(saved && validDailyRecord(saved));
      assert.equal(saved.seedChecksum,expectedChecksum);
      assert.ok(first.research.some(item=>item.result.includes(saved.id)));

      const replayEnv={NODE_ENV:"production",COMMAND_ENABLE_GENESIS_AI:"0",COMMAND_ENABLE_DAILY_GENESIS:"0",
        COMMAND_GENESIS_SHA256:expectedChecksum};
      let replayCalls=0;
      const replay=await runCycle(productionStore,"scheduled",new Date("2026-11-21T00:05:00Z"),
        async()=>"Source checked (HTTP 200)",{env:replayEnv,request:async()=>{replayCalls++;throw new Error("external AI must stay off");}});
      assert.ok(replay);
      assert.equal(replayCalls,0);
      assert.equal(replay.learning.externalAiCalls,0);
      assert.ok(replay.research.some(item=>item.result.includes(saved.id)&&item.result.includes("fresh synthetic")));
    } finally {await rm(f.dir,{recursive:true,force:true});}
  });

test("daily research guard, invalid outputs and mutated seed fail closed",async()=>{
  const f=await fixture();
  try {
    let calls=0;
    const request:typeof fetch=async url=>{calls++;return String(url).endsWith(":countTokens")?Response.json({totalTokens:100}):ok();};
    for(const [kind,env] of [["preview",f.env],["daily-review",{...f.env,COMMAND_ENABLE_DAILY_GENESIS:"0"}]] as const) {
      assert.equal((await researchDaily({kind,runId:"daily-2026-01-01",models:[free],ledger:f.store,env,request})).externalAiCalls,0);
    }
    const wrongChecksum=await researchDaily({kind:"daily-review",runId:"daily-2026-01-01",models:[free],ledger:f.store,
      env:{...f.env,COMMAND_GENESIS_SHA256:"f".repeat(64)},request});
    assert.equal(wrongChecksum.externalAiCalls,0);
    assert.equal(wrongChecksum.record,undefined);
    assert.equal(calls,0);
    const invalid=[
      ok('{"version":2,"method":"match-by-id"}'),ok('{"version":1,"method":"match-by-id","extra":"secret"}'),
      ok("match-by-id"),Response.json({candidates:[{finishReason:"MAX_TOKENS",content:{parts:[{text:'{"version":1,"method":"match-by-id"}'}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:10}}),
      Response.json({candidates:[{finishReason:"STOP",content:{parts:[{functionCall:{name:"execute"}}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:10}}),
      Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:'{"version":1,"method":"match-by-id"}'}]}}]}),
    ];
    for(const response of invalid) {
      const result=await researchDaily({kind:"daily-review",runId:"daily-2026-01-01",models:[free],ledger:f.store,env:f.env,
        request:async url=>String(url).endsWith(":countTokens")?Response.json({totalTokens:100}):response});
      assert.equal(result.record,undefined);
    }
    calls=0;
    const changed:typeof fetch=async url=>{
      calls++;
      if(String(url).endsWith(":countTokens")) {await writeFile(f.path,f.text+"changed");return Response.json({totalTokens:100});}
      throw new Error("must not send");
    };
    const outcome=await researchDaily({kind:"daily-review",runId:"daily-2026-01-01",models:[free,paid],ledger:f.store,env:f.env,request:changed});
    assert.equal(outcome.record,undefined);assert.equal(calls,1);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test("paid generation retries retain uncertain reservations and verify the Seed on every send",async()=>{
  const f=await fixture();
  try {
    let generation=0;
    const request:typeof fetch=async (url,options)=>{
      const body=JSON.parse(String(options?.body));
      const count=String(url).endsWith(":countTokens");
      assert.deepEqual(Buffer.from((count?body.generateContentRequest:body).systemInstruction.parts[0].text),Buffer.from(f.text));
      if(count)return Response.json({totalTokens:100});
      return ++generation===1?Response.json({}, {status:503}):ok();
    };
    const result=await researchDaily({kind:"daily-review",runId:"daily-2026-01-03",models:[paid],ledger:f.store,env:f.env,request});
    assert.ok(result.record);assert.equal(generation,2);assert.equal(result.paidAiCalls,2);
    const metrics=await f.store.allRunMetrics();
    assert.equal(metrics.monthlyPaidAiReservedMicros,16000);
    assert.equal(metrics.monthlyPaidAiSpendMicros,110);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test("durable AI record is reused on fresh inputs without AI and cannot be forged or leak private data",async()=>{
  const f=await fixture();
  try {
    const env={...f.env,COMMAND_FREE_PROVIDER_KEY:free.key,COMMAND_FREE_MODEL_NAME:free.name,COMMAND_FREE_MODEL_CONTEXT:"4000"};
    const secret="private suggestion never publish this text";
    await f.store.enqueue({programme:"continuity",text:secret,resourceUrl:"https://example.org/private"});
    let calls=0;
    const request:typeof fetch=async url=>{calls++;return String(url).endsWith(":countTokens")?Response.json({totalTokens:100}):ok();};
    const first=await runCycle(f.store,"daily-review",new Date(),async()=>"Source checked (HTTP 200)",{env,request});
    assert.ok(first);assert.equal(calls,2);
    const reloaded=openStore(env),records=await reloaded.dailyResearch();
    assert.equal(records.length,1);assert.equal(validDailyRecord({...records[0],method:"malicious"}),false);
    assert.equal(compareInventory(records[0]!,[{id:"x",digest:"new"}],[{id:"x",digest:"new"}]),true);
    assert.equal(compareInventory(records[0]!,[{id:"x",digest:"new"}],[{id:"x",digest:"different"}]),false);
    assert.throws(()=>compareInventory(records[0]!,[{id:"x",digest:"1"},{id:"x",digest:"2"}],[]));
    const replay=await runCycle(reloaded,"scheduled",new Date(),async()=>"Source checked (HTTP 200)",{
      env:{COMMAND_GENESIS_SHA256:f.env.COMMAND_GENESIS_SHA256},request:async()=>{throw new Error("unexpected AI");}});
    assert.ok(replay);assert.equal(replay.learning.externalAiCalls,0);
    assert.ok(replay.research.some(item=>item.result.includes(records[0]!.id)&&item.result.includes("fresh synthetic")));
    assert.ok(first.research.some(item=>item.result.includes(records[0]!.id)));
    await writeFile(f.path,f.text+"changed");
    const changed=await runCycle(reloaded,"internal-replay",new Date(),async()=>"Source checked (HTTP 200)",{env:{COMMAND_GENESIS_SHA256:"f".repeat(64)}});
    assert.ok(changed);assert.equal(changed.research.some(item=>item.result.includes(records[0]!.id)),false);
    assert.equal(changed.learning.externalAiCalls,0);
    const missing=await runCycle(reloaded,"internal-replay",new Date(),async()=>"Source checked (HTTP 200)",{env:{}});
    assert.ok(missing);assert.equal(missing.research.some(item=>item.result.includes(records[0]!.id)),false);
    const publicText=JSON.stringify(await getFeed(openStore(env)));
    for(const value of [secret,"https://example.org/private",f.text,free.key])assert.equal(publicText.includes(value),false);
    const db=new DatabaseSync(env.COMMAND_SQLITE_PATH);
    db.prepare("UPDATE daily_research SET value=?").run(JSON.stringify({...records[0],method:"malicious"}));db.close();
    assert.equal((await openStore(env).dailyResearch()).length,0);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test("paid budget is persistent and bounded across concurrent and repeated runs",async()=>{
  const f=await fixture();
  try {
    const env={...f.env,COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"16000",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"1000000"};
    const stores=[openStore(env),openStore(env)];
    let calls=0;
    const request:typeof fetch=async url=>{calls++;return String(url).endsWith(":countTokens")?Response.json({totalTokens:100}):Response.json({}, {status:503});};
    await Promise.all(stores.map(store=>researchDaily({kind:"daily-review",runId:"daily-2026-01-01",models:[paid],ledger:store,env,request})));
    const metrics=await f.store.allRunMetrics();
    assert.ok(metrics.monthlyPaidAiReservedMicros+metrics.monthlyPaidAiSpendMicros<=16000);
    const before=calls;
    await researchDaily({kind:"daily-review",runId:"daily-2026-01-01",models:[paid],ledger:openStore(env),env,request});
    assert.equal(calls,before);
    await researchDaily({kind:"daily-review",runId:"daily-2026-01-02",models:[paid],ledger:openStore(env),env,request});
    assert.ok(calls>before);
    const disabled=await researchDaily({kind:"daily-review",runId:"daily-2026-01-01",models:[paid],ledger:f.store,env:{...env,COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"50001"},request});
    assert.equal(disabled.externalAiCalls,0);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test("public paid cost stays unknown for count failures, generation failures, incomplete usage and settled estimates",async()=>{
  for(const scenario of ["count-timeout","generation-error","missing-usage","success"] as const) {
    const f=await fixture();
    try {
      const env={...f.env,COMMAND_PAID_PROVIDER_KEY:paid.key,COMMAND_PAID_MODEL_NAME:paid.name,
        COMMAND_PAID_MODEL_CONTEXT:"4000",COMMAND_PAID_MODEL_INPUT_MICROS_PER_MILLION:"1000000",
        COMMAND_PAID_MODEL_OUTPUT_MICROS_PER_MILLION:"1000000",COMMAND_PAID_MODEL_BILLABLE_OUTPUT_LIMIT:"256"};
      const request:typeof fetch=async url=>{
        if(String(url).endsWith(":countTokens")) {
          if(scenario==="count-timeout")throw new Error("network failure");
          return Response.json({totalTokens:100});
        }
        if(scenario==="generation-error")return Response.json({}, {status:429});
        if(scenario==="missing-usage")return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:'{"version":1,"method":"match-by-id"}'}]}}]});
        return ok();
      };
      const run=await runCycle(f.store,"daily-review",new Date(),async()=>"Source checked (HTTP 200)",{env,request});
      assert.ok(run);assert.equal(run.learning.paidCostMicros,null);
      const evidence=run.engines.find(item=>item.id==="divine-ai-instances")!.evidence;
      assert.ok(evidence.some(item=>item.detail.includes("Actual provider billing is unknown")&&item.detail.includes("unresolved reservations")));
      const feed=GetCommandFeedResponse.parse(await getFeed(openStore(env)));
      assert.equal(feed.runs[0]?.learning.paidCostMicros,null);
      assert.equal(feed.learning.monthlyPaidAiCostStatus,"unreconciled");
      assert.ok(feed.learning.monthlyPaidAiReservedMicros>0);
      assert.equal(feed.learning.monthlyPaidAiSpendMicros,scenario==="success"?110:0);
    } finally {await rm(f.dir,{recursive:true,force:true});}
  }
});
