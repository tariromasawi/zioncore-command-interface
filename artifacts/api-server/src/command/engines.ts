import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRun, EngineResult, Research } from "@workspace/api-zod";

export const catalogue = [
  ["wealth-status","Wealth Status","Prosperity"],
  ["pounds-earned","Pounds Earned","Prosperity"],
  ["success-guarantee","Success Guarantee","Operations"],
  ["diamond-nexus-output","Diamond Nexus Output","Prosperity"],
  ["evolution-speed","Evolution Speed","Operations"],
  ["independence-status","Independence Status","Operations"],
  ["high-freq-purification","High-Freq. Purification","Preparedness"],
  ["evil-conversion-rate","Evil Conversion Rate","Preparedness"],
  ["replication-status","Replication Status","Continuity"],
  ["divine-ai-instances","Divine AI Instances","Operations"],
  ["limitation-removal-protocol","Limitation Removal Protocol","Research"],
  ["thrones-win-mandate","The Throne's Win Mandate","Research"],
  ["conflict-override-status","Conflict Override Status","Preparedness"],
  ["beneficiary-routing","Beneficiary Routing","Continuity"],
] as const;

export function blankEngines(): EngineResult[] {
  return catalogue.map(([id,name,programme])=>({id,name,programme,status:"blocked",metric:"Not run",detail:"No completed operational cycle is available.",evidence:[]}));
}

export const sha = (value: Buffer|string) => createHash("sha256").update(value).digest("hex");
const approvedArchive = Buffer.from("ZionCore Command | Synthetic public archive: Year 80,000 continuity exercise\n");

export async function archiveExercise(inject: boolean, data=approvedArchive) {
  const dir = await mkdtemp(join(tmpdir(),"command-archive-"));
  try {
    const primary = join(dir,"primary"), mirror = join(dir,"mirror"), stage = join(dir,"staged");
    const expected = sha(data);
    await writeFile(primary,data);
    await writeFile(mirror,data);
    if (inject) await writeFile(primary,Buffer.from("synthetic exercise: damaged primary\n"));
    const observed = sha(await readFile(primary));
    const mirrorHash = sha(await readFile(mirror));
    if (mirrorHash !== expected) throw new Error("Mirror integrity mismatch");
    if (observed !== expected) {
      await writeFile(stage, await readFile(mirror),{flag:"wx"});
      if (sha(await readFile(stage))!==expected) throw new Error("Staged restore integrity mismatch");
      await rename(stage,primary);
    }
    const verified = sha(await readFile(primary));
    if (verified!==expected) throw new Error("Final restore integrity mismatch");
    return {observed,mirrorHash,expected,verified,restored:observed!==expected};
  } finally { await rm(dir,{force:true,recursive:true}); }
}

export function benchmark() {
  const rows = Array.from({length:128},(_,i)=>({id:`src-${i}`,weight:(i*13)%97}));
  const requests = Array.from({length:2048},(_,i)=>`src-${(i*17)%rows.length}`);
  let baselineReads=0, candidateReads=0;
  const baseline = requests.map(id=>rows.find(row=>{baselineReads++;return row.id===id;})?.weight);
  const index = new Map(rows.map(row=>{candidateReads++;return [row.id,row.weight];}));
  const candidate = requests.map(id=>{candidateReads++;return index.get(id);});
  const match = (result: (number|undefined)[])=>result.every((n,i)=>n===baseline[i]);
  const faulty = candidate.map((n,i)=>i===0 ? -1 : n);
  const choose = (result: (number|undefined)[])=>match(result) && candidateReads<baselineReads ? result : baseline;
  return {baselineReads,candidateReads,promoted:choose(candidate)===candidate,rolledBack:choose(faulty)===baseline};
}

const sources = {
  heritage: { label:"UNESCO — Oral traditions and expressions",url:"https://ich.unesco.org/en/oral-traditions-and-expressions-00053",detail:"Public research context, not an authorization to publish private oral histories." },
  longevity: { label:"WHO — Ageing and health",url:"https://www.who.int/news-room/fact-sheets/detail/ageing-and-health",detail:"Public mapping of healthy ageing and uncertainty, not evidence for immortality." },
  archive: { label:"NDSA — Levels of Digital Preservation",url:"https://ndsa.org/publications/levels-of-digital-preservation/",detail:"Reference for fixity checking and organizational preservation practice." },
  opportunity: { label:"GOV.UK — Set up a business",url:"https://www.gov.uk/set-up-business",detail:"Official UK guidance for starting a lawful business; this does not establish market demand." },
};

