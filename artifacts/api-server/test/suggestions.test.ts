import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { openStore } from "../src/command/store";
import { requestLogUrl } from "../src/lib/logger";

test("private request logs redact every route variant and query",()=>{
  const receipt="private-receipt-example";
  for(const path of [
    `/api/command/private/suggestions/${receipt}`,
    `/api/command/private/suggestions/${receipt}/?key=private`,
    `/API/Command/Private/Suggestions/${receipt}/`,
    `/api/command/private/suggestions/%70rivate-receipt/extra`,
  ]) {
    const logged=requestLogUrl(path);
    assert.equal(logged,"/api/command/private/[redacted]");
    assert.ok(!logged.includes(receipt));
  }
  assert.equal(requestLogUrl("/api/command/feed?private=value"),"/api/command/feed");
});

test("related suggestion counts and ranking are explicitly page-limited",async()=>{
  const dir=await mkdtemp(join(process.cwd(),".suggestion-pages-test-"));
  const path=join(dir,"inbox.sqlite");
  try {
    const store=openStore({COMMAND_SQLITE_PATH:path,COMMAND_STORE:"sqlite"});
    const db=new DatabaseSync(path);
    const insert=db.prepare("INSERT INTO suggestion_ledger(id,programme,status,reason,submitted,topic) VALUES(?,?,?,?,?,?)");
    for(let i=0;i<30;i++) insert.run(`receipt-${String(i).padStart(20,"0")}`,"continuity","accepted","Reviewed individually.",Date.now(),"archive-copies");
    db.close();
    const first=await store.listResearchCandidates();
    assert.equal(first.rankingScope,"current-page-only");
    assert.equal(first.candidates.length,25);
    assert.ok(first.candidates.every(item=>item.relatedCount===25 && item.relatedCountScope==="current-page-only"));
    assert.ok(first.nextCursor);
    const second=await store.listResearchCandidates(first.nextCursor);
    assert.equal(second.rankingScope,"current-page-only");
    assert.equal(second.candidates.length,5);
    assert.ok(second.candidates.every(item=>item.relatedCount===5 && item.relatedCountScope==="current-page-only"));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("private decisions are per receipt, durable without raw text, and exclude the audit receipt",async()=>{
  const dir=await mkdtemp(join(process.cwd(),".suggestion-ledger-test-"));
  const path=join(dir,"inbox.sqlite");
  try {
    const store=openStore({COMMAND_SQLITE_PATH:path,COMMAND_STORE:"sqlite"});
    const text="Compare independent private archive copies before restoring.";
    const id=await store.enqueue({programme:"continuity",text,resourceUrl:"https://example.org/private"});
    assert.deepEqual((await store.review()).selected,null);
    const pending=(await store.listSuggestions()).find(item=>item.id===id)!;
    assert.equal(pending.status,"queued");
    assert.equal(pending.reason,"Awaiting individual review.");
    assert.equal(pending.text,text);
    assert.equal(await store.setSuggestionReview(id,{status:"accepted",reason:"Useful for testing copy verification.",topic:"archive-copies"}),true);
    assert.equal((await store.listResearchCandidates()).candidates[0]?.id,id);
    const related=await store.enqueue({programme:"continuity",text:"Review recovery of separate archive backups."});
    await store.setSuggestionReview(related,{status:"accepted",reason:"Related recovery question.",topic:"archive-copies"});
    assert.equal((await store.listResearchCandidates()).candidates[0]?.relatedCount,2);
    const audit="Nt6E2S6U9msi5G7Ulufy";
    const db=new DatabaseSync(path);
    db.prepare("INSERT INTO inbox(id,programme,text,status,submitted) VALUES(?,?,?,?,?)")
      .run(audit,"continuity","A historical audit suggestion remains in the private inbox.","queued",Date.now());
    assert.equal(await store.setSuggestionReview(audit,{status:"accepted",reason:"Excluded from research."}),false);
    assert.equal((await store.review()).reviewed,0);
    assert.equal((await store.listResearchCandidates()).candidates.length,2);
    assert.ok((await store.listSuggestions()).some(item=>item.id===audit));
    await store.setSuggestionReview(related,{status:"rejected",reason:"Insufficient evidence for this proposal."});
    const updated=(await store.listSuggestions()).find(item=>item.id===related)!;
    assert.equal(updated.status,"rejected");
    assert.equal(updated.history.length,2);
    // Keep the existing seven-day raw inbox retention while preserving the minimized ledger.
    db.prepare("UPDATE inbox SET submitted=? WHERE id=?").run(Date.now()-8*86_400_000,id);
    await store.enqueue({programme:"heritage",text:"A new question about preservation methods."});
    const retained=(await store.listSuggestions()).find(item=>item.id===id)!;
    assert.equal(retained.text,undefined);
    assert.equal(retained.resourceUrl,undefined);
    assert.equal(retained.status,"accepted");
    assert.equal(retained.history.length,1);
    db.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("private review endpoint is disabled by default and requires its bearer secret",async()=>{
  const dir=await mkdtemp(join(process.cwd(),".suggestion-api-test-"));
  const previous={...process.env};
  process.env.COMMAND_STORE="sqlite";
  process.env.COMMAND_SQLITE_PATH=join(dir,"routes.sqlite");
  delete process.env.COMMAND_REVIEW_TOKEN;
  const {default:app}=await import("../src/app");
  const server=app.listen(0,"127.0.0.1");
  try {
    await new Promise<void>(resolve=>server.once("listening",resolve));
    const address=server.address();
    assert.ok(address && typeof address!=="string");
    const endpoint=`http://127.0.0.1:${address.port}/api/command/private/suggestions`;
    assert.equal((await fetch(endpoint)).status,404);
    process.env.COMMAND_REVIEW_TOKEN=randomBytes(32).toString("base64url");
    assert.equal((await fetch(endpoint,{headers:{authorization:"invalid"}})).status,404);
    const response=await fetch(endpoint,{headers:{authorization:["Bearer",process.env.COMMAND_REVIEW_TOKEN].join(" ")}});
    assert.equal(response.status,200);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.deepEqual(await response.json(),{suggestions:[],nextCursor:null});
    const root=`http://127.0.0.1:${address.port}/api/command`;
    const text="Compare two independently stored archive copies.";
    const resourceUrl="https://example.org/private-reference";
    const submitted=await fetch(`${root}/suggestions`,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({programme:"continuity",text,resourceUrl})});
    const receipt=await submitted.json() as {id:string};
    assert.equal(submitted.status,202);
    const lookup=()=>fetch(`${root}/suggestions/status`,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({id:receipt.id})});
    assert.deepEqual(await (await lookup()).json(),{status:"queued",reason:"Awaiting individual review."});
    const privateReason="Private evaluation details must never appear publicly.";
    const decided=await fetch(`${root}/PRIVATE/Suggestions/${receipt.id}/`,{method:"PATCH",
      headers:{"content-type":"application/json",authorization:["Bearer",process.env.COMMAND_REVIEW_TOKEN].join(" ")},
      body:JSON.stringify({status:"accepted",reason:privateReason,topic:"archive-copies"})});
    assert.equal(decided.status,200);
    const publicStatus=await lookup();
    assert.equal(publicStatus.headers.get("cache-control"),"no-store");
    const publicBody=await publicStatus.text();
    assert.deepEqual(JSON.parse(publicBody),{status:"accepted",reason:"Individually reviewed; awaiting item-specific research."});
    assert.ok(!publicBody.includes(privateReason) && !publicBody.includes(text) && !publicBody.includes(resourceUrl));
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    process.env=previous;
    await rm(dir,{recursive:true,force:true});
  }
});
