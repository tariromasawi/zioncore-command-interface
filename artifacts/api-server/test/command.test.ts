import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveExercise, benchmark, safeSuggestion, sha } from "../src/command/engines";
import { getFeed, projectRun, runCycle } from "../src/command/cycle";
import { askGenesis, loadSeed, type Model } from "../src/command/genesis";
import { openStore } from "../src/command/store";

test("workflow promotes equivalent lookup and rolls back a faulty candidate", () => {
  assert.deepEqual(benchmark(),{baselineReads:132096,candidateReads:2176,promoted:true,rolledBack:true});
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
    assert.equal(JSON.stringify(feed).includes(text),false);
    assert.equal(JSON.stringify(projectRun(Object.assign(run,{privateText:text}))).includes(text),false);
    assert.equal(JSON.stringify(feed).includes("unverified"),true);
    const amounts=await Promise.all([first.reserve("one",60,100),second.reserve("two",60,100)]);
    assert.equal(amounts.filter(Boolean).length,1);
    await first.settle("one",20,100);
    assert.equal(await second.reserve("three",80,100),true);
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
    const payload=body.generateContentRequest ?? body;
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
