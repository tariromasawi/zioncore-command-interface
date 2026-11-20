import type { CommandFeed, CommandRun } from "@workspace/api-zod";
import { archiveExercise, benchmark, blankEngines, checkOpportunity, engineResults, makeResearch } from "./engines";
import { askGenesis, configuredModels, genesisStatus, loadSeed } from "./genesis";
import type { CommandStore } from "./store";

export const periodMs=15*60_000;
export type CycleKind="preview"|"scheduled"|"daily-review"|"archive-exercise";

export async function runCycle(store:CommandStore, kind:CycleKind, now=new Date(), opportunityCheck=checkOpportunity) {
  const slot=kind==="archive-exercise" ? "archive-exercise-v1" : kind==="daily-review" ?
    `daily-${now.toISOString().slice(0,10)}` : `${kind}-${new Date(Math.floor(+now/periodMs)*periodMs).toISOString().replace(/[:.]/g,"-")}`;
  const prior=await store.list();
  const lease=await store.claim(slot);
  if (!lease) return null;
  const b=benchmark();
  const [archive, opportunity, inbox] = await Promise.allSettled([
    archiveExercise(kind==="archive-exercise"),opportunityCheck(),store.review(),
  ]);
  const a=archive.status==="fulfilled"?archive.value:undefined;
  const signal=opportunity.status==="fulfilled"?opportunity.value:"Source could not be reached during this run";
  const processed=inbox.status==="fulfilled"?inbox.value:0;
  const research=makeResearch(Math.floor(+now/86_400_000),b,a,signal);
  const ai=kind==="daily-review" ?
    await askGenesis({seed:await loadSeed(),models:configuredModels(),ledger:store,cap:Number(process.env.COMMAND_MONTHLY_AI_CAP_MICROS ?? "0")})
      .catch(()=>({status:"blocked" as const,note:"AI bookkeeping was unavailable. No further model calls were attempted."})) :
    {status:"blocked" as const,note:"This cycle is deterministic. Model requests, if enabled, run only during the daily review."};
  const run:CommandRun={
    id:slot,kind,startedAt:now.toISOString(),finishedAt:new Date().toISOString(),
    outcome:!a || !b.rolledBack || !b.promoted || inbox.status==="rejected"?"partial":"completed",
    engines:engineResults({b,a,opportunity:signal,processed,prior,kind,research,ai}),
    research:[research,...(research.programme==="Prosperity"?[]:[makeResearch(3,b,a,signal)])],
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
  await store.complete(lease,run);
  return run;
}

// Explicit allowlists; never send persistence records, inbox text, or raw errors to visitors.
const projectEvidence=(e:CommandRun["engines"][number]["evidence"][number])=>({
  label:e.label,detail:e.detail,...(e.url && /^https:\/\/(?:www\.gov\.uk|www\.who\.int|ich\.unesco\.org|ndsa\.org)\/|^\/continuity$/.test(e.url)?{url:e.url}:{}),
});
export function projectRun(r:CommandRun):CommandRun {
  return {
    id:r.id,kind:r.kind,startedAt:r.startedAt,finishedAt:r.finishedAt,outcome:r.outcome,
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
  // Keep daily AI provenance available on the overview as well as the daily run.
  const daily=runs.find(r=>r.kind==="daily-review")?.engines.find(e=>e.id==="divine-ai-instances");
  return {
    state,
    cadence:store.production?"Configured: every 15 minutes; daily research review at 00:05 UTC.":"Preview runs only — production scheduling has not been verified.",
    nextExpected:store.production?new Date(Math.floor(Date.now()/periodMs)*periodMs+periodMs).toISOString():null,
    genesis:await genesisStatus(),engines: daily ? engines.map(e=>e.id===daily.id?daily:e) : engines,runs,
  };
}
