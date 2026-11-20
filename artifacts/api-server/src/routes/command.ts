import { Router, type RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { GetCommandFeedResponse, SubmitCommandSuggestionBody } from "@workspace/api-zod";
import { getFeed } from "../command/cycle";
import { safePublicResourceUrl, safeSuggestion } from "../command/engines";
import { openStore } from "../command/store";
import { exportSnapshot } from "../command/knowledge";

const router = Router();
const store = openStore();
let cache: { expires:number; result:ReturnType<typeof getFeed> }|undefined;

let reviewWindow=0,reviewCount=0;
const reviewAuth:RequestHandler= (req,res,next)=>{
  res.set({"Cache-Control":"no-store","X-Robots-Tag":"noindex"});
  const minute=Math.floor(Date.now()/60_000);
  if(minute!==reviewWindow) {reviewWindow=minute;reviewCount=0;}
  if(++reviewCount>120) {res.status(429).set("Retry-After","60").json({error:"Try again shortly."});return;}
  if(process.env.NODE_ENV==="production" && !req.secure && req.get("x-forwarded-proto")!=="https") {
    res.status(404).json({error:"Not found."});return;
  }
  const secret=process.env.COMMAND_REVIEW_TOKEN;
  const authorization=req.get("authorization")??"";
  const token=authorization.startsWith("Bearer ")?authorization.slice(7):"";
  const digest=(value:string)=>createHash("sha256").update(value).digest();
  if(!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret) || new Set(secret).size<16 ||
      !token || !timingSafeEqual(digest(secret),digest(token))) {
    res.status(404).json({error:"Not found."});return;
  }
  next();
};

router.get("/command/private/suggestions",reviewAuth,async(req,res)=>{
  const after=req.query.after;
  if(after!==undefined && (typeof after!=="string" || !/^[a-zA-Z0-9-]{1,128}$/.test(after))) {
    res.status(400).json({error:"Invalid cursor."});return;
  }
  try {
    const suggestions=await store.listSuggestions(after,50);
    res.json({suggestions,nextCursor:suggestions.length===50?suggestions[suggestions.length-1]!.id:null});
  } catch {
    res.status(503).json({error:"Private review is temporarily unavailable."});
  }
});

router.get("/command/private/research-candidates",reviewAuth,async(req,res)=>{
  const after=req.query.after;
  if(after!==undefined && (typeof after!=="string" || !/^[a-zA-Z0-9-]{1,128}$/.test(after))) {
    res.status(400).json({error:"Invalid cursor."});return;
  }
  try { res.json(await store.listResearchCandidates(after)); }
  catch {res.status(503).json({error:"Private review is temporarily unavailable."});}
});

router.patch("/command/private/suggestions/:id",reviewAuth,async(req,res)=>{
  const id=req.params.id;
  const body:unknown=req.body;
  if(typeof id!=="string" || !/^[a-zA-Z0-9-]{1,128}$/.test(id) ||
      !body || typeof body!=="object" || Array.isArray(body) ||
      Object.keys(body).some(key=>!["status","reason","topic"].includes(key))) {
    res.status(400).json({error:"Provide a valid receipt, status, and review reason."});return;
  }
  const {status,reason,topic}=body as Record<string,unknown>;
  if(typeof status!=="string" || !["queued","accepted","rejected","completed"].includes(status) ||
      typeof reason!=="string" || reason.trim().length<5 || reason.length>500 ||
      topic!==undefined && (typeof topic!=="string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(topic))) {
    res.status(400).json({error:"Provide a valid receipt, status, and review reason."});return;
  }
  const decision={status:status as "queued"|"accepted"|"rejected"|"completed",reason:reason.trim(),
    ...(typeof topic==="string"?{topic}:{})};
  try {
    if(!await store.setSuggestionReview(id,decision)) {res.status(404).json({error:"Receipt not found or ineligible."});return;}
    res.json({id,status:decision.status});
  } catch {
    res.status(503).json({error:"Private review is temporarily unavailable."});
  }
});

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

const publicReasons:Record<string,string>={
  queued:"Awaiting individual review.",
  accepted:"Individually reviewed; awaiting item-specific research.",
  rejected:"Not selected for research after individual review.",
  completed:"A reviewer has marked the suggestion complete.",
};
let receiptWindow=0,receiptCount=0;
router.post("/command/suggestions/status",async(req,res)=>{
  res.set("Cache-Control","no-store");
  const minute=Math.floor(Date.now()/60_000);
  if(minute!==receiptWindow) {receiptWindow=minute;receiptCount=0;}
  if(++receiptCount>120) {res.status(429).set("Retry-After","60").json({error:"Try again shortly."});return;}
  const body:unknown=req.body;
  if(!req.is("application/json") || !body || typeof body!=="object" || Array.isArray(body) ||
      Object.keys(body).length!==1 || typeof (body as Record<string,unknown>).id!=="string" ||
      !/^[a-zA-Z0-9-]{20,128}$/.test((body as Record<string,string>).id!)) {
    res.status(400).json({error:"Provide a valid receipt ID."});return;
  }
  try {
    const receipt=await store.getReceipt((body as Record<string,string>).id!);
    if(!receipt) {res.status(404).json({error:"Receipt not found."});return;}
    const status=Object.hasOwn(publicReasons,receipt.status)?receipt.status:"queued";
    res.json({status,reason:publicReasons[status]});
  } catch {
    res.status(503).json({error:"Receipt status is temporarily unavailable."});
  }
});

router.post("/command/suggestions",async (req,res)=>{
  res.set("Cache-Control","no-store");
  if (!req.is("application/json") || Buffer.byteLength(JSON.stringify(req.body ?? {}))>6_000) {
    res.status(400).json({error:"Send a short JSON suggestion."});return;
  }
  if (req.get("sec-fetch-site")==="cross-site" && req.get("origin")!=="https://tariromasawi.github.io") {
    res.status(403).json({error:"Suggestions are accepted only from the public Command website."});return;
  }
  const parsed=SubmitCommandSuggestionBody.strict().safeParse(req.body);
  if (!parsed.success || parsed.data.text.trim().length<20 || !safeSuggestion(parsed.data.text) ||
      (parsed.data.resourceUrl!==undefined && !safePublicResourceUrl(parsed.data.resourceUrl))) {
    res.status(400).json({error:"Choose a listed programme, a public-safe question, and an optional public HTTPS resource."});return;
  }
  try {
    const id=await store.enqueue({programme:parsed.data.programme,text:parsed.data.text.trim(),resourceUrl:parsed.data.resourceUrl});
    res.status(202).json({id,status:"queued for private triage"});
  } catch (err) {
    if (err instanceof Error && err.message==="inbox-limit") {res.status(429).set("Retry-After","60").json({error:"The suggestion inbox is busy. Try again shortly."});return;}
    res.status(503).json({error:"The suggestion inbox is unavailable."});
  }
});

export default router;
