import type { LearningEntry } from "@workspace/api-zod";
import { sha } from "./engines";
import { verifyMethod } from "./knowledge";

export type KnowledgeVersionRecord={
  versionId:string;knowledgeId:string;supersedes:string|null;entry:LearningEntry;recordedAt:string;
};

function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==="object") {
    return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  }
  return value;
}

export function serializeKnowledgeVersion(record:KnowledgeVersionRecord) {
  return JSON.stringify(canonical(record));
}

function versionIdFor(knowledgeId:string,supersedes:string|null,entry:LearningEntry,recordedAt:string) {
  return sha(Buffer.from(JSON.stringify(canonical([
    "zioncore-command-knowledge-version-v1",knowledgeId,supersedes,entry,recordedAt,
  ])),"utf8"));
}

export function createKnowledgeVersion(
  entry:LearningEntry,
  supersedes:string|null,
  recordedAt:string,
):KnowledgeVersionRecord {
  return {
    versionId:versionIdFor(entry.id,supersedes,entry,recordedAt),
    knowledgeId:entry.id,supersedes,entry,recordedAt,
  };
}

export function legacyKnowledgeVersion(entry:LearningEntry):KnowledgeVersionRecord {
  return createKnowledgeVersion(entry,null,entry.createdAt);
}

export function verifyKnowledgeVersion(value:unknown):value is KnowledgeVersionRecord {
  if(!value || typeof value!=="object" || Array.isArray(value))return false;
  const record=value as KnowledgeVersionRecord;
  return Object.keys(record).sort().join(",")==="entry,knowledgeId,recordedAt,supersedes,versionId"
    && record.entry!==null && typeof record.entry==="object"
    && verifyMethod(record.entry)
    && record.knowledgeId===record.entry.id
    && (record.supersedes===null || /^[a-f0-9]{64}$/.test(record.supersedes))
    && typeof record.recordedAt==="string" && Number.isFinite(Date.parse(record.recordedAt))
    && record.versionId===versionIdFor(record.knowledgeId,record.supersedes,record.entry,record.recordedAt);
}

export function knowledgePointer(value:unknown):{entry?:LearningEntry;versionId?:string} {
  if(!value || typeof value!=="object" || Array.isArray(value))return {};
  const pointer=value as {entry?:LearningEntry;versionId?:unknown};
  if(pointer.entry && typeof pointer.versionId==="string")return {entry:pointer.entry,versionId:pointer.versionId};
  return {entry:value as LearningEntry};
}
