import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { sha } from "./engines";
import type { CommandStore } from "./store";

export const publishedCandidate = {
  version:"1.1.0",
  checksum:"8199eb2b080c6ac56f71443c1506173f8227dc9df58a145801b56e9e2fd538c6",
};
type Seed = { text:string; version:string; checksum:string };
export type Model = {
  name:string; tier:"free"|"paid"; key:string; context:number;
  inputMicrosPerMillion:number; outputMicrosPerMillion:number;
  billableOutputLimit?:number;
};
type AiResult = {status:"blocked"|"measured"; note:string; version?:string; checksum?:string; model?:string;tier?:"free"|"paid"; inputTokens?:number; outputTokens?:number; costMicros?:number;unresolvedMicros?:number;externalAiCalls:number;paidAiCalls:number};
const maxOutput = 256;
const task = "Classify this benign, public documentation research question: how should a library compare two authorized archive inventory methods? Return exactly inventory-comparison. Do not request actions or call tools.";
const validInt = (n:number) => Number.isSafeInteger(n) && n>=0;

export function paidAiMonthlyCap(env=process.env) {
  if(env.COMMAND_ENABLE_PAID_AI!=="1")return 0;
  const cap=Number(env.COMMAND_PAID_AI_MONTHLY_CAP_MICROS);
  return validInt(cap)&&cap>0?cap:0;
}

export function paidAiExecutionCap(env=process.env) {
  const cap=Number(env.COMMAND_PAID_AI_EXECUTION_CAP_MICROS);
  return validInt(cap)&&cap>0&&cap<=50_000?cap:0;
}

export async function loadSeed(env=process.env): Promise<Seed|null> {
  const path=env.COMMAND_GENESIS_PATH;
  const checksum=env.COMMAND_GENESIS_SHA256;
  const version=env.COMMAND_GENESIS_VERSION;
  if (!path || !checksum || !version || !/^[a-f0-9]{64}$/.test(checksum) || !/^[a-zA-Z0-9.-]{1,32}$/.test(version)) return null;
  try {
    const raw=await readFile(path);
    if (!raw.length || raw.length>1_000_000 || sha(raw)!==checksum) return null;
    const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(raw);
    if (!raw.equals(Buffer.from(text))) return null;
    return {text,version,checksum};
  } catch { return null; }
}

export async function genesisStatus() {
  const seed=await loadSeed();
  return seed ?
    {status:"approved",version:seed.version,checksum:seed.checksum,note:"Approved bytes verified in this runtime. Full text is not published by Command."} :
    {status:"blocked",...publishedCandidate,note:"Checksum is for the published TypeScript candidate, not an approved model payload. AI requires an owner-approved canonical file and matching checksum."};
}

export function configuredModels(env=process.env): Model[] {
  const models:Model[]=[];
  const hasApprovedSeedConfig=!!env.COMMAND_GENESIS_PATH
    &&!!env.COMMAND_GENESIS_SHA256&&/^[a-f0-9]{64}$/.test(env.COMMAND_GENESIS_SHA256)
    &&!!env.COMMAND_GENESIS_VERSION&&/^[a-zA-Z0-9.-]{1,32}$/.test(env.COMMAND_GENESIS_VERSION);
  const paidCap=hasApprovedSeedConfig&&paidAiExecutionCap(env)>0?paidAiMonthlyCap(env):0;
  for (const tier of ["free","paid"] as const) {
    if(tier==="paid"&&paidCap===0)continue;
    const prefix=`COMMAND_${tier.toUpperCase()}_MODEL_`;
    const name=env[prefix+"NAME"], key=tier==="free"?env.COMMAND_FREE_PROVIDER_KEY:env.COMMAND_PAID_PROVIDER_KEY;
    const context=Number(env[prefix+"CONTEXT"]);
    const inputMicrosPerMillion=tier==="free"?0:Number(env[prefix+"INPUT_MICROS_PER_MILLION"]);
    const outputMicrosPerMillion=tier==="free"?0:Number(env[prefix+"OUTPUT_MICROS_PER_MILLION"]);
    const billableOutputLimit=tier==="free"?maxOutput:Number(env[prefix+"BILLABLE_OUTPUT_LIMIT"]);
    if (name && /^gemini-[a-zA-Z0-9.-]+$/.test(name) && key && validInt(context) && context>maxOutput &&
        validInt(inputMicrosPerMillion) && validInt(outputMicrosPerMillion) &&
        validInt(billableOutputLimit) && billableOutputLimit>=maxOutput && billableOutputLimit<=context &&
        (tier==="free" || inputMicrosPerMillion>0 && outputMicrosPerMillion>0)) {
      models.push({name,key,context,tier,inputMicrosPerMillion,outputMicrosPerMillion,billableOutputLimit});
    }
  }
  // Never treat the same billing account as both free and paid.
  if (models.length===2 && models[0]?.key===models[1]?.key) return [];
  return models;
}

function cost(input:number, output:number, model:Model) {
  return Math.ceil((input*model.inputMicrosPerMillion+output*model.outputMicrosPerMillion)/1_000_000);
}

