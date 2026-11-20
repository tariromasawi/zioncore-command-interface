import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exportSnapshot, verifySnapshot } from "./knowledge";
import { openStore } from "./store";

const [mode,pathArg,...extra]=process.argv.slice(2);
const path=pathArg&&resolve(pathArg);
if (!["export","verify","restore"].includes(mode ?? "") || !path || extra.length) {
  throw new Error("Usage: knowledgeMain.mjs export <new-file> | verify <file> | restore <file>");
}

if(mode==="export") {
  const snapshot=exportSnapshot(await openStore().knowledge());
  const file=await open(path,"wx",0o600);
  try {await file.writeFile(JSON.stringify(snapshot,null,2)+"\n","utf8");await file.sync();}
  finally {await file.close();}
  process.stdout.write(`Exported ${snapshot.entryCount} methods; SHA-256 ${snapshot.checksum}\n`);
} else {
  if(mode==="restore" && process.env.COMMAND_KNOWLEDGE_RESTORE!=="1") throw new Error("Set COMMAND_KNOWLEDGE_RESTORE=1 only after reviewing the manifest checksum and target store.");
  const parsed:unknown=JSON.parse(await readFile(path,"utf8"));
  const snapshot=verifySnapshot(parsed);
  if(mode==="restore") await openStore().importKnowledge(snapshot);
  process.stdout.write(`${mode==="restore"?"Restored": "Verified"} ${snapshot.entryCount} methods; SHA-256 ${snapshot.checksum}\n`);
}
