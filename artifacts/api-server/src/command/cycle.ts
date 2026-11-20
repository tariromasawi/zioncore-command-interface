import { randomUUID } from "node:crypto";
import type { CommandFeed, CommandRun } from "@workspace/api-zod";
import { archiveExercise, benchmark, blankEngines, checkOpportunity, engineResults, makeResearch, sha } from "./engines";
import { configuredModels, genesisStatus } from "./genesis";
import { compareInventory, researchDaily } from "./dailyResearch";
import { continuityMethodId, continuityMethodVersion, evaluateContinuityMethod, evaluateEvolutionMethod, evolutionMethodId, evolutionMethodVersion, learnContinuity, learnEvolution } from "./knowledge";
import type { CommandStore } from "./store";

export const periodMs=15*60_000;
export type CycleKind="preview"|"scheduled"|"daily-review"|"archive-exercise"|"internal-replay";

export async function runCycle(store:CommandStore, kind:CycleKind, now=new Date(), opportunityCheck=checkOpportunity,
  gateway:{env?:NodeJS.ProcessEnv;request?:typeof fetch}={}) {
  const slot=kind==="archive-exercise" ? "archive-exercise-v1" : kind==="daily-review" ?
    `daily-${now.toISOString().slice(0,10)}` : kind==="internal-replay" ?
    `internal-replay-${randomUUID()}` : `${kind}-${new Date(Math.floor(+now/periodMs)*periodMs).toISOString().replace(/[:.]/g,"-")}`;
  const prior=await store.list();
  const savedEntries=await store.knowledge();
  const savedMethod=savedEntries.find(item=>item.methodId===continuityMethodId && item.version===continuityMethodVersion && item.status==="verified");
  const savedEvolution=savedEntries.find(item=>item.methodId===evolutionMethodId && item.version===evolutionMethodVersion && item.status==="verified");
  const lease=await store.claim(slot);
  if (!lease) return null;
  const b=benchmark();
  const [archive, opportunity, inbox] = await Promise.allSettled([
    archiveExercise(kind==="archive-exercise"),opportunityCheck(),store.review(),
  ]);
  const a=archive.status==="fulfilled"?archive.value:undefined;
  const signal=opportunity.status==="fulfilled"?opportunity.value:"Source could not be reached during this run";
  const processed=inbox.status==="fulfilled"?inbox.value.reviewed:0;
  const popular=inbox.status==="fulfilled"?Object.entries(inbox.value.programmeCounts)
    .filter(([,count])=>count>=3).sort(([leftName,left],[rightName,right])=>right-left||leftName.localeCompare(rightName))[0]?.[0]??null:null;
  const suggestedDay:Record<string,number>={continuity:0,preparedness:0,heritage:1,prosperity:3};
  const research=makeResearch(popular?suggestedDay[popular]!:Math.floor(+now/86_400_000),b,a,signal);
  if(popular)research.evidence.push({label:"Anonymous research direction",
    detail:`This programme was selected from an aggregate of at least three private suggestions. Submitted text and authors are not published.`});
  const method=savedMethod??learnContinuity(lease.id,now);
  const evaluation=await evaluateContinuityMethod(method,`${lease.id}-${now.toISOString()}`)
    .then(value=>({outcome:"passed" as const,value}))
    .catch(()=>({outcome:"failed" as const,value:null}));
  const evolution=savedEvolution??learnEvolution(lease.id,now);
  const evolutionResult=await Promise.resolve().then(()=>evaluateEvolutionMethod(evolution))
    .then(value=>({outcome:"passed" as const,value}))
    .catch(()=>({outcome:"failed" as const,value:null}));
  const missionPassed=evaluation.outcome==="passed"&&evolutionResult.outcome==="passed";
  const env=gateway.env??process.env;
  const daily=await researchDaily({kind,runId:slot,models:configuredModels(env),ledger:store,env,
    request:gateway.request??fetch});
  const ai={...daily,status:daily.record?"measured" as const:"blocked" as const};
  const expectedSeedChecksum=env.COMMAND_GENESIS_SHA256;
  const storedResearch=(kind==="internal-replay" || kind==="scheduled") && expectedSeedChecksum
    && /^[a-f0-9]{64}$/.test(expectedSeedChecksum)
    ? (await store.dailyResearch()).find(record=>record.seedChecksum===expectedSeedChecksum) : undefined;
  const digest=sha(`synthetic inventory ${lease.id}`);
  const replayPassed=storedResearch && compareInventory(storedResearch,
    [{id:"first",digest},{id:"second",digest:"other"}],
    [{id:"second",digest:"other"},{id:"first",digest}])
    && !compareInventory(storedResearch,[{id:"first",digest}],[{id:"first",digest:"changed"}]);
  const methodEvidence=method.evidence;
  const retainedResearch={
    title:method.title,programme:method.programme,hypothesis:"A stored, checksum-verified preservation method will correctly check a fresh synthetic fixture.",
    method:method.method,result:evaluation.outcome==="passed"
      ?`Internal replay ${savedMethod?"reused stored knowledge":"verified the initial local method"} on a fresh fixture. Verified SHA-256 ${evaluation.value!.checksum}. No external model call.`
      :"The stored method failed its fresh verification; it is marked failed and will not be reused.",
    failedApproach:"Restoring without validating both an independent mirror and the staged bytes is rejected.",
    next:"Keep testing the stored method with new synthetic cases, then extend the same save–replay–verify loop to other bounded engines.",
    evidence:methodEvidence,
  };
  const run:CommandRun={
    id:slot,kind,startedAt:now.toISOString(),finishedAt:new Date().toISOString(),
    outcome:!a || !missionPassed || !b.rolledBack || !b.promoted || inbox.status==="rejected" || (storedResearch&&!replayPassed)?"partial":"completed",
    learning:{
      tracking:"measured",
      mission:"archive-continuity-integrity",
      methodId:method.methodId,
      methodVersion:method.version,
      knowledgeId:method.id,
      knowledgeReused:!!savedMethod&&!!savedEvolution,
      verification:missionPassed?"passed":"failed",
      externalAiMode:daily.externalAiCalls?"model":"disabled",
      externalAiCalls:daily.externalAiCalls,
      paidAiCalls:daily.paidAiCalls,
      paidCostMicros:daily.paidAiCalls || daily.unresolvedMicros ? null:0,
    },
    engines:engineResults({b,a,opportunity:signal,processed,suggestionDirection:popular,prior,kind,research,ai}),
    research:[retainedResearch,research,...(research.programme==="Prosperity"?[]:[makeResearch(3,b,a,signal)])],
    warnings:[
      ...(!a || a.restored?[{signal:a?"Synthetic primary SHA-256 mismatch":"Synthetic archive integrity check failed",
        source:"Isolated Command archive exercise",outcome:a?"A damaged primary would no longer match the trusted copy.":"Continuity could not be verified.",
        horizon:"Immediate",confidence:a?"Confirmed by hashes":"Unknown",action:a?"Stage the verified mirror, replace the test copy, and read back for verification.":"Investigate fixity; do not restore from an unverified mirror.",status:a?"Resolved — exercise":"Open"}]:[]),
      ...(signal.startsWith("Source checked")?[]:[{signal:signal,source:"GOV.UK business guidance",outcome:"The opportunity source could not be independently checked during this cycle.",horizon:"Before relying on the brief",confidence:"Source check only",action:"Try the original guide again and verify its current terms.",status:"Open"}]),
    ],
    advice:[
      {title:"Verify before restoring",why:"A damaged file can have the same name and still contain different bytes.",action:"Keep an independent copy and compare both against a trusted hash before replacing anything.",uncertainty:"A synthetic test does not prove the condition of any real archive."},
      {title:"Separate estimates from receipts",why:"Price forecasts do not measure earnings.",action:"Use the pricing prototype to set a pilot quote and reconcile only authorized receipts when connected.",uncertainty:"Demand, margins and receipts are not verified."},
    ],
  };
  if(daily.unresolvedMicros || daily.paidAiCalls || daily.costMicros) {
    run.engines.find(item=>item.id==="divine-ai-instances")?.evidence.push({
      label:"Paid AI cost uncertainty",
      detail:`Settled usage estimate: ${daily.costMicros} USD micros; unresolved reservations: ${daily.unresolvedMicros} USD micros. Reservations are not charges. Actual provider billing is unknown and requires reconciliation.`,
    });
  }
  const record=daily.record??storedResearch;
  if(record) run.research.push({
    title:"AI-selected synthetic inventory comparison",programme:"Continuity",
    hypothesis:"Matching stable identifiers handles reordered inventories and detects changed digests.",
    method:"Use the validated match-by-id comparison; model output is not executable.",
    result:daily.record
      ? `Validated daily research record ${record.id}, version ${record.version}; initial synthetic checks passed.`
      : `Reused daily research record ${record.id}, version ${record.version} on fresh synthetic inventories: ${replayPassed?"passed":"failed"}. No AI calls.`,
    failedApproach:"Position-only comparisons can misidentify reordered items.",
    next:"Repeat with authorized synthetic fixtures; this does not establish real archive integrity.",
    evidence:[],
  });
  await store.complete(lease,run,[{entry:method,outcome:evaluation.outcome},{entry:evolution,outcome:evolutionResult.outcome}],daily.record);
  return run;
}

