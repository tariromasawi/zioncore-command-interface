import { Firestore } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommandRun, LearningEntry } from "@workspace/api-zod";
import { currentKnowledge, sealEvaluation, verifySnapshot, type KnowledgeSnapshot } from "./knowledge";
import { paidAiMonthlyCap } from "./genesis";
import { validDailyRecord, type DailyResearchRecord } from "./dailyResearch";

const projectId = "gen-lang-client-0266144152";
const leaseMs = 4 * 60_000;
type Lease = { id: string; token: string };
type Slot = { token: string; until: number; attempts: number; status: string; run?: CommandRun };
type Suggestion = { programme: string; text: string; resourceUrl?:string };
type Budget = { reserved: number; settled: number; tokens: number; requests?:number };
export type SuggestionTriage={reviewed:number;programmeCounts:Record<string,number>};
export type KnowledgeOutcome={entry:LearningEntry;outcome:"passed"|"failed"};

export interface CommandStore {
  readonly production: boolean;
  list(): Promise<CommandRun[]>;
  claim(id: string): Promise<Lease | null>;
  complete(lease: Lease, run: CommandRun, knowledge: KnowledgeOutcome[], research?:DailyResearchRecord): Promise<void>;
  dailyResearch(): Promise<DailyResearchRecord[]>;
  knowledge(): Promise<LearningEntry[]>;
  importKnowledge(snapshot: KnowledgeSnapshot): Promise<void>;
  allRunMetrics(): Promise<{internalMissionRuns:number;externallyAssistedRuns:number;paidAiCalls:number;
    billingPeriod:string;monthlyPaidAiSpendMicros:number;monthlyPaidAiReservedMicros:number;monthlyPaidAiRequests:number;monthlyPaidAiAllowanceMicros:number}>;
  enqueue(input: Suggestion): Promise<string>;
  review(): Promise<SuggestionTriage>;
  reserve(id: string, amount: number, cap: number, scope?:string, scopeCap?:number): Promise<boolean>;
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
    CREATE TABLE IF NOT EXISTS spend(day TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, day TEXT NOT NULL, amount INTEGER NOT NULL);`);
  db.exec("CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS daily_research(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS execution_spend(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const reservationColumns=db.prepare("PRAGMA table_info(reservations)").all() as {name:string}[];
  if(!reservationColumns.some(column=>column.name==="scope")) db.exec("ALTER TABLE reservations ADD COLUMN scope TEXT");
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
    async complete(lease, run, knowledge, research) {
      tx(() => {
        const old=get(lease.id);checkLease(old,lease);
        if(run.id!==lease.id || (research && (!validDailyRecord(research) || research.sourceRunId!==lease.id || run.kind!=="daily-review")))
          throw new Error("Invalid research or run identity");
        for(const {entry:learned,outcome} of knowledge) {
          const saved=db.prepare("SELECT value FROM knowledge WHERE id=?").get(learned.id);
          const entry=saved ? JSON.parse(String(saved.value)) as LearningEntry : learned;
          const updated=sealEvaluation(entry,{runId:run.id,outcome,recordedAt:run.finishedAt});
          db.prepare("INSERT INTO knowledge VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(updated.id,JSON.stringify(updated));
        }
        if(research) db.prepare("INSERT INTO daily_research VALUES(?,?)").run(research.id,JSON.stringify(research));
        set(lease.id,{...old,status:"complete",run});
      });
    },
    async dailyResearch() {
      // Inspect a bounded newest-first window; malformed records are skipped, never used.
      return db.prepare("SELECT id,value FROM daily_research WHERE json_valid(value) ORDER BY json_extract(value,'$.sourceRunId') DESC,id DESC LIMIT 400").all().flatMap(row=>{
        try {
          const value:unknown=JSON.parse(String(row.value));
          return validDailyRecord(value) && value.id===row.id?[value]:[];
        } catch {return [];}
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
        db.prepare("DELETE FROM inbox WHERE submitted < ?").run(now - 7 * 86_400_000);
        const { total } = db.prepare("SELECT count(*) AS total FROM inbox WHERE submitted>?").get(now - 60_000)!;
        if (Number(total) >= 5) throw new Error("inbox-limit");
        const id = randomUUID();
        db.prepare("INSERT INTO inbox(id,programme,text,status,submitted,resource_url) VALUES(?,?,?,?,?,?)")
          .run(id,input.programme,input.text,"queued",now,input.resourceUrl??null);
        return id;
      });
    },
    async review() {
      const selected=tx(()=>{
        const rows=db.prepare("SELECT id,programme FROM inbox WHERE status='queued' ORDER BY submitted LIMIT 25").all() as {id:string;programme:string}[];
        const update=db.prepare("UPDATE inbox SET status='triaged' WHERE id=? AND status='queued'");
        rows.forEach(item=>update.run(item.id));
        return rows;
      });
      const programmeCounts:Record<string,number>={};
      for(const item of selected) programmeCounts[item.programme]=(programmeCounts[item.programme]??0)+1;
      return {reviewed:selected.length,programmeCounts};
    },
    async reserve(id, amount, cap, scope, scopeCap) {
      return tx(() => {
        if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(cap)||cap<=0)return false;
        if(scope!==undefined && (!/^daily-\d{4}-\d{2}-\d{2}$/.test(scope) || !Number.isSafeInteger(scopeCap) || scopeCap!<=0 || scopeCap!>15_000_000))return false;
        const day = billingMonth();
        const budget = getSpend(day);
        if (budget.reserved + budget.settled + amount > cap) return false;
        if(scope) {
          const row=db.prepare("SELECT value FROM execution_spend WHERE id=?").get(scope);
          const execution:Budget=row?JSON.parse(String(row.value)):{reserved:0,settled:0,tokens:0};
          if(execution.reserved+execution.settled+amount>scopeCap!)return false;
          db.prepare("INSERT INTO execution_spend VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
            .run(scope,JSON.stringify({...execution,reserved:execution.reserved+amount}));
        }
        db.prepare("INSERT INTO reservations(id,day,amount,scope) VALUES(?,?,?,?)").run(id,day,amount,scope??null);
        setSpend(day,{ ...budget,reserved: budget.reserved+amount,requests:(budget.requests??0)+1 });
        return true;
      });
    },
    async settle(id, amount, tokens) {
      if(!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(tokens)||tokens<0)throw new Error("Invalid paid usage settlement");
      tx(() => {
        const row = db.prepare("SELECT day,amount,scope FROM reservations WHERE id=?").get(id);
        if (!row) return;
        if(amount>Number(row.amount))throw new Error("Settlement exceeds reservation");
        const day = String(row.day);
        const budget = getSpend(day);
        setSpend(day,{ reserved: budget.reserved-Number(row.amount),settled: budget.settled+amount,
          tokens:budget.tokens+tokens,requests:budget.requests??0 });
        if(row.scope) {
          const scope=String(row.scope),saved=db.prepare("SELECT value FROM execution_spend WHERE id=?").get(scope);
          if(!saved)throw new Error("Missing execution budget");
          const execution=JSON.parse(String(saved.value)) as Budget;
          db.prepare("UPDATE execution_spend SET value=? WHERE id=?").run(JSON.stringify({
            ...execution,reserved:execution.reserved-Number(row.amount),settled:execution.settled+amount,tokens:execution.tokens+tokens,
          }),scope);
        }
        db.prepare("DELETE FROM reservations WHERE id=?").run(id);
      });
    },
  };
}

function normalizeRun(value:unknown):CommandRun {
  const run=value as CommandRun;
  if(run.learning)return {...run,learning:{...run.learning,
    paidCostMicros:run.learning.externalAiCalls || run.learning.paidAiCalls || run.learning.externalAiMode==="unknown"
      ? null:run.learning.paidCostMicros}};
  return {...run,learning:{
    tracking:"legacy",mission:"historical-untracked",methodId:"untracked",methodVersion:"untracked",
    knowledgeId:null,knowledgeReused:false,verification:"not-run",externalAiMode:"unknown",
    externalAiCalls:0,paidAiCalls:0,paidCostMicros:null,
  }};
}

function nextSlot(previous: Slot | undefined): Slot | null {
  if (previous && (previous.status === "complete" || previous.until > Date.now() || previous.attempts >= 3)) return null;
  return { token: randomUUID(), until: Date.now()+leaseMs, attempts:(previous?.attempts ?? 0)+1,status:"running" };
}

function checkLease(slot: Slot | undefined, lease: Lease): asserts slot is Slot {
  if (!slot || slot.token !== lease.token || slot.until < Date.now() || slot.status !== "running") throw new Error("Lease lost");
}

export function billingMonth(now=new Date()) {
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit"}).formatToParts(now);
  return `${parts.find(part=>part.type==="year")!.value}-${parts.find(part=>part.type==="month")!.value}`;
}

function firestoreStore(monthlyPaidAiAllowanceMicros:number): CommandStore {
  const db = new Firestore({ projectId, databaseId:"zioncore-command" });
  const inboxDb = new Firestore({ projectId, databaseId:"zioncore-command-inbox" });
  const slots = db.collection("commandSlots");
  const runs = db.collection("commandPublicRuns");
  const inbox = inboxDb.collection("commandInbox");
  const spending = db.collection("commandSpending");
  const reservations = db.collection("commandReservations");
  const executionSpending=db.collection("commandExecutionSpending");
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
    async complete(lease, run, knowledge, research) {
      await db.runTransaction(async tr => {
        const ref = slots.doc(lease.id);
        const old = (await tr.get(ref)).data() as Slot | undefined;
        checkLease(old,lease);
        if(run.id!==lease.id || (research && (!validDailyRecord(research) || research.sourceRunId!==lease.id || run.kind!=="daily-review")))
          throw new Error("Invalid research or run identity");
        const stats=(await tr.get(learningStats)).data() as {internalMissionRuns:number;externallyAssistedRuns:number;paidAiCalls:number}|undefined;
        const knowledgeRefs=knowledge.map(({entry})=>db.collection("commandKnowledge").doc(entry.id));
        const existing=await Promise.all(knowledgeRefs.map(ref=>tr.get(ref)));
        tr.update(ref,{ status:"complete" });
        tr.create(runs.doc(lease.id),run);
        if(research) tr.create(db.collection("commandDailyResearch").doc(research.id),research);
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
    async dailyResearch() {
      const snapshot=await db.collection("commandDailyResearch").orderBy("sourceRunId","desc").limit(400).get();
      return snapshot.docs.flatMap(doc=>{
        const value:unknown=doc.data();
        return validDailyRecord(value) && value.id===doc.id?[value]:[];
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
        tr.create(ref,{ ...input,resourceUrl:input.resourceUrl??null,status:"queued",submittedAt: new Date(),expiresAt: new Date(Date.now()+7*86_400_000) });
      });
      return ref.id;
    },
    async review() {
      const snapshot = await inbox.where("status","==","queued").limit(25).get();
      const programmeCounts:Record<string,number>={};
      const batch = inboxDb.batch();
      snapshot.docs.forEach(doc => {
        const programme=String(doc.get("programme"));
        if(["continuity","prosperity","heritage","preparedness"].includes(programme))
          programmeCounts[programme]=(programmeCounts[programme]??0)+1;
        batch.update(doc.ref,{ status:"triaged" },{lastUpdateTime:doc.updateTime});
      });
      if (!snapshot.empty) await batch.commit();
      return {reviewed:snapshot.size,programmeCounts};
    },
    async reserve(id, amount, cap, scope, scopeCap) {
      if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(cap)||cap<=0)return false;
      if(scope!==undefined && (!/^daily-\d{4}-\d{2}-\d{2}$/.test(scope) || !Number.isSafeInteger(scopeCap) || scopeCap!<=0 || scopeCap!>15_000_000))return false;
      const day = billingMonth(), ref = spending.doc(day);
      return db.runTransaction(async tr => {
        const budget = (await tr.get(ref)).data() as Budget | undefined ?? { reserved:0,settled:0,tokens:0 };
        const executionRef=scope?executionSpending.doc(scope):undefined;
        const execution=executionRef?(await tr.get(executionRef)).data() as Budget|undefined:undefined;
        if (budget.reserved+budget.settled+amount > cap) return false;
        if(executionRef && (execution?.reserved??0)+(execution?.settled??0)+amount>scopeCap!)return false;
        tr.create(reservations.doc(id),{ day,amount,...(scope?{scope}:{}) });
        tr.set(ref,{ ...budget,reserved:budget.reserved+amount,requests:(budget.requests??0)+1 });
        if(executionRef)tr.set(executionRef,{reserved:(execution?.reserved??0)+amount,settled:execution?.settled??0,tokens:execution?.tokens??0});
        return true;
      });
    },
    async settle(id, amount, tokens) {
      if(!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(tokens)||tokens<0)throw new Error("Invalid paid usage settlement");
      await db.runTransaction(async tr => {
        const reservation = reservations.doc(id);
        const saved = (await tr.get(reservation)).data();
        if (!saved) return;
        if(amount>Number(saved.amount))throw new Error("Settlement exceeds reservation");
        const ref = spending.doc(String(saved.day));
        const budget = (await tr.get(ref)).data() as Budget;
        const executionRef=saved.scope?executionSpending.doc(String(saved.scope)):undefined;
        const execution=executionRef?(await tr.get(executionRef)).data() as Budget|undefined:undefined;
        if(executionRef&&!execution)throw new Error("Missing execution budget");
        tr.set(ref,{ reserved:budget.reserved-Number(saved.amount),settled:budget.settled+amount,
          tokens:budget.tokens+tokens,requests:budget.requests??0 });
        if(executionRef && execution)tr.set(executionRef,{...execution,reserved:execution.reserved-Number(saved.amount),
          settled:execution.settled+amount,tokens:execution.tokens+tokens});
        tr.delete(reservation);
      });
    },
  };
}