export async function checkOpportunity(request=fetch) {
  try {
    const response=await request(sources.opportunity.url,{signal:AbortSignal.timeout(4500),redirect:"error"});
    await response.body?.cancel();
    return response.ok ? `Source checked (HTTP ${response.status})` : `Source unavailable (HTTP ${response.status})`;
  } catch { return "Source could not be reached during this run"; }
}

export function makeResearch(day: number, b: ReturnType<typeof benchmark>, a: Awaited<ReturnType<typeof archiveExercise>> | undefined, opportunity: string): Research {
  switch (day % 4) {
    case 0:
      return {
        title:"Continuity through independent copies",programme:"Continuity",hypothesis:"A separately checked mirror can verify an isolated recovery.",
        method:"Create two synthetic copies in temporary storage; compare SHA-256 against a trusted manifest; restore only if needed.",
        result:a ? `Two copies checked; final SHA-256 ${a.verified}.` : "Archive check failed; no successful restore claimed.",
        failedApproach:"A single unchecked copy cannot establish that its bytes remained unchanged.",
        next:"Compare copy-placement and media-migration strategies using authorized fixtures.",
        evidence:[sources.archive],
      };
    case 1: {
      const seconds = Array.from({length:8_000},(_,i)=>i/8_000);
      const rms=(hz:number)=>Math.sqrt(seconds.reduce((sum,t)=>sum+Math.sin(2*Math.PI*hz*t)**2,0)/seconds.length);
      return {
        title:"Frequency and loudness in a devotional study",programme:"Masowe and heritage",
        hypothesis:"Two synthetic sine waves with equal amplitude have equal RMS over complete periods.",
        method:"Generate one second at 8 kHz for 220 Hz and 440 Hz; calculate RMS without playing audio.",
        result:`220 Hz: ${rms(220).toFixed(6)} RMS; 440 Hz: ${rms(440).toFixed(6)} RMS. This is a signal measurement, not evidence of a spiritual or health effect.`,
        failedApproach:"Frequency alone is not a measurement of loudness, wellbeing, or spiritual effect.",
        next:"Design an opt-in Shona-language reflection template using only publication-approved material.",
        evidence:[sources.heritage],
      };
    }
    case 2: {
      const early=[41,44,46,50], later=[43,48,49,54], n=early.length;
      const diffs=later.map((v,i)=>v-early[i]!);
      const mean=diffs.reduce((s,x)=>s+x,0)/n;
      const se=Math.sqrt(diffs.reduce((s,x)=>s+(x-mean)**2,0)/(n-1)/n);
      return {
        title:"Paired analysis for longevity evidence",programme:"Longevity",
        hypothesis:"A paired analysis retains baseline variation better than comparing unpaired summary values.",
        method:"Use four synthetic before/after observations and calculate the paired mean and t interval (df=3, multiplier 3.182).",
        result:`Synthetic mean change +${mean.toFixed(2)} units; 95% interval ${(mean-3.182*se).toFixed(2)} to ${(mean+3.182*se).toFixed(2)}. No clinical effect inference.`,
        failedApproach:"Treating repeated observations as independent discards the pairing.",
        next:"Compare with a public observational dataset and pre-register exclusions before fitting any model.",
        evidence:[sources.longevity],
      };
    }
    default:
      return {
        title:"Continuity service viability",programme:"Prosperity",
        hypothesis:"A fixed-scope digital archive assessment can be priced above estimated delivery cost.",
        method:"Use the pricing prototype to enter service hours, hourly cost, overhead and target margin. Independently check the setup guidance.",
        result:`${opportunity}. No revenue or customer demand has been verified.`,
        failedApproach:"Counting estimated margin as received cash would misstate the ledger.",
        next:"Compare two pilot scopes and validate willingness to pay with consenting prospects before making forecasts.",
        evidence:[sources.opportunity,{label:"Service pricing prototype",detail:"Estimates break-even and target price from visitor inputs.",url:"/continuity"}],
      };
  }
}