// Explicit allowlists; never send persistence records, inbox text, or raw errors to visitors.
const projectEvidence=(e:CommandRun["engines"][number]["evidence"][number])=>({
  label:e.label,detail:e.detail,...(e.url && /^https:\/\/(?:www\.gov\.uk|www\.who\.int|ich\.unesco\.org|ndsa\.org)\/|^\/continuity$/.test(e.url)?{url:e.url}:{}),
});
export function projectRun(r:CommandRun):CommandRun {
  return {
    id:r.id,kind:r.kind,startedAt:r.startedAt,finishedAt:r.finishedAt,outcome:r.outcome,
    learning:r.learning,
    engines:r.engines.map(({id,name,programme,status,metric,detail,evidence})=>({id,name,programme,status,metric,detail,evidence:evidence.map(projectEvidence)})),
    research:r.research.map(({title,programme,hypothesis,method,result,failedApproach,next,evidence})=>({title,programme,hypothesis,method,result,failedApproach,next,evidence:evidence.map(projectEvidence)})),
    warnings:r.warnings.map(({signal,source,outcome,horizon,confidence,action,status})=>({signal,source,outcome,horizon,confidence,action,status})),
    advice:r.advice.map(({title,why,action,uncertainty})=>({title,why,action,uncertainty})),
  };
}

