import { runCycle, type CycleKind } from "./command/cycle";
import { openStore } from "./command/store";
import { logger } from "./lib/logger";

const mode=process.argv[2] ?? "preview";
const modes:CycleKind[]=["preview","scheduled","daily-review","archive-exercise"];
if (!modes.includes(mode as CycleKind)) throw new Error("Unrecognized runner mode");
const store=openStore();
if (mode==="preview" && store.production) throw new Error("Preview mode cannot write to production");
if ((mode==="scheduled" || mode==="daily-review") && !store.production) throw new Error("Scheduled modes require production");
if (mode==="archive-exercise" && store.production && process.env.COMMAND_ALLOW_ARCHIVE_EXERCISE!=="1")
  throw new Error("Archive exercises require an isolated, operator-invoked execution");
const watchdog=setTimeout(()=>{logger.error("Command runner exceeded its time limit");process.exit(1);},180_000);
try {
  const run=await runCycle(store,mode as CycleKind);
  if (run) logger.info({id:run.id,outcome:run.outcome},"Command cycle recorded");
  else logger.info("Command cycle already claimed, complete, or out of retries");
} catch {
  logger.error("Command runner could not record a cycle");
  process.exitCode=1;
} finally {clearTimeout(watchdog);}