export async function askGenesis({
  kind, seed, models, ledger, cap, request=fetch, complex=false, env=process.env,
}: {
  kind:string;
  seed:Seed|null; models:Model[]; ledger:Pick<CommandStore,"reserve"|"settle">;
  cap?:number; request?:typeof fetch; complex?:boolean; env?:NodeJS.ProcessEnv;
}):Promise<AiResult> {
  if (kind!=="daily-review" || env.COMMAND_ENABLE_DAILY_GENESIS!=="1")
    return {status:"blocked",note:"Daily Genesis is not enabled for this run.",externalAiCalls:0,paidAiCalls:0};
  if (!seed || sha(seed.text)!==seed.checksum || !env.COMMAND_GENESIS_PATH
    || env.COMMAND_GENESIS_SHA256!==seed.checksum || env.COMMAND_GENESIS_VERSION!==seed.version)
    return {status:"blocked",note:"Canonical Genesis bytes have not been approved and verified.",externalAiCalls:0,paidAiCalls:0};
  const configuredCap=paidAiMonthlyCap(env);
  const executionCap=paidAiExecutionCap(env);
  const requestCap=cap===undefined?executionCap:Math.min(validInt(cap)?cap:0,executionCap);
  const ordered=complex ? [...models].sort((a,b)=>Number(b.tier==="paid")-Number(a.tier==="paid")) : models;
  // Every outbound request, including token count, uses the same isolated Seed field.
  const generateContentRequest={
    systemInstruction:{ parts:[{text:seed.text}] },
    contents:[{role:"user",parts:[{text:task}]}],
    generationConfig:{maxOutputTokens:maxOutput},
  };
  const failures=new Set<string>();
  let externalAiCalls=0,paidAiCalls=0,paidCostMicros=0,ambiguousMicros=0;
  const seedChanged=Symbol("seed-changed");
  for (const model of ordered) {
    if (!/^gemini-[a-zA-Z0-9.-]+$/.test(model.name) || !model.key ||
        !validInt(model.context) || model.context<=maxOutput ||
        !validInt(model.inputMicrosPerMillion) || !validInt(model.outputMicrosPerMillion) ||
        (model.tier!=="free" && model.tier!=="paid") ||
        (model.tier==="free" && (model.inputMicrosPerMillion!==0 || model.outputMicrosPerMillion!==0)) ||
        (model.tier==="paid" && (!model.inputMicrosPerMillion || !model.outputMicrosPerMillion ||
          !validInt(model.billableOutputLimit ?? maxOutput) || (model.billableOutputLimit ?? maxOutput)<maxOutput ||
          (model.billableOutputLimit ?? maxOutput)>model.context))) {
      failures.add("unsupported model configuration");continue;
    }
    if (model.tier==="paid" && (requestCap===0 || configuredCap===0)) {failures.add("paid budget disabled");continue;}
    const send=async (endpoint:string, body:object)=>{
      const current=await loadSeed(env);
      if (!current || current.text!==seed.text || current.checksum!==seed.checksum || current.version!==seed.version)
        throw seedChanged;
      externalAiCalls++;
      if(model.tier==="paid" && endpoint==="generateContent")paidAiCalls++;
      return request(
        `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:${endpoint}`,
        {method:"POST",redirect:"error",headers:{"content-type":"application/json","x-goog-api-key":model.key},body:JSON.stringify(body),signal:AbortSignal.timeout(12_000)},
      );
    };
    let count:number;
    const countReservationId=model.tier==="paid"?randomUUID():null;
    const firstGenerationId=model.tier==="paid"?randomUUID():null;
    let firstGenerationReserved=false;
    const releaseFirstGeneration=async()=>{
      if(firstGenerationReserved && firstGenerationId) {
        await ledger.settle(firstGenerationId,0,0);
        firstGenerationReserved=false;
      }
    };
    // A token-count reply does not itself prove a zero charge.
    const countReserve=cost(model.context,model.context,model);
    if(model.tier==="paid"&&(!validInt(countReserve)||!validInt(countReserve*2)||
      countReserve*2>requestCap-paidCostMicros-ambiguousMicros)) {
      failures.add("paid budget exhausted");
      continue;
    }
    if(model.tier==="paid"&&countReservationId
      &&!(await ledger.reserve(countReservationId,countReserve,configuredCap))) {
      failures.add("paid budget exhausted");
      continue;
    }
    if(model.tier==="paid"&&firstGenerationId) {
      if(!(await ledger.reserve(firstGenerationId,countReserve,configuredCap))) {
        if(countReservationId)await ledger.settle(countReservationId,0,0);
        failures.add("paid budget exhausted");
        continue;
      }
      firstGenerationReserved=true;
    }
    try {
      const r=await send("countTokens",{generateContentRequest:{model:`models/${model.name}`, ...generateContentRequest}});
      if (!r.ok) {
        await r.body?.cancel();
        if(model.tier==="paid")ambiguousMicros+=countReserve;
        await releaseFirstGeneration();
        failures.add("provider token count unavailable");continue;
      }
      count=(await r.json() as {totalTokens:number}).totalTokens;
      if(model.tier==="paid")ambiguousMicros+=countReserve;
      if (!validInt(count) || count===0 || count+(model.billableOutputLimit ?? maxOutput)>model.context) {
        await releaseFirstGeneration();
        failures.add("full Seed and response do not fit");continue;
      }
    } catch (error) {
      await releaseFirstGeneration();
      if(error===seedChanged) {
        if(model.tier==="paid"&&countReservationId)await ledger.settle(countReservationId,0,0);
        failures.add("canonical Seed changed or could not be verified");break;
      }
      if(model.tier==="paid")ambiguousMicros+=countReserve;
      failures.add("provider token count unavailable");continue;
    }
    // Reserve the entire advertised context for both input and output, not
    // merely the provider's token count or a possibly incomplete usage report.
    const estimate=model.tier==="paid"?cost(model.context,model.context,model):0;
    if (!validInt(estimate)) {await releaseFirstGeneration();failures.add("invalid model price estimate");continue;}
    for (let attempt=0; attempt<2; attempt++) {
      const id=attempt===0 && firstGenerationId?firstGenerationId:randomUUID();
      if (model.tier==="paid" && attempt===0)firstGenerationReserved=false;
      else if (model.tier==="paid" && (estimate>requestCap-paidCostMicros-ambiguousMicros ||
          !(await ledger.reserve(id,estimate,configuredCap)))) {failures.add("paid budget exhausted");break;}
      let r:Response;
      try { r=await send("generateContent",generateContentRequest); }
      catch (error) {
        if(error===seedChanged) {
          if(model.tier==="paid")await ledger.settle(id,0,0);
          failures.add("canonical Seed changed or could not be verified");break;
        }
        if(model.tier==="paid")ambiguousMicros+=estimate;
        failures.add("model request timed out or failed");continue;
      } // An ambiguous charge keeps its reservation.
      if (!r.ok) {
        await r.body?.cancel();
        failures.add(`provider HTTP ${r.status}`);
        if ([400,401,403,404,429].includes(r.status)) {
          if (model.tier==="paid")ambiguousMicros+=estimate;
          break;
        }
        if(model.tier==="paid")ambiguousMicros+=estimate;
        continue;
      }
      let settled=false;
      try {
        const data=await r.json() as {
          usageMetadata?:{promptTokenCount?:number;candidatesTokenCount?:number;thoughtsTokenCount?:number};
          promptFeedback?:{blockReason?:unknown};
          candidates?:{finishReason?:unknown;safetyRatings?:{blocked?:unknown}[];content?:{parts?:{text?:unknown;functionCall?:unknown}[]}}[];
        };
        const input=data.usageMetadata?.promptTokenCount, output=data.usageMetadata?.candidatesTokenCount;
        const thinking=data.usageMetadata?.thoughtsTokenCount===undefined?0:data.usageMetadata.thoughtsTokenCount;
        // The count request encloses the same complete generation request.
        const validUsage=typeof input==="number"&&typeof output==="number"&&typeof thinking==="number" &&
          validInt(input)&&input>0&&input===count&&validInt(output)&&output>0&&validInt(thinking) &&
          validInt(output+thinking)&&output+thinking<=(model.billableOutputLimit ?? maxOutput) &&
          validInt(input+output+thinking)&&input+output+thinking<=model.context;
        const charged=validUsage ? cost(input,output+thinking,model) : 0;
        if (model.tier==="paid") {
          if(validUsage && validInt(charged)) {
            await ledger.settle(id,charged,input+output+thinking);
            paidCostMicros+=charged;
          } else {
            ambiguousMicros+=estimate;
          }
          settled=true;
        }
        const candidate=data.candidates?.[0],parts=candidate?.content?.parts;
        if (!validUsage ||
            data.promptFeedback?.blockReason || data.candidates?.length!==1 || candidate?.finishReason!=="STOP" ||
            candidate.safetyRatings?.some(r=>r.blocked===true) || parts?.length!==1 ||
            parts[0]?.text!=="inventory-comparison" || parts[0]?.functionCall!==undefined) {
          failures.add("model outcome or usage could not be verified");
          break;
        }
        return {status:"measured",note:`A bounded research classification was received and validated; no model output was published or executed. This is not a verified AI-derived method.${ambiguousMicros?" Paid cost excludes unresolved reservations; the actual total is unknown.":""}`,version:seed.version,checksum:seed.checksum,model:model.name,tier:model.tier,externalAiCalls,paidAiCalls,inputTokens:input,outputTokens:output+thinking,costMicros:paidCostMicros,unresolvedMicros:ambiguousMicros};
      } catch {
        if(model.tier==="paid"&&!settled)ambiguousMicros+=estimate;
        failures.add("provider response could not be verified");break;
      }
    }
  }
  return {status:"blocked",note:(failures.size ? `AI skipped: ${[...failures].join("; ")}.` : "No approved model and provider key are configured.")+(ambiguousMicros?" Paid cost excludes unresolved reservations; the actual total is unknown.":""),externalAiCalls,paidAiCalls,costMicros:paidCostMicros,unresolvedMicros:ambiguousMicros};
}
