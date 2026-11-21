import { Storage, type Bucket, type File } from "@google-cloud/storage";
import { serializeKnowledgeVersion, verifyKnowledgeVersion, type KnowledgeVersionRecord } from "./knowledgeVersions";

const projectId="gen-lang-client-0266144152";
const prefix="versions/";
type ArchiveFile=Pick<File,"name"|"save"|"download">;
type ArchiveBucket=Pick<Bucket,"file"|"getFiles">;

function createArchiveBucket(name:string):ArchiveBucket {
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name))
    throw new Error("Knowledge archive bucket name is invalid");
  return new Storage({projectId}).bucket(name);
}

function archivePath(versionId:string) {
  return `${prefix}${versionId}.json`;
}

function isPreconditionFailure(error:unknown) {
  return !!error && typeof error==="object" && ["409","412"].includes(String((error as {code?:unknown}).code));
}

export async function writeKnowledgeVersion(bucket:ArchiveBucket,record:KnowledgeVersionRecord) {
  if(!verifyKnowledgeVersion(record))throw new Error("Refusing to archive an invalid knowledge version");
  const path=archivePath(record.versionId);
  const expected=Buffer.from(serializeKnowledgeVersion(record),"utf8");
  const file=bucket.file(path);
  try {
    await file.save(expected,{
      resumable:false,
      contentType:"application/json; charset=utf-8",
      preconditionOpts:{ifGenerationMatch:0},
      metadata:{cacheControl:"private, no-store"},
    });
  } catch(error) {
    if(!isPreconditionFailure(error))throw new Error("Append-only knowledge archive write failed");
    const [actual]=await file.download();
    if(!actual.equals(expected))throw new Error("Append-only knowledge archive has a conflicting version");
  }
}

export async function listKnowledgeVersions(bucket:ArchiveBucket):Promise<KnowledgeVersionRecord[]> {
  const [files]=await bucket.getFiles({prefix,autoPaginate:true});
  const records:KnowledgeVersionRecord[]=[];
  for(const file of files) {
    if(!new RegExp(`^${prefix}[a-f0-9]{64}\\.json$`).test(file.name))
      throw new Error("Knowledge archive contains an unexpected object");
    const [bytes]=await file.download();
    let record:unknown;
    try {record=JSON.parse(bytes.toString("utf8"));} catch {throw new Error("Knowledge archive contains invalid JSON");}
    if(!verifyKnowledgeVersion(record) || file.name!==archivePath(record.versionId))
      throw new Error("Knowledge archive contains a modified or misplaced version");
    records.push(record);
  }
  return records.sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.versionId.localeCompare(b.versionId));
}

export async function archiveKnowledgeVersion(record:KnowledgeVersionRecord,bucketName:string) {
  return writeKnowledgeVersion(createArchiveBucket(bucketName),record);
}

export async function readKnowledgeVersions(bucketName:string) {
  return listKnowledgeVersions(createArchiveBucket(bucketName));
}
