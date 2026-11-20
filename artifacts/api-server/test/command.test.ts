import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { archiveExercise, benchmark, safePublicResourceUrl, safeSuggestion, sha } from "../src/command/engines";
import { getFeed, projectRun, runCycle } from "../src/command/cycle";
import { askGenesis, configuredModels, loadSeed, publishedCandidate, type Model } from "../src/command/genesis";
import { openStore } from "../src/command/store";
import { evaluateEvolutionMethod, exportSnapshot, learnContinuity, learnEvolution, verifyMethod, verifySnapshot } from "../src/command/knowledge";

test("workflow promotes equivalent lookup and rolls back a faulty candidate", () => {
  assert.deepEqual(benchmark(),{baselineReads:132096,candidateReads:2176,promoted:true,rolledBack:true});
  const method=learnEvolution("evolution-fixture");
  assert.equal(verifyMethod(method),true);
  assert.equal(evaluateEvolutionMethod(method).promoted,true);
  assert.equal(evaluateEvolutionMethod(method).rolledBack,true);
  assert.equal(verifyMethod({...method,method:method.method+" modified"}),false);
});

test("isolated restore detects, stages and verifies; routine check does not inject", async () => {
  const routine=await archiveExercise(false), incident=await archiveExercise(true);
  assert.equal(routine.restored,false);
  assert.notEqual(incident.observed,incident.expected);
  assert.equal(incident.expected,incident.mirrorHash);
  assert.equal(incident.expected,incident.verified);
  assert.equal(incident.restored,true);
});

