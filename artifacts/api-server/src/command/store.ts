import { Firestore } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommandRun, LearningEntry } from "@workspace/api-zod";
import { currentKnowledge, sealEvaluation, verifySnapshot, type KnowledgeSnapshot } from "./knowledge";
import { paidAiMonthlyCap } from "./genesis";

const projectId = "gen-lang-client-0266144152";
const leaseMs = 4 * 60_000;
type Lease = { id: string; token: string };
type Slot = { token: string; until: number; attempts: number; status: string; run?: CommandRun };
type Suggestion = { programme: string; text: string; resourceUrl?:string };
type ReviewEvent={status:string;reason:string;at:string};
export type PrivateSuggestion = { id:string; programme:string; text?:string; resourceUrl?:string; status:string; reason:string|null; reviewedAt:string|null; submittedAt:string; topic:string|null; history:ReviewEvent[] };
export type SuggestionDecision = { status:"accepted"|"rejected"|"queued"|"completed"; reason:string; topic?:string };
type Budget = { reserved: number; settled: number; tokens: number; requests?:number };
export type SuggestionTriage={reviewed:number;programmeCounts:Record<string,number>;selected:{id:string;programme:string;relatedCount:number}|null};
export type KnowledgeOutcome={entry:LearningEntry;outcome:"passed"|"failed"};
const excludedReceipt="Nt6E2S6U9msi5G7Ulufy";

export interface CommandStore {
  readonly production: boolean;
  list(): Promise<CommandRun[]>;
  claim(id: string): Promise<Lease | null>;
  complete(lease: Lease, run: CommandRun, knowledge: KnowledgeOutcome[]): Promise<void>;
  knowledge(): Promise<LearningEntry[]>;
  importKnowledge(snapshot: KnowledgeSnapshot): Promise<void>;
  allRunMetrics(): Promise<{internalMissionRuns:number;externallyAssistedRuns:number;paidAiCalls:number;
    billingPeriod:string;monthlyPaidAiSpendMicros:number;monthlyPaidAiReservedMicros:number;monthlyPaidAiRequests:number;monthlyPaidAiAllowanceMicros:number}>;
  enqueue(input: Suggestion): Promise<string>;
  getReceipt(id:string): Promise<{status:string}|null>;
  review(): Promise<SuggestionTriage>;
  listResearchCandidates(after?:string): Promise<{candidates:{id:string;programme:string;relatedCount:number;relatedCountScope:"current-page-only"}[];nextCursor:string|null;rankingScope:"current-page-only"}>;
  listSuggestions(after?:string, limit?:number): Promise<PrivateSuggestion[]>;
  setSuggestionReview(id:string, decision:SuggestionDecision): Promise<boolean>;
  reserve(id: string, amount: number, cap: number): Promise<boolean>;
  settle(id: string, actual: number, tokens: number): Promise<void>;
}

export function openStore(env = process.env): CommandStore {
  if (env.COMMAND_STORE === "firestore") {
    if (env.GOOGLE_CLOUD_PROJECT !== projectId || env.FIRESTORE_DATABASE !== "zioncore-command" ||
        env.FIRESTORE_EMULATOR_HOST) throw new Error("Command requires the dedicated production Firestore database");
    return firestoreStore(paidAiMonthlyCap(env));
  }
  if (env.NODE_ENV === "production" || env.COMMAND_STORE && env.COMMAND_STORE !== "sqlite") {
    throw new Error("Production must explicitly select Firestore");
  }
  return sqliteStore(resolve(env.COMMAND_SQLITE_PATH ?? resolve(import.meta.dirname, "../../../.local/command/preview.sqlite")),paidAiMonthlyCap(env));
}

