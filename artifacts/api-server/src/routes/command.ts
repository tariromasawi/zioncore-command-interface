import { Router } from "express";
import { GetCommandFeedResponse, SubmitCommandSuggestionBody } from "@workspace/api-zod";
import { getFeed } from "../command/cycle";
import { safeSuggestion } from "../command/engines";
import { openStore } from "../command/store";
import { exportSnapshot } from "../command/knowledge";

const router = Router();
const store = openStore();
let cache: { expires:number; result:ReturnType<typeof getFeed> }|undefined;

router.get("/command/feed", async (req,res) => {
  try {
    if (!cache || cache.expires<Date.now()) cache={expires:Date.now()+15_000,result:getFeed(store)};
    const result=GetCommandFeedResponse.parse(await cache.result);
    res.set("Cache-Control","public, max-age=15").json(result);
  } catch {
    cache=undefined;
    req.log.error("Public Command feed unavailable");
    res.status(503).json({error:"Results are temporarily unavailable."});
  }
});

router.get("/command/knowledge/export",async(req,res)=>{
  try {
    const snapshot=exportSnapshot(await store.knowledge());
    res.set({
      "Cache-Control":"no-store",
      "Content-Disposition":'attachment; filename="zioncore-command-knowledge-v1.json"',
      "X-Content-Type-Options":"nosniff",
    }).type("application/json").send(JSON.stringify(snapshot));
  } catch {
    req.log.error("Portable Command knowledge export unavailable");
    res.status(503).json({error:"Knowledge export is temporarily unavailable."});
  }
});

router.post("/command/suggestions",async (req,res)=>{
  res.set("Cache-Control","no-store");
  if (!req.is("application/json") || Buffer.byteLength(JSON.stringify(req.body ?? {}))>6_000) {
    res.status(400).json({error:"Send a short JSON suggestion."});return;
  }
  if (req.get("sec-fetch-site")==="cross-site") {res.status(403).json({error:"Use the Command website to submit suggestions."});return;}
  const parsed=SubmitCommandSuggestionBody.strict().safeParse(req.body);
  if (!parsed.success || parsed.data.text.trim().length<20 || !safeSuggestion(parsed.data.text)) {
    res.status(400).json({error:"Choose a listed programme and share a public-safe research question without links, contacts or instructions to cause harm."});return;
  }
  try {
    const id=await store.enqueue({programme:parsed.data.programme,text:parsed.data.text.trim()});
    res.status(202).json({id,status:"queued for private triage"});
  } catch (err) {
    if (err instanceof Error && err.message==="inbox-limit") {res.status(429).set("Retry-After","60").json({error:"The suggestion inbox is busy. Try again shortly."});return;}
    res.status(503).json({error:"The suggestion inbox is unavailable."});
  }
});

export default router;
