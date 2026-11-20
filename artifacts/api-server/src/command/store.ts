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
type Suggestion = { programme: string; text: string };
type Budget = { reserved: number; settled: number; tokens: number; requests?:number };
export type SuggestionTriage={reviewed:number;programmeCounts:Record<string,number>};
export type KnowledgeOutcome={entry:LearningEntry;outcome:"passed"|"failed"};

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
  review(): Promise<SuggestionTriage>;
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
    CREATE TABLE IF NOT EXISTS spend(day TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, day TEXT NOT NULL, amount INTEGER NOT NULL);`);
  db.exec("CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
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
        db.prepare("DELETE FROM inbox WHERE submitted < ?").run(now - 7 * 86_400_000);
        const { total } = db.prepare("SELECT count(*) AS total FROM inbox WHERE submitted>?").get(now - 60_000)!;
        if (Number(total) >= 5) throw new Error("inbox-limit");
        const id = randomUUID();
        db.prepare("INSERT INTO inbox VALUES(?,?,?,?,?)").run(id,input.programme,input.text,"queued",now);
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
        tr.create(ref,{ ...input,status:"queued",submittedAt: new Date(),expiresAt: new Date(Date.now()+7*86_400_000) });
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