export async function getFeed(store:CommandStore):Promise<CommandFeed> {
  const runs=(await store.list()).map(projectRun);
  const latest=runs.find(r=>r.kind==="scheduled") ?? runs.find(r=>r.kind!=="archive-exercise");
  const lastScheduled=runs.find(r=>r.kind==="scheduled");
  const state=!latest?"blocked":!store.production?"example":
    !lastScheduled?"blocked":Date.now()-Date.parse(lastScheduled.startedAt)>periodMs*2?"stale":"live";
  const engines=(latest??runs[0])?.engines ?? blankEngines();
  const knowledge=await store.knowledge();
  const metrics=await store.allRunMetrics();
  const latestMethod=[...knowledge].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.version.localeCompare(a.version))[0];
  // Keep daily AI provenance available on the overview as well as the daily run.
  const daily=runs.find(r=>r.kind==="daily-review")?.engines.find(e=>e.id==="divine-ai-instances");
  return {
    state,
    cadence:store.production?"Configured: every 15 minutes; daily research review at 00:05 UTC.":"Preview runs only — production scheduling has not been verified.",
    nextExpected:store.production?new Date(Math.floor(Date.now()/periodMs)*periodMs+periodMs).toISOString():null,
    genesis:await genesisStatus(),engines:(daily ? engines.map(e=>e.id===daily.id?daily:e) : engines).map(e=>
      e.id==="divine-ai-instances"?{...e,evidence:[...e.evidence,{label:"Monthly paid AI cost",
        detail:`Settled usage estimates: ${metrics.monthlyPaidAiSpendMicros} USD micros; unresolved reservations: ${metrics.monthlyPaidAiReservedMicros} USD micros. Reservations are not charges; provider billing is not reconciled.`}]}:e),runs,
    knowledge,
    learning:{
      internalMissionRuns:metrics.internalMissionRuns,
      externallyAssistedRuns:metrics.externallyAssistedRuns,
      paidAiCalls:metrics.paidAiCalls,
      externalAiDisabledForMission:true,
      paidAiCallsAvoided:metrics.internalMissionRuns,
      latestMethodVersion:latestMethod?.version??"not yet verified",
      billingPeriod:metrics.billingPeriod,
      monthlyPaidAiSpendMicros:metrics.monthlyPaidAiSpendMicros,
      monthlyPaidAiReservedMicros:metrics.monthlyPaidAiReservedMicros,
      monthlyPaidAiCostStatus:metrics.monthlyPaidAiRequests || metrics.monthlyPaidAiSpendMicros || metrics.monthlyPaidAiReservedMicros ? "unreconciled":"none-recorded",
      monthlyPaidAiRequests:metrics.monthlyPaidAiRequests,
      monthlyPaidAiAllowanceMicros:metrics.monthlyPaidAiAllowanceMicros,
    },
  };
}