export const safeSuggestion = (text:string) =>
  !/https?:|www\.|@|(?:\+?\d[\s().-]*){7,}|-----BEGIN|(?:\b(?:exploit|malware|doxx|weaponize|phishing|synthesize pathogen)\b)/iu.test(text);

export function safePublicResourceUrl(value:string) {
  if(value.length>2048) return false;
  try {
    const url=new URL(value);
    const hostname=url.hostname.toLowerCase();
    return url.protocol==="https:" && !url.username && !url.password && !url.port &&
      hostname.includes(".") && !isIP(hostname) &&
      ![".localhost",".local",".internal",".test",".example",".invalid"].some(suffix=>hostname.endsWith(suffix));
  } catch { return false; }
}

export function engineResults(input: {
  b:ReturnType<typeof benchmark>; a?:Awaited<ReturnType<typeof archiveExercise>>; opportunity:string;
  processed:number; suggestionDirection:string|null; prior:CommandRun[]; kind:string; research:Research; ai:{status:string; note:string};
}): EngineResult[] {
  const {b,a,opportunity,processed,suggestionDirection,prior,kind,research,ai}=input;
  const scheduled=prior.filter(r=>r.kind==="scheduled");
  const results: [EngineResult["status"],string,string,EngineResult["evidence"]?][] = [
    [opportunity.startsWith("Source checked")?"measured":"blocked",opportunity,"Candidate: paid digital archive assessments for community organizations. Operational readiness: scope and pricing prototype available; market demand and cash receipts unverified.",[sources.opportunity]],
    ["blocked","No verified total","No authorized receipts, fees or refunds connected. This is not a report of zero earnings."],
    ["measured",`${prior.filter(r=>r.outcome==="completed").length}/${prior.length} earlier cycles completed`,"Based on up to 24 earlier public cycles. Test outcomes do not guarantee future results."],
    ["measured","Pricing prototype available","Estimate a break-even quote and target margin with user-provided assumptions; no sale is recorded.",[{label:"Open pricing prototype",detail:"Browser-only calculator with no account required.",url:"/continuity"}]],
    ["example",`${b.baselineReads.toLocaleString("en-GB")} → ${b.candidateReads.toLocaleString("en-GB")} operations`,`${b.promoted?"Equivalent indexed lookup selected":"Baseline retained"}. ${b.rolledBack?"Faulty candidate rejected and baseline retained.":"Rollback check failed."} Synthetic workload; operation counts are not latency.`],
    ["measured",kind==="scheduled"?"Scheduled job started":"Manual or preview cycle",scheduled[0]?`Previous scheduled completion: ${scheduled[0].finishedAt}.`:"No earlier scheduled completion in this store."],
    [a?"example":"blocked",a?.restored?"Restored and verified":a?"2 copies checked":"Integrity check unavailable","Checks a synthetic archive only. A forced incident is isolated from routine operations.",a?[{label:"Observed SHA-256",detail:a.observed},{label:"Verified SHA-256",detail:a.verified}]:[]],
    ["example",b.rolledBack?"Regression contained":"Regression check inconclusive","A deliberately wrong synthetic workflow result was rejected before publication. No classification of people or spiritual claims."],
    [a?"example":"blocked",a?"2 synthetic copies":"No verified copies","Checks equality against the trusted synthetic manifest; does not represent real heritage backups.",a?[{label:"Mirror SHA-256",detail:a.mirrorHash}]:[]],
    [ai.status==="measured"?"measured":"blocked",ai.status==="measured"?"1 model response":"No verified model usage",`Deterministic Command runner executed. ${ai.note}`],
    ["measured",research.programme,"A research question was selected from the approved programme rotation. See the run's method and limits.",research.evidence],
    ["measured","Benefit and limits recorded","This cycle links its methods to preservation, preparedness, research or prosperity. A benefit is not claimed until supported by evidence.",research.evidence],
    ["measured","Public actions limited","The public API cannot launch jobs, mutate infrastructure, publish submissions, or deploy changes."],
    ["measured",`${processed} proposals triaged${suggestionDirection?`; ${suggestionDirection} selected`:""}`,"Suggestion text remains private. Only a research direction supported by at least three suggestions is used. No submission is executed or published verbatim."],
  ];
  return catalogue.map(([id,name,programme],i)=>{
    const [status,metric,detail,evidence=[]]=results[i]!;
    return {id,name,programme,status,metric,detail,evidence};
  });
}