test("durable run lease, repeated trigger, feed allowlist and private inbox", async () => {
  const dir=await mkdtemp(join(tmpdir(),"command-test-"));
  try {
    const env={COMMAND_SQLITE_PATH:join(dir,"test.sqlite"),COMMAND_STORE:"sqlite"};
    const first=openStore(env), second=openStore(env);
    const text="Compare two independent copies of synthetic archive materials.";
    await first.enqueue({programme:"continuity",text});
    assert.equal(safeSuggestion(text),true);
    assert.equal(safeSuggestion("visit https://example.org for personal details"),false);
    assert.equal(safeSuggestion("mail private@example.org for personal details"),false);
    assert.equal(safePublicResourceUrl("https://example.org/research"),true);
    assert.equal(safePublicResourceUrl("http://example.org/research"),false);
    assert.equal(safePublicResourceUrl("https://127.0.0.1/private"),false);
    assert.equal(safePublicResourceUrl("https://user:pass@example.org/research"),false);
    const [a,b]=await Promise.all([first.claim("duplicate"),second.claim("duplicate")]);
    assert.equal([a,b].filter(Boolean).length,1);
    const run=await runCycle(first,"archive-exercise",new Date(),async()=>"Source checked (HTTP 200)");
    assert.ok(run);
    assert.equal(await runCycle(second,"archive-exercise",new Date(),async()=>"unexpected"),null);
    const feed=await getFeed(second);
    assert.equal(feed.engines.length,14);
    assert.equal(feed.runs.length,1);
    assert.equal(feed.runs[0]?.warnings[0]?.status,"Resolved — exercise");
    assert.equal(feed.knowledge.length,2);
    assert.equal(feed.knowledge[0]?.status,"verified");
    assert.equal(feed.knowledge[0]?.evaluations[0]?.outcome,"passed");
    assert.equal(JSON.stringify(feed).includes(text),false);
    assert.equal(JSON.stringify(projectRun(Object.assign(run,{privateText:text}))).includes(text),false);
    assert.equal(JSON.stringify(feed).includes("unverified"),true);
    const amounts=await Promise.all([first.reserve("one",60,100),second.reserve("two",60,100)]);
    assert.equal(amounts.filter(Boolean).length,1);
    await first.settle("one",20,100);
    assert.equal(await second.reserve("three",80,100),true);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("stored method is reloaded and evaluated without AI on fresh inputs", async ()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-replay-"));
  try {
    const env={COMMAND_SQLITE_PATH:join(dir,"replay.sqlite"),COMMAND_STORE:"sqlite"};
    const now=new Date(), next=new Date(+now+15*60_000);
    const store=openStore(env);
    const first=await runCycle(store,"preview",now,async()=>"Source checked (HTTP 200)");
    const second=await runCycle(openStore(env),"internal-replay",next,async()=>"Source checked (HTTP 200)");
    const third=await runCycle(openStore(env),"internal-replay",new Date(+next+15*60_000),async()=>"Source checked (HTTP 200)");
    assert.equal(first?.learning.knowledgeReused,false);
    assert.equal(first?.learning.externalAiMode,"disabled");
    assert.equal(first?.learning.externalAiCalls,0);
    assert.equal(second?.learning.knowledgeReused,true);
    assert.equal(second?.learning.methodId,first?.learning.methodId);
    assert.equal(second?.learning.methodVersion,first?.learning.methodVersion);
    assert.equal(second?.learning.verification,"passed");
    assert.equal(second?.learning.paidCostMicros,0);
    assert.equal(third?.learning.knowledgeReused,true);
    const feed=await getFeed(openStore(env));
    assert.equal(feed.learning.internalMissionRuns,2);
    assert.equal(feed.learning.externallyAssistedRuns,0);
    assert.equal(feed.learning.paidAiCalls,0);
    assert.equal(feed.learning.paidAiCallsAvoided,2);
    assert.equal(feed.knowledge[0]?.evaluations.length,3);
    assert.equal(JSON.stringify(feed).includes("test@example.org"),false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("accepted private suggestions await item-specific research without exposure",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-suggestion-"));
  try {
    const store=openStore({COMMAND_SQLITE_PATH:join(dir,"suggestion.sqlite"),COMMAND_STORE:"sqlite"});
    const privateTexts=[
      "Compare continuity process one with a private archive location",
      "Compare continuity process two with an unpublished collection",
      "Compare continuity process three using separate backup records",
    ];
    const ids:string[]=[];
    for(const [index,text] of privateTexts.entries())ids.push(await store.enqueue({
      programme:"continuity",text,resourceUrl:index===0?"https://example.org/private-review-reference":undefined,
    }));
    await store.enqueue({programme:"prosperity",text:"Test a single nonpublic prosperity idea"});
    assert.equal((await store.review()).selected,null);
    assert.equal(await store.setSuggestionReview(ids[0]!,{status:"accepted",reason:"Accepted for private review"}),true);
    const run=await runCycle(store,"preview",new Date(),async()=>"Source checked (HTTP 200)");
    assert.ok(run);
    assert.equal(run.engines.find(engine=>engine.id==="beneficiary-routing")?.metric.includes("selected"),false);
    const publicResult=JSON.stringify(await getFeed(store));
    for(const text of privateTexts)assert.equal(publicResult.includes(text),false);
    assert.equal(publicResult.includes("https://example.org/private-review-reference"),false);
    assert.equal(publicResult.includes("privately reviewed suggestion"),false);
    assert.equal(publicResult.includes("single nonpublic prosperity idea"),false);
    assert.equal(publicResult.includes(ids[0]!),false);
    const records=await store.listSuggestions();
    assert.equal(records.find(item=>item.id===ids[0])?.status,"accepted");
    assert.equal(records.find(item=>item.id===ids[1])?.status,"queued");
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("versioned knowledge exports, verifies, and restores into a clean store",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-export-"));
  try {
    const source=openStore({COMMAND_SQLITE_PATH:join(dir,"source.sqlite"),COMMAND_STORE:"sqlite"});
    const sourceTime=new Date();
    const generated=learnContinuity("source-run",sourceTime);
    const evolved=learnEvolution("source-run",sourceTime);
    assert.equal(verifyMethod(generated),true);
    assert.equal(verifyMethod(evolved),true);
    const lease=await source.claim("source-run");
    assert.ok(lease);
    const run={
      id:"source-run",kind:"preview",startedAt:sourceTime.toISOString(),finishedAt:new Date(+sourceTime+1).toISOString(),outcome:"completed",
      learning:{tracking:"measured" as const,mission:"archive-continuity-integrity",methodId:generated.methodId,methodVersion:generated.version,knowledgeId:generated.id,
        knowledgeReused:false,verification:"passed" as const,externalAiMode:"disabled" as const,externalAiCalls:0,paidAiCalls:0,paidCostMicros:0},
      engines:[],research:[],warnings:[],advice:[],
    };
    await source.complete(lease,run,[{entry:generated,outcome:"passed"},{entry:evolved,outcome:"passed"}]);
    const snapshot=exportSnapshot(await source.knowledge(),new Date(+sourceTime+2));
    assert.equal(snapshot.entryCount,2);
    assert.equal(verifySnapshot(JSON.parse(JSON.stringify(snapshot))).checksum,snapshot.checksum);
    const clean=openStore({COMMAND_SQLITE_PATH:join(dir,"restored.sqlite"),COMMAND_STORE:"sqlite"});
    assert.equal((await clean.knowledge()).length,0);
    await clean.importKnowledge(snapshot);
    assert.deepEqual(await clean.knowledge(),await source.knowledge());
    await clean.importKnowledge(snapshot);
    assert.equal((await clean.knowledge()).length,2);
    const replay=await runCycle(clean,"internal-replay",new Date(),async()=>"Source checked (HTTP 200)");
    assert.equal(replay?.learning.knowledgeReused,true);
    assert.equal(replay?.learning.verification,"passed");
    assert.equal((await getFeed(clean)).learning.internalMissionRuns,1);
    const tampered=JSON.parse(JSON.stringify(snapshot));
    tampered.entries[0].method+=" Modified";
    assert.throws(()=>verifySnapshot(tampered),/unsupported or modified method/);
    const injected=JSON.parse(JSON.stringify(snapshot));
    injected.entries[0].privateVisitorText="private";
    assert.throws(()=>verifySnapshot(injected),/unsupported or modified method/);
    assert.equal(publishedCandidate.checksum,"8199eb2b080c6ac56f71443c1506173f8227dc9df58a145801b56e9e2fd538c6");
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("historical runs without learning telemetry remain readable and uncounted",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-legacy-"));
  try {
    const env={COMMAND_SQLITE_PATH:join(dir,"legacy.sqlite"),COMMAND_STORE:"sqlite"};
    const store=openStore(env);
    const run=await runCycle(store,"preview",new Date(),async()=>"Source checked (HTTP 200)");
    assert.ok(run);
    const db=new DatabaseSync(env.COMMAND_SQLITE_PATH);
    const row=db.prepare("SELECT value FROM slots WHERE id=?").get(run.id) as {value:string};
    const slot=JSON.parse(row.value);
    delete slot.run.learning;
    db.prepare("UPDATE slots SET value=? WHERE id=?").run(JSON.stringify(slot),run.id);
    db.close();
    const feed=await getFeed(openStore(env));
    assert.equal(feed.runs[0]?.learning.tracking,"legacy");
    assert.equal(feed.runs[0]?.learning.externalAiMode,"unknown");
    assert.equal(feed.learning.internalMissionRuns,0);
    assert.equal(feed.learning.externallyAssistedRuns,0);
    assert.equal(feed.learning.paidAiCalls,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("wire payload retains exact synthetic Seed in token count, free, paid, retry and fallback", async () => {
  const dir=await mkdtemp(join(tmpdir(),"command-wire-"));
  try {
  const text="\ufeffGenesis test fixture\r\n• Κυριακή\r\nlast line ends with whitespace \n".repeat(7000);
  const seed={text,version:"fixture",checksum:sha(text)};
  const path=join(dir,"seed.txt");
  await writeFile(path,text);
  const free:Model={name:"gemini-free-fixture",tier:"free",key:"fixture-free",context:800_000,inputMicrosPerMillion:0,outputMicrosPerMillion:0};
  const paid:Model={...free,name:"gemini-paid-fixture",tier:"paid",key:"fixture-paid",inputMicrosPerMillion:1_000,outputMicrosPerMillion:1_000};
  const env={COMMAND_ENABLE_DAILY_GENESIS:"1",COMMAND_ENABLE_PAID_AI:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"1000000",COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"50000",
    COMMAND_GENESIS_PATH:path,COMMAND_GENESIS_SHA256:seed.checksum,COMMAND_GENESIS_VERSION:seed.version};
  const ledgerEvents:string[]=[], wire:string[]=[];
  const ledger={
    async reserve(_id:string,amount:number,cap:number) { assert.ok(amount<=cap);ledgerEvents.push("reserve"); return true; },
    async settle(_id:string,_amount:number,_tokens:number) {ledgerEvents.push("settle");},
  };
  const request:typeof fetch=async (url,opts)=>{
    assert.equal(typeof opts?.body,"string");
    const body=JSON.parse(String(opts?.body));
    const count=String(url).endsWith(":countTokens");
    const isPaid=String(url).includes("-paid-");
    const payload=count?body.generateContentRequest:body;
    if(count)assert.equal(payload.model,isPaid?"models/gemini-paid-fixture":"models/gemini-free-fixture");
    const actual=payload.systemInstruction.parts[0].text;
    assert.equal(actual,text);
    assert.equal(sha(actual),seed.checksum);
    wire.push(`${isPaid?"paid":"free"}:${count?"count":"call"}`);
    if (count) return Response.json({totalTokens:140_000});
    if (!isPaid || wire.filter(v=>v==="paid:call").length===1) return Response.json({}, {status:503});
    return Response.json({candidates:[{finishReason:"STOP",safetyRatings:[{category:"HARM_CATEGORY_HARASSMENT"}],content:{parts:[{text:"inventory-comparison"}]}}],usageMetadata:{promptTokenCount:140000,candidatesTokenCount:4}});
  };
  const result=await askGenesis({kind:"daily-review",seed,models:[free,paid],ledger,cap:1_000_000,request,env});
  assert.equal(result.status,"measured");
  assert.deepEqual(wire,["free:count","free:call","free:call","paid:count","paid:call","paid:call"]);
  assert.deepEqual(ledgerEvents,["reserve","reserve","reserve","settle"]);
  assert.equal(result.checksum,seed.checksum);
  assert.equal(result.externalAiCalls,6);
  assert.equal(result.paidAiCalls,2);
  assert.equal(result.costMicros,141);
  assert.match(result.note,/unresolved reservation/);
  assert.equal((await askGenesis({kind:"daily-review",seed:null,models:[free],ledger,cap:0,request,env})).status,"blocked");
  wire.length=0;
  assert.equal((await askGenesis({kind:"daily-review",seed,models:[{...free,context:100}],ledger,cap:0,request,env})).status,"blocked");
  assert.deepEqual(wire,[]);
  wire.length=0;
  assert.equal((await askGenesis({kind:"daily-review",seed,models:[paid],ledger,cap:0,request,env})).status,"blocked");
  assert.deepEqual(wire,[]);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("paid AI requires approved Seed configuration, explicit opt-in and a bounded monthly allowance",()=>{
  const base={COMMAND_PAID_PROVIDER_KEY:"fixture-key",COMMAND_PAID_MODEL_NAME:"gemini-fixture",COMMAND_PAID_MODEL_CONTEXT:"1000",COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"50000",
    COMMAND_PAID_MODEL_INPUT_MICROS_PER_MILLION:"1000000",COMMAND_PAID_MODEL_OUTPUT_MICROS_PER_MILLION:"1000000",
    COMMAND_PAID_MODEL_BILLABLE_OUTPUT_LIMIT:"256",COMMAND_GENESIS_PATH:"approved/seed.txt",
    COMMAND_GENESIS_SHA256:"a".repeat(64),COMMAND_GENESIS_VERSION:"owner-approved"};
  assert.equal(configuredModels(base).some(model=>model.tier==="paid"),false);
  assert.equal(configuredModels({...base,COMMAND_ENABLE_PAID_AI:"1"}).some(model=>model.tier==="paid"),false);
  assert.equal(configuredModels({...base,COMMAND_ENABLE_PAID_AI:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"0"}).some(model=>model.tier==="paid"),false);
  assert.equal(configuredModels({...base,COMMAND_ENABLE_PAID_AI:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"1000"}).some(model=>model.tier==="paid"),true);
  assert.equal(configuredModels({...base,COMMAND_ENABLE_PAID_AI:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"not-a-number"}).some(model=>model.tier==="paid"),false);
  assert.equal(configuredModels({...base,COMMAND_ENABLE_PAID_AI:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"100000",COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"50001"}).some(model=>model.tier==="paid"),false);
  assert.equal(configuredModels({...base,COMMAND_ENABLE_PAID_AI:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"100000",COMMAND_PAID_AI_EXECUTION_CAP_MICROS:""}).some(model=>model.tier==="paid"),false);
});

test("paid AI monthly reservations gate token counts and concurrent generations",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-paid-budget-"));
  try {
    const path=join(dir,"paid.sqlite"),text="approved complete seed";
    const seed={text,version:"owner-approved",checksum:sha(text)};
    const seedPath=join(dir,"seed.txt");
    await writeFile(seedPath,text);
    const env={COMMAND_STORE:"sqlite",COMMAND_SQLITE_PATH:path,COMMAND_ENABLE_PAID_AI:"1",
      COMMAND_ENABLE_DAILY_GENESIS:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"1500",COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"1200",COMMAND_GENESIS_PATH:seedPath,
      COMMAND_GENESIS_SHA256:seed.checksum,COMMAND_GENESIS_VERSION:seed.version};
    const stores=[openStore(env),openStore(env)],model:Model={name:"gemini-paid-fixture",tier:"paid",key:"fixture",
      context:257,inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000,billableOutputLimit:256};
    let tokenRequests=0,generationRequests=0;
    let generationStarted!:()=>void,releaseGeneration!:()=>void;
    const entered=new Promise<void>(resolve=>{generationStarted=resolve;});
    const gate=new Promise<void>(resolve=>{releaseGeneration=resolve;});
    const request:typeof fetch=async url=>{
      if(String(url).endsWith(":countTokens")){tokenRequests++;return Response.json({totalTokens:1});}
      generationRequests++;
      generationStarted();
      await gate;
      return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:"inventory-comparison"}]}}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:256}});
    };
    const first=askGenesis({kind:"daily-review",seed,models:[model],ledger:stores[0]!,request,env});
    await entered;
    const second=await askGenesis({kind:"daily-review",seed,models:[model],ledger:stores[1]!,request,env});
    releaseGeneration();
    const outcomes=[await first,second];
    assert.equal(tokenRequests>=1,true);
    assert.equal(generationRequests,1);
    assert.equal(outcomes.filter(result=>result.status==="measured").length,1);
    const metrics=await openStore(env).allRunMetrics();
    assert.equal(metrics.monthlyPaidAiSpendMicros,257);
    assert.equal(metrics.monthlyPaidAiAllowanceMicros,1500);
    assert.equal(metrics.monthlyPaidAiReservedMicros,tokenRequests*514);
    assert.ok(metrics.monthlyPaidAiRequests>=tokenRequests+generationRequests);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("Genesis loader rejects modifications and retains BOM, CRLF and trailing bytes", async ()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-seed-"));
  try {
    const path=join(dir,"seed.txt"), text="\ufeffstart\r\nend \r\n";
    const env={COMMAND_GENESIS_PATH:path,COMMAND_GENESIS_VERSION:"fixture",COMMAND_GENESIS_SHA256:sha(text)};
    await writeFile(path,text);
    assert.equal((await loadSeed(env))?.text,text);
    await writeFile(path,text+" ");
    assert.equal(await loadSeed(env),null);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("daily review alone can use explicitly enabled Genesis and records safe provenance",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-daily-"));
  try {
    const text="private synthetic Genesis bytes",path=join(dir,"seed.txt"),key="fixture-secret-key";
    await writeFile(path,text);
    const env={COMMAND_STORE:"sqlite",COMMAND_SQLITE_PATH:join(dir,"daily.sqlite"),
      COMMAND_GENESIS_PATH:path,COMMAND_GENESIS_SHA256:sha(text),COMMAND_GENESIS_VERSION:"fixture-v1",
      COMMAND_FREE_MODEL_NAME:"gemini-fixture",COMMAND_FREE_MODEL_CONTEXT:"4000",COMMAND_FREE_PROVIDER_KEY:key};
    const store=openStore(env),now=new Date();
    const calls:string[]=[];
    const request:typeof fetch=async (url,options)=>{
      const body=JSON.parse(String(options?.body));
      const payload=String(url).endsWith(":countTokens")?body.generateContentRequest:body;
      assert.equal(payload.systemInstruction.parts[0].text,text);
      assert.equal(options?.headers && (options.headers as Record<string,string>)["x-goog-api-key"],key);
      calls.push(String(url));
      return String(url).endsWith(":countTokens")?Response.json({totalTokens:100}):
        Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:"inventory-comparison"}]}}],
          usageMetadata:{promptTokenCount:100,candidatesTokenCount:3}});
    };
    const check=async()=>"Source checked (HTTP 200)";
    const disabled=await runCycle(store,"daily-review",now,check,{env,request});
    assert.equal(disabled?.learning.externalAiCalls,0);
    const enabled={...env,COMMAND_ENABLE_DAILY_GENESIS:"1"};
    for (const kind of ["scheduled","preview","internal-replay","archive-exercise"] as const) {
      const result=await runCycle(store,kind,now,check,{env:enabled,request});
      assert.equal(result?.learning.externalAiMode,"disabled");
    }
    assert.equal(calls.length,0);
    const daily=await runCycle(store,"daily-review",new Date(+now+86_400_000),check,{env:enabled,request});
    assert.equal(calls.length,2);
    assert.equal(daily?.learning.externalAiMode,"model");
    assert.equal(daily?.learning.externalAiCalls,2);
    assert.equal(daily?.learning.paidAiCalls,0);
    assert.equal(daily?.learning.verification,"passed");
    const ai=daily?.engines.find(item=>item.id==="divine-ai-instances");
    assert.equal(ai?.status,"measured");
    assert.deepEqual(ai?.evidence.map(item=>item.label),["Model","Model tier","Genesis version","Genesis SHA-256"]);
    assert.equal(ai?.evidence[3]?.detail,sha(text));
    const published=JSON.stringify(await getFeed(store));
    for(const secret of [key,text,"inventory-comparison"])assert.equal(published.includes(secret),false);
    assert.match(ai?.detail??"",/not a verified AI-derived method/);
    assert.equal(await runCycle(store,"daily-review",new Date(+now+86_400_000),check,{env:enabled,request}),null);
    assert.equal(calls.length,2);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("gateway rejects unapproved, changed, unsafe or unverifiable outcomes without disclosing them",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-gateway-"));
  try {
    const text="canonical fixture",path=join(dir,"seed.txt"),seed={text,version:"fixture",checksum:sha(text)};
    await writeFile(path,text);
    const env={COMMAND_ENABLE_DAILY_GENESIS:"1",COMMAND_GENESIS_PATH:path,COMMAND_GENESIS_VERSION:seed.version,COMMAND_GENESIS_SHA256:seed.checksum};
    const model:Model={name:"gemini-fixture",tier:"free",key:"fixture-secret",context:4000,inputMicrosPerMillion:0,outputMicrosPerMillion:0};
    const ledger={async reserve(){return true;},async settle(){}};
    let calls=0;
    const blockedRequest:typeof fetch=async()=>{calls++;throw new Error("secret raw error");};
    for(const args of [{kind:"scheduled",env},{kind:"daily-review",env:{...env,COMMAND_ENABLE_DAILY_GENESIS:"0"}}]) {
      assert.equal((await askGenesis({...args,seed,models:[model],ledger,request:blockedRequest})).status,"blocked");
    }
    assert.equal(calls,0);
    const invalid=[
      {candidates:[{finishReason:"STOP",content:{parts:[{text:"private model output"}]}}],usageMetadata:{promptTokenCount:50,candidatesTokenCount:1}},
      {candidates:[{finishReason:"MAX_TOKENS",content:{parts:[{text:"inventory-comparison"}]}}],usageMetadata:{promptTokenCount:50,candidatesTokenCount:1}},
      {candidates:[{finishReason:"STOP",content:{parts:[{text:"inventory-comparison",functionCall:{name:"x"}}]}}],usageMetadata:{promptTokenCount:50,candidatesTokenCount:1}},
      {candidates:[{finishReason:"STOP",content:{parts:[{text:"inventory-comparison"}]}}]},
      {promptFeedback:{blockReason:"SAFETY"},candidates:[{finishReason:"STOP",content:{parts:[{text:"inventory-comparison"}]}}],usageMetadata:{promptTokenCount:50,candidatesTokenCount:1}},
      {candidates:[{finishReason:"STOP",safetyRatings:[{blocked:true}],content:{parts:[{text:"inventory-comparison"}]}}],usageMetadata:{promptTokenCount:50,candidatesTokenCount:1}},
    ];
    for(const response of invalid) {
      const result=await askGenesis({kind:"daily-review",seed,models:[model],ledger,env,request:async url=>
        String(url).endsWith(":countTokens")?Response.json({totalTokens:50}):Response.json(response)});
      assert.equal(result.status,"blocked");
      assert.equal(result.externalAiCalls,2);
      assert.equal(JSON.stringify(result).includes("private model output"),false);
    }
    const changed=await askGenesis({kind:"daily-review",seed,models:[model],ledger,env,request:async ()=>{
      await writeFile(path,text+" modified");
      return Response.json({totalTokens:50});
    }});
    assert.equal(changed.status,"blocked");
    assert.equal(changed.externalAiCalls,1);
    assert.match(changed.note,/Seed changed/);
    const noSeed=await askGenesis({kind:"daily-review",seed,models:[model],ledger,env,request:blockedRequest});
    assert.equal(noSeed.externalAiCalls,0);
    assert.equal(calls,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("paid execution cap bounds ambiguous retries and fails closed without separate approval",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-execution-cap-"));
  try {
    const text="paid seed fixture",path=join(dir,"seed.txt"),seed={text,version:"fixture",checksum:sha(text)};
    await writeFile(path,text);
    const base={COMMAND_ENABLE_DAILY_GENESIS:"1",COMMAND_ENABLE_PAID_AI:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"1000000",
      COMMAND_GENESIS_PATH:path,COMMAND_GENESIS_VERSION:seed.version,COMMAND_GENESIS_SHA256:seed.checksum};
    const model:Model={name:"gemini-paid-fixture",tier:"paid",key:"paid-secret",context:500,
      inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000,billableOutputLimit:256};
    let reservations=0,calls=0;
    const ledger={async reserve(_id:string,amount:number){reservations+=amount;return true;},async settle(_id:string,amount:number){if(amount===0)reservations-=1000;}};
    const request:typeof fetch=async url=>{
      calls++;
      if(String(url).endsWith(":countTokens"))return Response.json({totalTokens:100});
      throw new Error("seed-not-verified");
    };
    for (const value of [undefined,"0","1500","50001","invalid"]) {
      const result=await askGenesis({kind:"daily-review",seed,models:[model],ledger,env:{...base,COMMAND_PAID_AI_EXECUTION_CAP_MICROS:value},request});
      assert.equal(result.externalAiCalls,0);
    }
    const result=await askGenesis({kind:"daily-review",seed,models:[model,model],ledger,
      env:{...base,COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"2500"},request});
    assert.equal(calls,2);
    assert.equal(result.status,"blocked");
    assert.equal(result.paidAiCalls,1);
    assert.equal(result.costMicros,0);
    assert.equal(reservations,2000);
    assert.match(result.note,/unresolved reservation/);
    assert.match(result.note,/actual total is unknown/);
    assert.equal(result.note.includes("secret"),false);
    let reservationsAttempted=0,released=0;
    const limitedLedger={async reserve(){return ++reservationsAttempted===1;},async settle(){released++;}};
    const noCapacity=await askGenesis({kind:"daily-review",seed,models:[model],ledger:limitedLedger,
      env:{...base,COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"2500"},request});
    assert.equal(noCapacity.externalAiCalls,0);
    assert.equal(released,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("paid generation keeps reservations for invalid usage and settles only credible usage",async()=>{
  const path=join(process.cwd(),`.command-usage-${randomUUID()}.txt`);
  const text="approved usage fixture",seed={text,version:"fixture",checksum:sha(text)};
  await writeFile(path,text,{flag:"wx"});
  try {
    const env={COMMAND_ENABLE_DAILY_GENESIS:"1",COMMAND_ENABLE_PAID_AI:"1",
      COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"2500",COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"2500",
      COMMAND_GENESIS_PATH:path,COMMAND_GENESIS_VERSION:seed.version,COMMAND_GENESIS_SHA256:seed.checksum};
    const model:Model={name:"gemini-paid-fixture",tier:"paid",key:"fixture",context:500,
      inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000,billableOutputLimit:256};
    const cases=[
      {promptTokenCount:0,candidatesTokenCount:1},
      {promptTokenCount:100,candidatesTokenCount:0},
      {promptTokenCount:99,candidatesTokenCount:1},
      {promptTokenCount:101,candidatesTokenCount:1},
      {promptTokenCount:100,candidatesTokenCount:257},
      {promptTokenCount:100,candidatesTokenCount:1,thoughtsTokenCount:256},
      {promptTokenCount:100,candidatesTokenCount:1,thoughtsTokenCount:-1},
      {promptTokenCount:100,candidatesTokenCount:1,thoughtsTokenCount:null},
      {promptTokenCount:100,candidatesTokenCount:1,thoughtsTokenCount:1.5},
      {promptTokenCount:Number.MAX_SAFE_INTEGER,candidatesTokenCount:1},
      {promptTokenCount:100},
    ];
    for (const usageMetadata of cases) {
      const reservations=new Map<string,number>(),settlements:string[]=[];
      const ledger={
        async reserve(id:string,amount:number){reservations.set(id,amount);return true;},
        async settle(id:string){settlements.push(id);reservations.delete(id);},
      };
      const request:typeof fetch=async url=>String(url).endsWith(":countTokens")
        ?Response.json({totalTokens:100})
        :Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:"inventory-comparison"}]}}],usageMetadata});
      const result=await askGenesis({kind:"daily-review",seed,models:[model],ledger,env,request});
      assert.equal(result.status,"blocked",JSON.stringify(usageMetadata));
      assert.equal(result.costMicros,0);
      assert.equal(result.unresolvedMicros,2000);
      assert.equal(reservations.size,2);
      assert.deepEqual(settlements,[]);
    }
    const settled:{amount:number;tokens:number}[]=[];
    const ledger={async reserve(){return true;},async settle(_id:string,amount:number,tokens:number){settled.push({amount,tokens});}};
    const result=await askGenesis({kind:"daily-review",seed,models:[model],ledger,env,request:async url=>
      String(url).endsWith(":countTokens")?Response.json({totalTokens:100}):
        Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:"inventory-comparison"}]}}],
          usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,thoughtsTokenCount:3}})});
    assert.equal(result.status,"measured");
    assert.equal(result.unresolvedMicros,1000);
    assert.deepEqual(settled,[{amount:113,tokens:113}]);
  } finally {await rm(path,{force:true});}
});