function sqliteStore(path: string, monthlyPaidAiAllowanceMicros:number): CommandStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, programme TEXT, text TEXT, status TEXT, submitted INTEGER);
    CREATE TABLE IF NOT EXISTS suggestion_ledger(id TEXT PRIMARY KEY, programme TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, submitted INTEGER NOT NULL, reviewed_at TEXT, topic TEXT);
    CREATE TABLE IF NOT EXISTS suggestion_reviews(id INTEGER PRIMARY KEY, suggestion_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS suggestion_reviews_by_suggestion ON suggestion_reviews(suggestion_id,id);
    CREATE TABLE IF NOT EXISTS spend(day TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, day TEXT NOT NULL, amount INTEGER NOT NULL);`);
  db.exec("CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const inboxColumns=db.prepare("PRAGMA table_info(inbox)").all() as {name:string}[];
  if(!inboxColumns.some(column=>column.name==="resource_url")) db.exec("ALTER TABLE inbox ADD COLUMN resource_url TEXT");
  const tx = <T>(f: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const r = f(); db.exec("COMMIT"); return r; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  const get = (id: string): Slot | undefined => {
    const row = db.prepare("SELECT value FROM slots WHERE id=?").get(id);
    return row ? JSON.parse(String(row.value)) : undefined;
  };
  const set = (id: string, value: Slot) =>
    db.prepare("INSERT INTO slots VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id, JSON.stringify(value));
  const getSpend = (day: string): Budget => {
    const row = db.prepare("SELECT value FROM spend WHERE day=?").get(day);
    return row ? JSON.parse(String(row.value)) : { reserved: 0, settled: 0, tokens: 0 };
  };
  const setSpend = (day: string, budget: Budget) =>
    db.prepare("INSERT INTO spend VALUES(?,?) ON CONFLICT(day) DO UPDATE SET value=excluded.value").run(day, JSON.stringify(budget));
  return {
    production: false,
    async list() {
      return db.prepare("SELECT value FROM slots WHERE json_extract(value,'$.status')='complete' ORDER BY json_extract(value,'$.run.finishedAt') DESC LIMIT 24")
        .all().map(row => normalizeRun((JSON.parse(String(row.value)) as Slot).run!));
    },
    async claim(id) {
      return tx(() => {
        const next = nextSlot(get(id));
        if (!next) return null;
        set(id, next);
        return { id, token: next.token };
      });
    },
    async complete(lease, run, knowledge) {
      tx(() => {
        const old=get(lease.id);checkLease(old,lease);
        for(const {entry:learned,outcome} of knowledge) {
          const saved=db.prepare("SELECT value FROM knowledge WHERE id=?").get(learned.id);
          const entry=saved ? JSON.parse(String(saved.value)) as LearningEntry : learned;
          const updated=sealEvaluation(entry,{runId:run.id,outcome,recordedAt:run.finishedAt});
          db.prepare("INSERT INTO knowledge VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(updated.id,JSON.stringify(updated));
        }
        set(lease.id,{...old,status:"complete",run});
      });
    },
    async knowledge() {
      return db.prepare("SELECT value FROM knowledge ORDER BY id").all()
        .map(row=>currentKnowledge(JSON.parse(String(row.value)) as LearningEntry));
    },
    async importKnowledge(snapshot) {
      const verified=verifySnapshot(snapshot);
      tx(()=>{
        for(const entry of verified.entries) {
          const existing=db.prepare("SELECT value FROM knowledge WHERE id=?").get(entry.id);
          if(existing) {
            if(JSON.stringify(JSON.parse(String(existing.value)))!==JSON.stringify(entry)) throw new Error("Knowledge conflicts with existing local entry");
          } else db.prepare("INSERT INTO knowledge VALUES(?,?)").run(entry.id,JSON.stringify(entry));
        }
      });
    },
    async allRunMetrics() {
      const rows=db.prepare("SELECT value FROM slots WHERE json_extract(value,'$.status')='complete'").all();
      const runs=rows.map(row=>normalizeRun((JSON.parse(String(row.value)) as Slot).run!)).filter(run=>run.learning.tracking==="measured");
      const period=billingMonth(),spend=getSpend(period);
      return {internalMissionRuns:runs.filter(r=>r.outcome==="completed"&&r.learning.knowledgeReused&&r.learning.verification==="passed"&&r.learning.externalAiCalls===0&&r.learning.paidAiCalls===0).length,
        externallyAssistedRuns:runs.filter(r=>r.learning.externalAiCalls>0).length,
        paidAiCalls:runs.reduce((n,r)=>n+r.learning.paidAiCalls,0),billingPeriod:period,
        monthlyPaidAiSpendMicros:spend.settled,monthlyPaidAiReservedMicros:spend.reserved,
        monthlyPaidAiRequests:spend.requests??0,monthlyPaidAiAllowanceMicros};
    },
    async enqueue(input) {
      return tx(() => {
        const now = Date.now();
        db.prepare(`INSERT OR IGNORE INTO suggestion_ledger(id,programme,status,reason,submitted)
          SELECT id,COALESCE(programme,''),'queued','Awaiting individual review.',submitted FROM inbox WHERE submitted < ?`)
          .run(now - 7 * 86_400_000);
        db.prepare("DELETE FROM inbox WHERE submitted < ?").run(now - 7 * 86_400_000);
        const { total } = db.prepare("SELECT count(*) AS total FROM inbox WHERE submitted>?").get(now - 60_000)!;
        if (Number(total) >= 5) throw new Error("inbox-limit");
        const id = randomUUID();
        db.prepare("INSERT INTO inbox(id,programme,text,status,submitted,resource_url) VALUES(?,?,?,?,?,?)")
          .run(id,input.programme,input.text,"queued",now,input.resourceUrl??null);
        db.prepare("INSERT INTO suggestion_ledger(id,programme,status,reason,submitted) VALUES(?,?,?,?,?)")
          .run(id,input.programme,"queued","Awaiting individual review.",now);
        return id;
      });
    },
    async getReceipt(id) {
      const row=db.prepare("SELECT status FROM suggestion_ledger WHERE id=? UNION ALL SELECT 'queued' AS status FROM inbox WHERE id=? AND NOT EXISTS (SELECT 1 FROM suggestion_ledger WHERE id=?) LIMIT 1").get(id,id,id);
      return row?{status:String(row.status)}:null;
    },
    async review() {
      return {reviewed:0,programmeCounts:{},selected:null};
    },
    async listResearchCandidates(after="") {
      const rows=db.prepare("SELECT id,programme,topic FROM suggestion_ledger WHERE status='accepted' AND id<>? AND id>? ORDER BY id LIMIT 25").all(excludedReceipt,after);
      return rankSuggestions(rows.map(row=>({id:String(row.id),programme:String(row.programme),topic:row.topic===null?null:String(row.topic)})));
    },
    async listSuggestions(after="",limit=50) {
      return db.prepare(`WITH records AS (
        SELECT l.id,l.programme,i.text,i.resource_url,l.status,l.reason,l.reviewed_at,l.submitted,l.topic
        FROM suggestion_ledger l LEFT JOIN inbox i ON i.id=l.id
        UNION ALL
        SELECT i.id,i.programme,i.text,i.resource_url,'queued','Awaiting individual review.',NULL,i.submitted,NULL
        FROM inbox i WHERE NOT EXISTS (SELECT 1 FROM suggestion_ledger l WHERE l.id=i.id))
        SELECT * FROM records WHERE id>? ORDER BY id LIMIT ?`)
        .all(after, Math.max(1,Math.min(100,limit))).map(row=>({
          id:String(row.id),programme:String(row.programme),...(row.text===null?{}:{text:String(row.text)}),
          ...(row.resource_url ? {resourceUrl:String(row.resource_url)} : {}),
          status:String(row.status),reason:row.reason===null?null:String(row.reason),
          reviewedAt:row.reviewed_at===null?null:String(row.reviewed_at),
          submittedAt:new Date(Number(row.submitted)).toISOString(),
          topic:row.topic===null?null:String(row.topic),
          history:db.prepare("SELECT status,reason,at FROM suggestion_reviews WHERE suggestion_id=? ORDER BY id DESC LIMIT 25").all(String(row.id))
            .map(event=>({status:String(event.status),reason:String(event.reason),at:String(event.at)})),
        }));
    },
    async setSuggestionReview(id,decision) {
      validateDecision(decision);
      if(id===excludedReceipt && decision.status==="accepted") return false;
      return tx(()=>{
        const at=new Date().toISOString();
        const row=db.prepare("SELECT id FROM suggestion_ledger WHERE id=?").get(id);
        if(!row) {
          const legacy=db.prepare("SELECT programme,submitted FROM inbox WHERE id=?").get(id);
          if(!legacy) return false;
          db.prepare("INSERT INTO suggestion_ledger(id,programme,status,reason,submitted) VALUES(?,?,?,?,?)")
            .run(id,String(legacy.programme),"queued","Awaiting individual review.",Number(legacy.submitted));
        }
        const updated=Number(db.prepare("UPDATE suggestion_ledger SET status=?,reason=?,reviewed_at=?,topic=? WHERE id=?")
          .run(decision.status,decision.reason,at,decision.topic??null,id).changes)>0;
        if(updated) db.prepare("INSERT INTO suggestion_reviews(suggestion_id,status,reason,at) VALUES(?,?,?,?)")
          .run(id,decision.status,decision.reason,at);
        return updated;
      });
    },
    async reserve(id, amount, cap) {
      return tx(() => {
        if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(cap)||cap<=0)return false;
        const day = billingMonth();
        const budget = getSpend(day);
        if (budget.reserved + budget.settled + amount > cap) return false;
        db.prepare("INSERT INTO reservations VALUES(?,?,?)").run(id,day,amount);
        setSpend(day,{ ...budget,reserved: budget.reserved+amount,requests:(budget.requests??0)+1 });
        return true;
      });
    },
    async settle(id, amount, tokens) {
      if(!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(tokens)||tokens<0)throw new Error("Invalid paid usage settlement");
      tx(() => {
        const row = db.prepare("SELECT day,amount FROM reservations WHERE id=?").get(id);
        if (!row) return;
        const day = String(row.day);
        const budget = getSpend(day);
        setSpend(day,{ reserved: budget.reserved-Number(row.amount),settled: budget.settled+amount,
          tokens:budget.tokens+tokens,requests:budget.requests??0 });
        db.prepare("DELETE FROM reservations WHERE id=?").run(id);
      });
    },
  };
}

function validateDecision(decision:SuggestionDecision) {
  if(!["queued","accepted","rejected","completed"].includes(decision.status) ||
      typeof decision.reason!=="string" || decision.reason.trim().length<5 || decision.reason.length>500 ||
      decision.topic!==undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(decision.topic))
    throw new Error("Invalid suggestion decision");
}

function rankSuggestions(rows:{id:string;programme:string;topic:string|null}[]) {
  const topics=new Map<string,number>();
  const key=(row:typeof rows[number])=>`${row.programme}:${row.topic??row.id}`;
  for(const row of rows) topics.set(key(row),(topics.get(key(row))??0)+1);
  const nextCursor=rows.length===25?rows[rows.length-1]!.id:null;
  const candidates=rows.map(row=>({id:row.id,programme:row.programme,relatedCount:topics.get(key(row))!,relatedCountScope:"current-page-only" as const}))
    .sort((a,b)=>b.relatedCount-a.relatedCount || a.id.localeCompare(b.id));
  return {candidates,nextCursor,rankingScope:"current-page-only" as const};
}

function normalizeRun(value:unknown):CommandRun {
  const run=value as CommandRun;
  if(run.learning)return run;
  return {...run,learning:{
    tracking:"legacy",mission:"historical-untracked",methodId:"untracked",methodVersion:"untracked",
    knowledgeId:null,knowledgeReused:false,verification:"not-run",externalAiMode:"unknown",
    externalAiCalls:0,paidAiCalls:0,paidCostMicros:0,
  }};
}

function nextSlot(previous: Slot | undefined): Slot | null {
  if (previous && (previous.status === "complete" || previous.until > Date.now() || previous.attempts >= 3)) return null;
  return { token: randomUUID(), until: Date.now()+leaseMs, attempts:(previous?.attempts ?? 0)+1,status:"running" };
}

function checkLease(slot: Slot | undefined, lease: Lease): asserts slot is Slot {
  if (!slot || slot.token !== lease.token || slot.until < Date.now() || slot.status !== "running") throw new Error("Lease lost");
}

const billingMonth = () => new Date(Date.now()-8*60*60_000).toISOString().slice(0,7);

function firestoreStore(monthlyPaidAiAllowanceMicros:number): CommandStore {
  const db = new Firestore({ projectId, databaseId:"zioncore-command" });
  const inboxDb = new Firestore({ projectId, databaseId:"zioncore-command-inbox" });
  const slots = db.collection("commandSlots");
  const runs = db.collection("commandPublicRuns");
  const inbox = inboxDb.collection("commandInbox");
  const ledger = inboxDb.collection("commandSuggestionLedger");
  const spending = db.collection("commandSpending");
  const reservations = db.collection("commandReservations");
  const globalLimit = inboxDb.doc("commandControl/intake");
  const learningStats=db.doc("commandMetadata/learningStats");
  return {
    production:true,
    async list() { return (await runs.orderBy("finishedAt","desc").limit(24).get()).docs.map(doc => normalizeRun(doc.data())); },
    async claim(id) {
      return db.runTransaction(async tr => {
        const ref = slots.doc(id);
        const next = nextSlot((await tr.get(ref)).data() as Slot | undefined);
        if (!next) return null;
        tr.set(ref,next);
        return { id, token:next.token };
      });
    },
    async complete(lease, run, knowledge) {
      await db.runTransaction(async tr => {
        const ref = slots.doc(lease.id);
        const old = (await tr.get(ref)).data() as Slot | undefined;
        checkLease(old,lease);
        const stats=(await tr.get(learningStats)).data() as {internalMissionRuns:number;externallyAssistedRuns:number;paidAiCalls:number}|undefined;
        const knowledgeRefs=knowledge.map(({entry})=>db.collection("commandKnowledge").doc(entry.id));
        const existing=await Promise.all(knowledgeRefs.map(ref=>tr.get(ref)));
        tr.update(ref,{ status:"complete" });
        tr.create(runs.doc(lease.id),run);
        knowledge.forEach(({entry,outcome},index)=>{
          const saved=existing[index]?.data() as LearningEntry|undefined;
          const updated=sealEvaluation(saved??entry,{runId:run.id,outcome,recordedAt:run.finishedAt});
          tr.set(knowledgeRefs[index]!,updated);
        });
        tr.set(learningStats,{
          internalMissionRuns:(stats?.internalMissionRuns??0)+Number(run.outcome==="completed"&&run.learning.tracking==="measured"&&run.learning.knowledgeReused&&run.learning.verification==="passed"&&run.learning.externalAiCalls===0&&run.learning.paidAiCalls===0),
          externallyAssistedRuns:(stats?.externallyAssistedRuns??0)+Number(run.learning.tracking==="measured"&&run.learning.externalAiCalls>0),
          paidAiCalls:(stats?.paidAiCalls??0)+(run.learning.tracking==="measured"?run.learning.paidAiCalls:0),
        });
      });
    },
    async knowledge() {
      const snapshot=await db.collection("commandKnowledge").limit(400).get();
      return snapshot.docs.map(doc=>currentKnowledge(doc.data() as LearningEntry));
    },
    async importKnowledge(snapshot) {
      const verified=verifySnapshot(snapshot);
      const batch=db.batch();
      for(const entry of verified.entries) {
        const ref=db.collection("commandKnowledge").doc(entry.id);
        const existing=await ref.get();
        if(existing.exists) {
          if(JSON.stringify(existing.data())!==JSON.stringify(entry)) throw new Error("Knowledge conflicts with existing Firestore entry");
        } else batch.create(ref,entry);
      }
      if(verified.entries.length) await batch.commit();
    },
    async allRunMetrics() {
      const stats=(await learningStats.get()).data() as {internalMissionRuns:number;externallyAssistedRuns:number;paidAiCalls:number}|undefined;
      const period=billingMonth(),budget=(await spending.doc(period).get()).data() as Budget|undefined;
      return {internalMissionRuns:stats?.internalMissionRuns??0,
        externallyAssistedRuns:stats?.externallyAssistedRuns??0,paidAiCalls:stats?.paidAiCalls??0,
        billingPeriod:period,monthlyPaidAiSpendMicros:budget?.settled??0,monthlyPaidAiReservedMicros:budget?.reserved??0,
        monthlyPaidAiRequests:budget?.requests??0,monthlyPaidAiAllowanceMicros};
    },
    async enqueue(input) {
      if (process.env.COMMAND_ENABLE_INTAKE !== "1") throw new Error("intake-disabled");
      const ref = inbox.doc();
      await inboxDb.runTransaction(async tr => {
        const old = (await tr.get(globalLimit)).data();
        const minute = Math.floor(Date.now()/60_000);
        const count = old?.minute === minute ? Number(old.count) : 0;
        if (count >= 5) throw new Error("inbox-limit");
        tr.set(globalLimit,{ minute,count:count+1 });
        const now=new Date();
        tr.create(ref,{ ...input,resourceUrl:input.resourceUrl??null,status:"queued",submittedAt:now,expiresAt:new Date(+now+7*86_400_000) });
        tr.create(ledger.doc(ref.id),{programme:input.programme,status:"queued",reason:"Awaiting individual review.",submittedAt:now});
      });
      return ref.id;
    },
    async getReceipt(id) {
      const [saved,raw]=await inboxDb.getAll(ledger.doc(id),inbox.doc(id));
      if(saved?.exists) return {status:String(saved.get("status"))};
      return raw?.exists?{status:"queued"}:null;
    },
    async review() {
      return {reviewed:0,programmeCounts:{},selected:null};
    },
    async listResearchCandidates(after="") {
      let query=ledger.where("status","==","accepted").orderBy("__name__").limit(26);
      if(after) query=query.startAfter(after);
      const snapshot=await query.get();
      const rows=snapshot.docs.filter(doc=>doc.id!==excludedReceipt).slice(0,25).map(doc=>({
        id:doc.id,programme:String(doc.get("programme")),topic:typeof doc.get("topic")==="string"?String(doc.get("topic")):null,
      }));
      return rankSuggestions(rows);
    },
    async listSuggestions(after="",limit=50) {
      const size=Math.max(1,Math.min(100,limit));
      let ledgerQuery=ledger.orderBy("__name__").limit(size),inboxQuery=inbox.orderBy("__name__").limit(size);
      if(after) {ledgerQuery=ledgerQuery.startAfter(after);inboxQuery=inboxQuery.startAfter(after);}
      const [ledgerPage,inboxPage]=await Promise.all([ledgerQuery.get(),inboxQuery.get()]);
      const ids=[...new Set([...ledgerPage.docs.map(doc=>doc.id),...inboxPage.docs.map(doc=>doc.id)])].sort().slice(0,size);
      if(!ids.length) return [];
      const [ledgerDocs,inboxDocs]=await Promise.all([
        inboxDb.getAll(...ids.map(id=>ledger.doc(id))),inboxDb.getAll(...ids.map(id=>inbox.doc(id))),
      ]);
      return Promise.all(ids.map(async(id,index)=>{
        const data=ledgerDocs[index]?.data(),raw=inboxDocs[index]?.data();
        const history=await ledger.doc(id).collection("reviews").orderBy("at","desc").limit(25).get();
        return {id,programme:String(data?.programme??raw?.programme??""),...(raw?.text?{text:String(raw.text)}:{}),
          ...(raw?.resourceUrl?{resourceUrl:String(raw.resourceUrl)}:{}),status:String(data?.status??"queued"),
          reason:typeof data?.reason==="string"?data.reason:"Awaiting individual review.",
          reviewedAt:typeof data?.reviewedAt==="string"?data.reviewedAt:null,
          submittedAt:(data?.submittedAt??raw?.submittedAt)?.toDate?.().toISOString()??new Date(0).toISOString(),
          topic:typeof data?.topic==="string"?data.topic:null,
          history:history.docs.map(doc=>doc.data() as ReviewEvent)};
      }));
    },
    async setSuggestionReview(id,decision) {
      validateDecision(decision);
      if(id===excludedReceipt && decision.status==="accepted") return false;
      return inboxDb.runTransaction(async tr=>{
        const ref=ledger.doc(id),[doc,raw]=await Promise.all([tr.get(ref),tr.get(inbox.doc(id))]);
        if(!doc.exists && !raw.exists) return false;
        const data=doc.data()??{programme:raw.get("programme"),submittedAt:raw.get("submittedAt")};
        const at=new Date().toISOString();
        tr.set(ref,{...data,...decision,topic:decision.topic??null,reviewedAt:at});
        tr.create(ref.collection("reviews").doc(),{status:decision.status,reason:decision.reason,at});
        return true;
      });
    },
    async reserve(id, amount, cap) {
      if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(cap)||cap<=0)return false;
      const day = billingMonth(), ref = spending.doc(day);
      return db.runTransaction(async tr => {
        const budget = (await tr.get(ref)).data() as Budget | undefined ?? { reserved:0,settled:0,tokens:0 };
        if (budget.reserved+budget.settled+amount > cap) return false;
        tr.create(reservations.doc(id),{ day,amount });
        tr.set(ref,{ ...budget,reserved:budget.reserved+amount,requests:(budget.requests??0)+1 });
        return true;
      });
    },
    async settle(id, amount, tokens) {
      if(!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(tokens)||tokens<0)throw new Error("Invalid paid usage settlement");
      await db.runTransaction(async tr => {
        const reservation = reservations.doc(id);
        const saved = (await tr.get(reservation)).data();
        if (!saved) return;
        const ref = spending.doc(String(saved.day));
        const budget = (await tr.get(ref)).data() as Budget;
        tr.set(ref,{ reserved:budget.reserved-Number(saved.amount),settled:budget.settled+amount,
          tokens:budget.tokens+tokens,requests:budget.requests??0 });
        tr.delete(reservation);
      });
    },
  };
}
