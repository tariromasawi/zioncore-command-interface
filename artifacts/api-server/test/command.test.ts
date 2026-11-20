import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { archiveExercise, benchmark, safeSuggestion, sha } from "../src/command/engines";
import { getFeed, projectRun, runCycle } from "../src/command/cycle";
import { askGenesis, loadSeed, publishedCandidate, type Model } from "../src/command/genesis";
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

test("private suggestions influence research only after anonymous category aggregation",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-suggestion-"));
  try {
    const store=openStore({COMMAND_SQLITE_PATH:join(dir,"suggestion.sqlite"),COMMAND_STORE:"sqlite"});
    const privateTexts=[
      "Compare continuity process one with a private archive location",
      "Compare continuity process two with an unpublished collection",
      "Compare continuity process three using separate backup records",
    ];
    for(const text of privateTexts)await store.enqueue({programme:"continuity",text});
    await store.enqueue({programme:"prosperity",text:"Test a single nonpublic prosperity idea"});
    const run=await runCycle(store,"preview",new Date(),async()=>"Source checked (HTTP 200)");
    assert.ok(run);
    assert.equal(run.research[1]?.programme,"Continuity");
    assert.equal(run.engines.find(engine=>engine.id==="beneficiary-routing")?.metric.includes("continuity selected"),true);
    const publicResult=JSON.stringify(await getFeed(store));
    for(const text of privateTexts)assert.equal(publicResult.includes(text),false);
    assert.equal(publicResult.includes("at least three private suggestions"),true);
    assert.equal(publicResult.includes("single nonpublic prosperity idea"),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("versioned knowledge exports, verifies, and restores into a clean store",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"command-export-"));
  try {
    const source=openStore({COMMAND_SQLITE_PATH:join(dir,"source.sqlite"),COMMAND_STORE:"sqlite"});
    const generated=learnContinuity("source-run",new Date("2026-01-01T00:00:00.000Z"));
    assert.equal(verifyMethod(generated),true);
    const lease=await source.claim("source-run");
    assert.ok(lease);
    const run={
      id:"source-run",kind:"preview",startedAt:"2026-01-01T00:00:00.000Z",finishedAt:"2026-01-01T00:00:01.000Z",outcome:"completed",
      learning:{tracking:"measured" as const,mission:"archive-continuity-integrity",methodId:generated.methodId,methodVersion:generated.version,knowledgeId:generated.id,
        knowledgeReused:false,verification:"passed" as const,externalAiMode:"disabled" as const,externalAiCalls:0,paidAiCalls:0,paidCostMicros:0},
      engines:[],research:[],warnings:[],advice:[],
    };
    await source.complete(lease,run,[{entry:generated,outcome:"passed"}]);
    const snapshot=exportSnapshot(await source.knowledge(),new Date("2026-01-02T00:00:00.000Z"));
    assert.equal(verifySnapshot(JSON.parse(JSON.stringify(snapshot))).checksum,snapshot.checksum);
    const clean=openStore({COMMAND_SQLITE_PATH:join(dir,"restored.sqlite"),COMMAND_STORE:"sqlite"});
    assert.equal((await clean.knowledge()).length,0);
    await clean.importKnowledge(snapshot);
    assert.deepEqual(await clean.knowledge(),await source.knowledge());
    await clean.importKnowledge(snapshot);
    assert.equal((await clean.knowledge()).length,1);
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
  const text="\ufeffGenesis test fixture\r\n• Κυριακή\r\nlast line ends with whitespace \n".repeat(7000);
  const seed={text,version:"fixture",checksum:sha(text)};
  const free:Model={name:"gemini-free-fixture",tier:"free",key:"fixture-free",context:800_000,inputMicrosPerMillion:0,outputMicrosPerMillion:0};
  const paid:Model={...free,name:"gemini-paid-fixture",tier:"paid",key:"fixture-paid",inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000};
  const ledgerEvents:string[]=[], wire:string[]=[];
  const ledger={
    async reserve(_id:string,amount:number,cap:number) { assert.ok(amount<=cap);ledgerEvents.push("reserve"); return true; },
    async settle(_id:string,_amount:number,_tokens:number) {ledgerEvents.push("settle");},
  };
  const request:typeof fetch=async (url,opts)=>{
    assert.equal(typeof opts?.body,"string");
    const body=JSON.parse(String(opts?.body));
    const payload=body;
    const actual=payload.systemInstruction.parts[0].text;
    assert.equal(actual,text);
    assert.equal(sha(actual),seed.checksum);
    const isPaid=String(url).includes("-paid-");
    const count=String(url).endsWith(":countTokens");
    wire.push(`${isPaid?"paid":"free"}:${count?"count":"call"}`);
    if (count) return Response.json({totalTokens:140_000});
    if (!isPaid || wire.filter(v=>v==="paid:call").length===1) return Response.json({}, {status:503});
    return Response.json({candidates:[{content:{parts:[{text:"fixture only"}]}}],usageMetadata:{promptTokenCount:140000,candidatesTokenCount:4}});
  };
  const result=await askGenesis({seed,models:[free,paid],ledger,cap:1_000_000,request});
  assert.equal(result.status,"measured");
  assert.deepEqual(wire,["free:count","free:call","free:call","paid:count","paid:call","paid:call"]);
  assert.deepEqual(ledgerEvents,["reserve","reserve","settle"]);
  assert.equal(result.checksum,seed.checksum);
  assert.equal(result.externalAiCalls,6);
  assert.equal(result.paidAiCalls,2);
  assert.equal(result.costMicros,140_004);
  assert.equal((await askGenesis({seed:null,models:[free],ledger,cap:0,request})).status,"blocked");
  wire.length=0;
  assert.equal((await askGenesis({seed,models:[{...free,context:100}],ledger,cap:0,request})).status,"blocked");
  assert.deepEqual(wire,["free:count"]);
  wire.length=0;
  assert.equal((await askGenesis({seed,models:[paid],ledger,cap:0,request})).status,"blocked");
  assert.deepEqual(wire,[]);
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
