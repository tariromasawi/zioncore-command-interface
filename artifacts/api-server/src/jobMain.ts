import { runCycle, type CycleKind } from "./command/cycle";
import { loadSeed } from "./command/genesis";
import { openStore } from "./command/store";
import { logger } from "./lib/logger";

const mode=process.argv[2] ?? "preview";
if (mode==="seed-check") {
  const seed=await loadSeed();
  if (!seed) throw new Error("Genesis Seed mount is missing, invalid UTF-8, or does not match its configured checksum");
  logger.info({version:seed.version,checksum:seed.checksum,externalAiCalls:0,paidAiCalls:0},
    "Read-only Genesis Seed mount check passed");
} else if(mode==="knowledge-archive-check") {
  const store=openStore();
  if(!store.production)throw new Error("Knowledge archive checks require the production store");
  const versions=await store.archiveKnowledgeHistory();
  logger.info({versions,externalAiCalls:0,paidAiCalls:0},"Append-only knowledge archive verified");
} else {
  const modes:CycleKind[]=["preview","scheduled","daily-review","archive-exercise","internal-replay"];
  if (!modes.includes(mode as CycleKind)) throw new Error("Unrecognized runner mode");
  const store=openStore();
  if ((mode==="preview" || mode==="archive-exercise" || mode==="internal-replay") && store.production)
    throw new Error("Preview and demonstration runs cannot write to production");
  if ((mode==="scheduled" || mode==="daily-review") && !store.production) throw new Error("Scheduled modes require production");
  const watchdog=setTimeout(()=>{logger.error("Command runner exceeded its time limit");process.exit(1);},180_000);
  try {
    const run=await runCycle(store,mode as CycleKind);
    if (run) logger.info({id:run.id,outcome:run.outcome},"Command cycle recorded");
    else logger.info("Command cycle already claimed, complete, or out of retries");
  } catch {
    logger.error("Command runner could not record a cycle");
    process.exitCode=1;
  } finally {clearTimeout(watchdog);}
}