test("daily public telemetry labels unresolved paid reservations as unknown cost",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-paid-telemetry-"));
  try {
    const text="private seed",path=join(dir,"seed.txt");
    await writeFile(path,text);
    const env={COMMAND_STORE:"sqlite",COMMAND_SQLITE_PATH:join(dir,"telemetry.sqlite"),COMMAND_ENABLE_DAILY_GENESIS:"1",
      COMMAND_ENABLE_PAID_AI:"1",COMMAND_PAID_AI_MONTHLY_CAP_MICROS:"2500",COMMAND_PAID_AI_EXECUTION_CAP_MICROS:"2500",
      COMMAND_GENESIS_PATH:path,COMMAND_GENESIS_SHA256:sha(text),COMMAND_GENESIS_VERSION:"fixture",
      COMMAND_PAID_MODEL_NAME:"gemini-paid-fixture",COMMAND_PAID_PROVIDER_KEY:"private-paid-key",
      COMMAND_PAID_MODEL_CONTEXT:"500",COMMAND_PAID_MODEL_INPUT_MICROS_PER_MILLION:"1000000",
      COMMAND_PAID_MODEL_OUTPUT_MICROS_PER_MILLION:"1000000",COMMAND_PAID_MODEL_BILLABLE_OUTPUT_LIMIT:"256"};
    const store=openStore(env);
    const request:typeof fetch=async url=>String(url).endsWith(":countTokens")
      ?Response.json({totalTokens:100}):Response.json({}, {status:503});
    const run=await runCycle(store,"daily-review",new Date(),async()=>"Source checked (HTTP 200)",{env,request});
    const evidence=run?.engines.find(item=>item.id==="divine-ai-instances")?.evidence.find(item=>item.label==="Paid cost telemetry");
    assert.equal(run?.learning.paidCostMicros,0);
    assert.match(evidence?.detail??"",/estimated settled provider usage.*not confirmed billing/i);
    assert.match(evidence?.detail??"",/Unresolved reservations: 2000 USD micros; actual total cost is unknown/);
    assert.equal(JSON.stringify(run).includes("private-paid-key"),false);
    assert.equal(JSON.stringify(run).includes(text),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});
