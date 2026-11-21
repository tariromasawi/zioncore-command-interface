import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bucket } from "@google-cloud/storage";
import { listKnowledgeVersions, writeKnowledgeVersion } from "../src/command/knowledgeArchive";
import { learnContinuity } from "../src/command/knowledge";
import { createKnowledgeVersion } from "../src/command/knowledgeVersions";

function fakeBucket() {
  const values=new Map<string,Buffer>();
  const bucket={
    file(name:string) {
      const file={
        name,
        async save(data:Buffer) {
          if(values.has(name))throw Object.assign(new Error("precondition failed"),{code:412});
          values.set(name,Buffer.from(data));
        },
        async download() {
          const value=values.get(name);
          if(!value)throw Object.assign(new Error("missing"),{code:404});
          return [Buffer.from(value)];
        },
      };
      return file;
    },
    async getFiles({prefix}:{prefix:string}) {
      return [[...values.keys()].filter(name=>name.startsWith(prefix)).map(name=>({
        name,
        async save(){throw new Error("not used");},
        async download(){return [Buffer.from(values.get(name)!)];},
      }))];
    },
  } as unknown as Bucket;
  return {bucket,values};
}

test("knowledge archive creates version objects once and verifies existing bytes",async()=>{
  const {bucket,values}=fakeBucket();
  const entry=learnContinuity("scheduled-2026-11-21");
  const first=createKnowledgeVersion(entry,null,entry.createdAt);
  const second=createKnowledgeVersion({...entry,status:"failed"},first.versionId,new Date(+new Date(entry.createdAt)+1).toISOString());
  await writeKnowledgeVersion(bucket as Pick<Bucket,"file"|"getFiles">,first);
  await writeKnowledgeVersion(bucket as Pick<Bucket,"file"|"getFiles">,first);
  await writeKnowledgeVersion(bucket as Pick<Bucket,"file"|"getFiles">,second);
  const records=await listKnowledgeVersions(bucket as Pick<Bucket,"file"|"getFiles">);
  assert.deepEqual(records.map(record=>record.versionId),[first.versionId,second.versionId]);
  assert.equal(records.find(record=>record.versionId===second.versionId)?.supersedes,first.versionId);
  assert.equal(values.size,2);
});

test("knowledge archive refuses to accept changed bytes at an existing version path",async()=>{
  const {bucket,values}=fakeBucket();
  const entry=learnContinuity("scheduled-2026-11-21");
  const record=createKnowledgeVersion(entry,null,entry.createdAt);
  const name=`versions/${record.versionId}.json`;
  values.set(name,Buffer.from('{"corrupt":true}'));
  await assert.rejects(writeKnowledgeVersion(bucket as Pick<Bucket,"file"|"getFiles">,record),/conflicting version/);
});

test("knowledge archive rejects unexpected objects under its version prefix",async()=>{
  const {bucket,values}=fakeBucket();
  values.set("versions/not-a-checksum.json",Buffer.from("{}"));
  await assert.rejects(listKnowledgeVersions(bucket as Pick<Bucket,"file"|"getFiles">),/unexpected object/);
});
