import { randomUUID } from "node:crypto";
import { loadSeed, paidAiMonthlyCap, type Model } from "./genesis";
import { sha } from "./engines";
import type { CommandStore } from "./store";

const task = 'A public synthetic archive inventory must compare the same items despite changes in ordering and detect altered digests. Choose one audited comparison strategy: match-by-id or match-by-position. Return a JSON object with exactly version (number 1) and method (the chosen strategy), without prose or tools.';
const version = 1;
const method = "match-by-id";
const outputLimit = 256;
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;

export type DailyResearchRecord = {
  id:string; version:1; method:"match-by-id"; sourceRunId:string;
  seedChecksum:string; model:string;
};

function identity(record:Omit<DailyResearchRecord,"id">) {
  return sha(JSON.stringify(["daily-research",record.version,record.method,record.sourceRunId,record.seedChecksum,record.model]));
}

export function validDailyRecord(value:unknown):value is DailyResearchRecord {
  if(!value || typeof value!=="object" || Array.isArray(value)) return false;
  const r=value as DailyResearchRecord;
  return Object.keys(r).sort().join(",")==="id,method,model,seedChecksum,sourceRunId,version"
    && r.version===version && r.method===method && /^daily-\d{4}-\d{2}-\d{2}$/.test(r.sourceRunId)
    && /^[a-f0-9]{64}$/.test(r.seedChecksum) && /^gemini-[a-zA-Z0-9.-]+$/.test(r.model)
    && r.id===identity(r);
}

// Only this audited implementation is selectable; provider text is never executed.
export function compareInventory(record:DailyResearchRecord, left:{id:string;digest:string}[], right:{id:string;digest:string}[]) {
  if(!validDailyRecord(record)) throw new Error("Invalid daily research record");
  if(new Set(left.map(x=>x.id)).size!==left.length || new Set(right.map(x=>x.id)).size!==right.length)
    throw new Error("Duplicate inventory identifier");
  const index=new Map(right.map(x=>[x.id,x.digest]));
  return left.length===right.length && left.every(x=>index.get(x.id)===x.digest);
}

