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
type AiResult = {status:"blocked"|"measured"; note:string; version?:string; checksum?:string; model?:string;tier?:"free"|"paid"; inputTokens?:number; outputTokens?:number; costMicros?:number;externalAiCalls:number;paidAiCalls:number};
const maxOutput = 256;
const task = "Classify the next benign, public documentation research question: how should a library compare two authorized archive inventory methods? Return just a short research category. Do not request actions or call tools.";
const validInt = (n:number) => Number.isSafeInteger(n) && n>=0;

export function paidAiMonthlyCap(env=process.env) {
  if(env.COMMAND_ENABLE_PAID_AI!=="1")return 0;
  const cap=Number(env.COMMAND_PAID_AI_MONTHLY_CAP_MICROS);
  return validInt(cap)&&cap>0?cap:0;
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
  if(env.COMMAND_ENABLE_GENESIS_AI!=="1")return [];
  const models:Model[]=[];
  const hasApprovedSeedConfig=!!env.COMMAND_GENESIS_PATH
    &&!!env.COMMAND_GENESIS_SHA256&&/^[a-f0-9]{64}$/.test(env.COMMAND_GENESIS_SHA256)
    &&!!env.COMMAND_GENESIS_VERSION&&/^[a-zA-Z0-9.-]{1,32}$/.test(env.COMMAND_GENESIS_VERSION);
  const paidCap=hasApprovedSeedConfig?paidAiMonthlyCap(env):0;
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
  seed, models, ledger, cap, request, complex=false, env=process.env,
}: {
  seed:Seed|null; models:Model[]; ledger:Pick<CommandStore,"reserve"|"settle">;
  cap?:number; request?:typeof fetch; complex?:boolean; env?:NodeJS.ProcessEnv;
}):Promise<AiResult> {
  if(process.env.NODE_ENV==="production" || env.NODE_ENV==="production" || !request || request===fetch)
    return {status:"blocked",note:"Live AI research is blocked; provider billing and output limits are not verified.",externalAiCalls:0,paidAiCalls:0};
  if (env.COMMAND_ENABLE_GENESIS_AI!=="1" || !seed || sha(seed.text)!==seed.checksum || !env.COMMAND_GENESIS_PATH
    || env.COMMAND_GENESIS_SHA256!==seed.checksum || env.COMMAND_GENESIS_VERSION!==seed.version)
    return {status:"blocked",note:"Canonical Genesis bytes have not been approved and verified.",externalAiCalls:0,paidAiCalls:0};
  const configuredCap=paidAiMonthlyCap(env);
  const requestCap=cap===undefined?configuredCap:Math.min(validInt(cap)?cap:0,configuredCap);
  const ordered=complex ? [...models].sort((a,b)=>Number(b.tier==="paid")-Number(a.tier==="paid")) : models;
  // Every outbound request, including token count, uses the same isolated Seed field.
  const generateContentRequest={
    systemInstruction:{ parts:[{text:seed.text}] },
    contents:[{role:"user",parts:[{text:task}]}],
    generationConfig:{maxOutputTokens:maxOutput},
  };
  const failures=new Set<string>();
  let externalAiCalls=0,paidAiCalls=0;
  for (const model of ordered) {
    if (model.tier==="paid" && requestCap===0) {failures.add("paid budget disabled");continue;}
    const send=(endpoint:string, body:object)=>request(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:${endpoint}`,
      {method:"POST",redirect:"error",headers:{"content-type":"application/json","x-goog-api-key":model.key},body:JSON.stringify(body),signal:AbortSignal.timeout(12_000)},
    );
    let count:number;
    const countReservationId=model.tier==="paid"?randomUUID():null;
    // countTokens is also gated: reserve against a conservative input bound
    // before sending the paid request, then release only after a known reply.
    const inputCeiling=Math.min(model.context,Buffer.byteLength(seed.text,"utf8")+Buffer.byteLength(task,"utf8")+64);
    const countReserve=cost(inputCeiling,model.billableOutputLimit ?? maxOutput,model);
    if(model.tier==="paid"&&(!validInt(countReserve)||countReserve>requestCap)) {
      failures.add("paid budget exhausted");
      continue;
    }
    if(model.tier==="paid"&&countReservationId
      &&!(await ledger.reserve(countReservationId,countReserve,requestCap))) {
      failures.add("paid budget exhausted");
      continue;
    }
    try {
      const r=await send("countTokens",{model:`models/${model.name}`, ...generateContentRequest});
      externalAiCalls++;
      if (!r.ok) {
        await r.body?.cancel();
        if(model.tier==="paid"&&countReservationId&&[400,401,403,404,429].includes(r.status))
          await ledger.settle(countReservationId,0,0);
        failures.add("provider token count unavailable");continue;
      }
      count=Number((await r.json() as {totalTokens?:unknown}).totalTokens);
      if(model.tier==="paid"&&countReservationId)await ledger.settle(countReservationId,0,0);
      if (!validInt(count) || count===0 || count+(model.billableOutputLimit ?? maxOutput)>model.context) {failures.add("full Seed and response do not fit");continue;}
    } catch {failures.add("provider token count unavailable");continue;}
    const estimate=cost(count,model.billableOutputLimit ?? maxOutput,model);
    if (!validInt(estimate)) {failures.add("invalid model price estimate");continue;}
    for (let attempt=0; attempt<2; attempt++) {
      const id=randomUUID();
      if (model.tier==="paid" && !(await ledger.reserve(id,estimate,requestCap))) {failures.add("paid budget exhausted");break;}
      let r:Response;
      try { r=await send("generateContent",generateContentRequest);externalAiCalls++;if(model.tier==="paid")paidAiCalls++; }
      catch {failures.add("model request timed out or failed");continue;} // An ambiguous charge keeps its reservation.
      if (!r.ok) {
        await r.body?.cancel();
        failures.add(`provider HTTP ${r.status}`);
        if ([400,401,403,404,429].includes(r.status)) {
          if (model.tier==="paid") await ledger.settle(id,0,0);
          break;
        }
        continue;
      }
      try {
        const data=await r.json() as {
          usageMetadata?:{promptTokenCount?:unknown;candidatesTokenCount?:unknown;thoughtsTokenCount?:unknown};
          candidates?:{content?:{parts?:{text?:unknown}[]}}[];
        };
        const input=Number(data.usageMetadata?.promptTokenCount), output=Number(data.usageMetadata?.candidatesTokenCount);
        const thinking=Number(data.usageMetadata?.thoughtsTokenCount ?? 0);
        const validUsage=validInt(input)&&validInt(output)&&validInt(thinking);
        const charged=validUsage ? cost(input,output+thinking,model) : estimate;
        if (model.tier==="paid") await ledger.settle(id,charged,validUsage?input+output+thinking:0);
        if (!data.candidates?.[0]?.content?.parts?.some((p:{text?:unknown})=>typeof p.text==="string" && p.text.length)) {
          failures.add("model returned no result");
          break;
        }
        return {status:"measured",note:`${model.tier} model ${model.name} returned a research classification. Genesis ${seed.version} SHA-256 ${seed.checksum}. ${validUsage?`${input} input and ${output+thinking} billable output tokens, estimated USD ${(charged/1e6).toFixed(6)}.`:"Provider did not return complete usage."} No model output was executed.`,version:seed.version,checksum:seed.checksum,model:model.name,tier:model.tier,externalAiCalls,paidAiCalls,...(validUsage?{inputTokens:input,outputTokens:output+thinking,costMicros:charged}:{})};
      } catch {failures.add("provider response could not be verified");break;}
    }
  }
  return {status:"blocked",note:failures.size ? `AI skipped: ${[...failures].join("; ")}.` : "No approved model and provider key are configured.",externalAiCalls,paidAiCalls};
}
