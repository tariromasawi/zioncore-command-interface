import { createHash } from "node:crypto";
import type { LearningEntry, LearningEntryEvaluation } from "@workspace/api-zod";
import { archiveExercise, benchmark, sha } from "./engines";

export const continuityMethodId="sha256-staged-mirror-restore";
export const continuityMethodVersion="1.0.0";
export const continuityMethod=
  "For an authorized archive, retain the original bytes; compare SHA-256 with an independently held trusted manifest; verify a distinct mirror against that same manifest; stage a copy without overwriting the source; hash the staged copy; replace only after it matches; hash the final restored bytes and record both observed and verified digests.";
export const continuityUncertainty=
  "Verification establishes equality to a trusted digest; it does not establish that the source was authentic, that all data were included, or that any real heritage archive is healthy. The recurring mission uses synthetic fixtures unless explicitly configured otherwise.";
const continuitySource={
  label:"NDSA — Levels of Digital Preservation",
  detail:"Public reference on fixity checks, redundancy, and preservation practice.",
  url:"https://ndsa.org/publications/levels-of-digital-preservation/",
};
export const evolutionMethodId="evolution-speed-indexed-lookup";
export const evolutionMethodVersion="2.0.0";
export const evolutionMethod=
  "Select a Map-indexed lookup only after it returns the same ordered results as the linear baseline on the synthetic workload and uses fewer counted operations; reject the intentionally faulty candidate and keep the baseline on any mismatch.";
const evolutionSource={
  label:"Local regression fixture",
  detail:"128 synthetic records and 2,048 lookups; output equivalence and faulty-candidate rejection are asserted before the optimized path is accepted.",
};

export function methodChecksum(method:string) {
  return sha(Buffer.from(method,"utf8"));
}

function knowledgeId(methodId:string,version:string,checksum:string) {
  return sha(Buffer.from(`ZionCore Command knowledge v1\n${methodId}\n${version}\n${checksum}`,"utf8"));
}

function canonicalJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(",")}]`;
  if(value && typeof value==="object") {
    return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
      .map(([key,item])=>`${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function learnContinuity(runId:string,at=new Date()):LearningEntry {
  const methodHash=methodChecksum(continuityMethod);
  return {
    id:knowledgeId(continuityMethodId,continuityMethodVersion,methodHash),
    methodId:continuityMethodId,methodChecksum:methodHash,
    title:"Verified staged restore from a separately checked mirror",
    programme:"Continuity",version:continuityMethodVersion,status:"verified",
    sourceRunId:runId,createdAt:at.toISOString(),
    refreshAt:new Date(+at+90*86_400_000).toISOString(),
    method:continuityMethod,evidence:[continuitySource],uncertainty:continuityUncertainty,evaluations:[],
  };
}

export function learnEvolution(runId:string,at=new Date()):LearningEntry {
  const methodHash=methodChecksum(evolutionMethod);
  return {
    id:knowledgeId(evolutionMethodId,evolutionMethodVersion,methodHash),
    methodId:evolutionMethodId,methodChecksum:methodHash,
    title:"Indexed lookups with forward-only verification",
    programme:"Operations",version:evolutionMethodVersion,status:"verified",
    sourceRunId:runId,createdAt:at.toISOString(),
    refreshAt:new Date(+at+30*86_400_000).toISOString(),
    method:evolutionMethod,evidence:[evolutionSource],
    uncertainty:"Synthetic operation counts demonstrate equivalence and relative work on this fixture only; they are not measured wall-clock latency or production traffic.",
    evaluations:[],
  };
}

export function sealEvaluation(entry:LearningEntry, evaluation:LearningEntryEvaluation):LearningEntry {
  const evaluations=[...entry.evaluations.filter(item=>item.runId!==evaluation.runId),evaluation].slice(-50);
  const status=+new Date(entry.refreshAt)<=+new Date(evaluation.recordedAt)
    ?"stale":evaluation.outcome==="passed"?"verified":"failed";
  return {...entry,evaluations,status};
}

export function currentKnowledge(entry:LearningEntry, now=Date.now()):LearningEntry {
  return +new Date(entry.refreshAt)<=now && entry.status==="verified" ? {...entry,status:"stale"} : entry;
}

export function verifyMethod(entry:LearningEntry) {
  const expected=entry.methodId===continuityMethodId
    ? {version:continuityMethodVersion,method:continuityMethod,evidence:continuitySource}
    : entry.methodId===evolutionMethodId
      ? {version:evolutionMethodVersion,method:evolutionMethod,evidence:evolutionSource}:null;
  return !!expected && entry.id===knowledgeId(entry.methodId,entry.version,entry.methodChecksum)
    && methodChecksum(entry.method)===entry.methodChecksum
    && entry.version===expected.version
    && entry.method===expected.method
    && canonicalJson(entry.evidence)===canonicalJson([expected.evidence]);
}

export function evaluateEvolutionMethod(entry:LearningEntry) {
  if(!verifyMethod(entry)||currentKnowledge(entry).status!=="verified")throw new Error("Knowledge method is invalid or stale");
  const result=benchmark();
  if(!result.promoted||!result.rolledBack)throw new Error("Evolution method failed equivalence or pre-acceptance rejection checks");
  return result;
}

export async function evaluateContinuityMethod(entry:LearningEntry,caseId:string) {
  if (!verifyMethod(entry) || currentKnowledge(entry).status!=="verified") throw new Error("Knowledge method is invalid or stale");
  // A fresh, deterministic fixture is constructed for each evaluation.
  const payload=Buffer.from(`ZionCore Command continuity fixture v1\ncase=${caseId}\nno personal data\n`,"utf8");
  const result=await archiveExercise(false,payload);
  if (result.restored || result.expected!==result.observed || result.expected!==result.mirrorHash || result.expected!==result.verified) {
    throw new Error("Knowledge verification failed");
  }
  return {checksum:result.verified,observedChecksum:result.observed,caseId};
}

type SnapshotBody={
  format:"zioncore-command-knowledge";
  version:1;
  createdAt:string;
  entryCount:number;
  entries:LearningEntry[];
};
export type KnowledgeSnapshot=SnapshotBody & {checksum:string};

function canonicalSnapshotBody(body:SnapshotBody) {
  return JSON.stringify({
    format:body.format,version:body.version,createdAt:body.createdAt,entryCount:body.entryCount,
    entries:[...body.entries].sort((a,b)=>a.id.localeCompare(b.id)),
  });
}

export function exportSnapshot(entries:LearningEntry[],now=new Date()):KnowledgeSnapshot {
  const body:SnapshotBody={format:"zioncore-command-knowledge",version:1,createdAt:now.toISOString(),
    entryCount:entries.length,entries:[...entries].sort((a,b)=>a.id.localeCompare(b.id))};
  return {...body,checksum:sha(Buffer.from(canonicalSnapshotBody(body),"utf8"))};
}

export function verifySnapshot(value:unknown):KnowledgeSnapshot {
  if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error("Invalid knowledge export");
  const candidate=value as Partial<KnowledgeSnapshot>;
  if (candidate.format!=="zioncore-command-knowledge" || candidate.version!==1
    || typeof candidate.createdAt!=="string" || !Number.isFinite(Date.parse(candidate.createdAt))
    || !Array.isArray(candidate.entries) || candidate.entries.length>400
    || candidate.entryCount!==candidate.entries.length
    || typeof candidate.checksum!=="string" || !/^[a-f0-9]{64}$/.test(candidate.checksum)) throw new Error("Invalid knowledge export metadata");
  const seenIds=new Set<string>();
  for (const raw of candidate.entries) {
    const entry=raw as LearningEntry;
    const exactKeys=(record:object, keys:string[])=>Object.keys(record).sort().join("\n")===keys.sort().join("\n");
    if (!entry || typeof entry!=="object" || !/^[a-f0-9]{64}$/.test(entry.id) || seenIds.has(entry.id)
      || !exactKeys(entry,["id","methodId","methodChecksum","title","programme","version","status","sourceRunId","createdAt","refreshAt","method","evidence","uncertainty","evaluations"])
      || typeof entry.methodId!=="string" || typeof entry.methodChecksum!=="string"
      || !/^[a-f0-9]{64}$/.test(entry.methodChecksum) || typeof entry.title!=="string"
      || typeof entry.programme!=="string" || typeof entry.version!=="string"
      || !["verified","failed","stale"].includes(entry.status)
      || typeof entry.sourceRunId!=="string" || typeof entry.createdAt!=="string" || !Number.isFinite(Date.parse(entry.createdAt))
      || typeof entry.refreshAt!=="string" || !Number.isFinite(Date.parse(entry.refreshAt))
      || typeof entry.method!=="string" || entry.method.length>10_000
      || !Array.isArray(entry.evidence) || entry.evidence.length>20
      || entry.evidence.some(item=>!item || !exactKeys(item,item.url===undefined?["label","detail"]:["label","detail","url"]) || typeof item.label!=="string" || typeof item.detail!=="string"
        || (item.url!==undefined && item.url!=="https://ndsa.org/publications/levels-of-digital-preservation/"))
      || typeof entry.uncertainty!=="string" || !Array.isArray(entry.evaluations) || entry.evaluations.length>50
      || entry.evaluations.some(item=>!item || !exactKeys(item,["runId","outcome","recordedAt"]) || typeof item.runId!=="string"
        || !["passed","failed"].includes(item.outcome) || typeof item.recordedAt!=="string" || !Number.isFinite(Date.parse(item.recordedAt)))
      || !verifyMethod(entry)) throw new Error("Knowledge export contains an unsupported or modified method");
    seenIds.add(entry.id);
  }
  const body:SnapshotBody={format:candidate.format,version:candidate.version,createdAt:candidate.createdAt,
    entryCount:candidate.entryCount,entries:candidate.entries};
  const checksum=sha(Buffer.from(canonicalSnapshotBody(body),"utf8"));
  if (checksum!==candidate.checksum) throw new Error("Knowledge export checksum mismatch");
  return {...body,checksum};
}