export async function researchDaily({kind,runId,models,ledger,env,request}:{
  kind:string;runId:string;models:Model[];ledger:Pick<CommandStore,"reserve"|"settle">;
  env:NodeJS.ProcessEnv;request?:typeof fetch;
}):Promise<{record?:DailyResearchRecord;note:string;externalAiCalls:number;paidAiCalls:number;costMicros:number;unresolvedMicros:number}> {
  let externalAiCalls=0,paidAiCalls=0,costMicros=0,unresolvedMicros=0;
  const result=(note:string,record?:DailyResearchRecord)=>({note,record,externalAiCalls,paidAiCalls,costMicros,unresolvedMicros});
  if(!request)
    return result("No authorized provider transport is available.");
  if(kind!=="daily-review" || env.COMMAND_ENABLE_GENESIS_AI!=="1" || env.COMMAND_ENABLE_DAILY_GENESIS!=="1"
    || !/^daily-\d{4}-\d{2}-\d{2}$/.test(runId))
    return result("Daily AI research is disabled for this run.");
  const seed=await loadSeed(env);
  if(!seed) return result("Approved Genesis bytes could not be verified.");
  const executionCap=Number(env.COMMAND_PAID_AI_EXECUTION_CAP_MICROS);
  const cap=integer(executionCap)&&executionCap>0&&executionCap<=50_000?executionCap:0;
  const monthlyCap=paidAiMonthlyCap(env);
  const seenKeys=new Set<string>();
  for(const model of models) {
    if(!/^gemini-[a-zA-Z0-9.-]+$/.test(model.name) || !model.key || seenKeys.has(model.key)
      || !integer(model.context) || model.context<=outputLimit || !integer(model.inputMicrosPerMillion)
      || !integer(model.outputMicrosPerMillion) || !integer(model.billableOutputLimit??outputLimit)
      || (model.billableOutputLimit??outputLimit)<outputLimit || (model.billableOutputLimit??outputLimit)>model.context
      || (model.tier==="free" && (model.inputMicrosPerMillion!==0 || model.outputMicrosPerMillion!==0))
      || (model.tier==="paid" && (!cap || !monthlyCap || !model.inputMicrosPerMillion || !model.outputMicrosPerMillion))
      || !["free","paid"].includes(model.tier)) continue;
    seenKeys.add(model.key);
    const bound=Math.ceil(model.context*(model.inputMicrosPerMillion+model.outputMicrosPerMillion)/1_000_000);
    if(!integer(bound) || (model.tier==="paid" && (!bound || bound>cap))) continue;
    const payload={systemInstruction:{parts:[{text:seed.text}]},contents:[{role:"user",parts:[{text:task}]}],generationConfig:{maxOutputTokens:outputLimit}};
    const send=async(endpoint:string,body:object)=>{
      const current=await loadSeed(env);
      if(!current || current.text!==seed.text || current.checksum!==seed.checksum || current.version!==seed.version)
        throw new Error("seed-changed");
      externalAiCalls++;
      if(model.tier==="paid" && endpoint==="generateContent")paidAiCalls++;
      return request(`https://generativelanguage.googleapis.com/v1beta/models/${model.name}:${endpoint}`,{
        method:"POST",redirect:"error",headers:{"content-type":"application/json","x-goog-api-key":model.key},
        body:JSON.stringify(body),signal:AbortSignal.timeout(12_000),
      });
    };
    const countId=randomUUID();
    if(model.tier==="paid" && !await ledger.reserve(countId,bound,monthlyCap,runId,cap)) continue;
    if(model.tier==="paid")unresolvedMicros+=bound;
    let count:number;
    try {
      const response=await send("countTokens",{generateContentRequest:{model:`models/${model.name}`,...payload}});
      if(!response.ok) {await response.body?.cancel();continue;}
      count=(await response.json() as {totalTokens:number}).totalTokens;
      if(!integer(count) || count===0 || count+(model.billableOutputLimit??outputLimit)>model.context) continue;
    } catch { continue; }
    // Count requests retain their conservative reservation: billing is not proven zero.
    for(let attempt=0;attempt<2;attempt++) {
      const id=randomUUID();
      if(model.tier==="paid" && !await ledger.reserve(id,bound,monthlyCap,runId,cap)) break;
      if(model.tier==="paid")unresolvedMicros+=bound;
      let sent=false;
      try {
        const response=await send("generateContent",payload);
        sent=true;
        if(!response.ok) {await response.body?.cancel();if(response.status<500)break;continue;}
        const data=await response.json() as {
          usageMetadata?:{promptTokenCount?:number;candidatesTokenCount?:number;thoughtsTokenCount?:number};
          promptFeedback?:{blockReason?:unknown};
          candidates?:{finishReason?:string;safetyRatings?:{blocked?:boolean}[];content?:{parts?:{text?:string;functionCall?:unknown}[]}}[];
        };
        const input=data.usageMetadata?.promptTokenCount,output=data.usageMetadata?.candidatesTokenCount,thinking=data.usageMetadata?.thoughtsTokenCount??0;
        const usage=typeof input==="number"&&typeof output==="number"&&integer(input)&&input===count
          && integer(output)&&output>0&&integer(thinking)&&integer(output+thinking)
          && output+thinking<=(model.billableOutputLimit??outputLimit)&&input+output+thinking<=model.context;
        if(model.tier==="paid" && usage) {
          const amount=Math.ceil((input*model.inputMicrosPerMillion+(output+thinking)*model.outputMicrosPerMillion)/1_000_000);
          if(integer(amount)&&amount<=bound) {
            await ledger.settle(id,amount,input+output+thinking);
            unresolvedMicros-=bound;
            costMicros+=amount;
          }
        }
        const candidate=data.candidates?.[0],parts=candidate?.content?.parts;
        if(!usage || data.promptFeedback?.blockReason || data.candidates?.length!==1 || candidate?.finishReason!=="STOP"
          || candidate.safetyRatings?.some(x=>x.blocked) || parts?.length!==1 || parts[0]?.functionCall!==undefined
          || typeof parts[0]?.text!=="string" || parts[0].text.length>100) break;
        let parsed:unknown;
        try {parsed=JSON.parse(parts[0].text);} catch {break;}
        if(!parsed || typeof parsed!=="object" || Array.isArray(parsed)
          || Object.keys(parsed).sort().join(",")!=="method,version"
          || (parsed as {version:unknown}).version!==version || (parsed as {method:unknown}).method!==method) break;
        const body={version,method,sourceRunId:runId,seedChecksum:seed.checksum,model:model.name} as const;
        const record={...body,id:identity(body)};
        if(!compareInventory(record,[{id:"a",digest:"1"},{id:"b",digest:"2"}],[{id:"b",digest:"2"},{id:"a",digest:"1"}])
          || compareInventory(record,[{id:"a",digest:"1"}],[{id:"a",digest:"2"}])) break;
        return result("A constrained AI-selected inventory comparison was validated; no model text was published or executed.",record);
      } catch {
        // A failed request can have been billed. Keep its reservation.
        if(!sent) continue;
        break;
      }
    }
  }
  return result("No validated daily research result was obtained.");
}
