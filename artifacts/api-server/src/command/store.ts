import { Firestore } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommandRun, LearningEntry } from "@workspace/api-zod";
import { currentKnowledge, sealEvaluation, verifySnapshot, type KnowledgeSnapshot } from "./knowledge";
import { createKnowledgeVersion, knowledgePointer, legacyKnowledgeVersion, verifyKnowledgeVersion, type KnowledgeVersionRecord } from "./knowledgeVersions";
import { archiveKnowledgeVersion, readKnowledgeVersions } from "./knowledgeArchive";
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

export function firestoreReservationSettlement(
  saved: {amount?:unknown;status?:unknown}|undefined,
  actual:number,
  tokens:number,
  settledAt:number,
) {
  if(!saved || saved.status==="settled") return null;
  if(actual>Number(saved.amount)) throw new Error("Settlement exceeds reservation");
  return {status:"settled",actual,tokens,settledAt};
}

export interface CommandStore {
  readonly production: boolean;
  list(): Promise<CommandRun[]>;
  claim(id: string): Promise<Lease | null>;
  complete(lease: Lease, run: CommandRun, knowledge: KnowledgeOutcome[], research?:DailyResearchRecord): Promise<void>;
  dailyResearch(): Promise<DailyResearchRecord[]>;
  knowledge(): Promise<LearningEntry[]>;
  knowledgeVersions(): Promise<KnowledgeVersionRecord[]>;
  archiveKnowledgeHistory(): Promise<number>;
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
    return firestoreStore(paidAiMonthlyCap(env),env);
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
    CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, day TEXT NOT NULL, amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved', actual INTEGER, tokens INTEGER, settled_at INTEGER);`);
  db.exec("CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_versions(
    version_id TEXT PRIMARY KEY,knowledge_id TEXT NOT NULL,supersedes TEXT,value TEXT NOT NULL,recorded_at TEXT NOT NULL
  )`);
  db.exec("CREATE TABLE IF NOT EXISTS daily_research(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS execution_spend(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const reservationColumns=db.prepare("PRAGMA table_info(reservations)").all() as {name:string}[];
  const knowledgeColumns=db.prepare("PRAGMA table_info(knowledge)").all() as {name:string}[];
  if(!reservationColumns.some(column=>column.name==="scope")) db.exec("ALTER TABLE reservations ADD COLUMN scope TEXT");
  if(!reservationColumns.some(column=>column.name==="status")) db.exec("ALTER TABLE reservations ADD COLUMN status TEXT NOT NULL DEFAULT 'reserved'");
  if(!reservationColumns.some(column=>column.name==="actual")) db.exec("ALTER TABLE reservations ADD COLUMN actual INTEGER");
  if(!reservationColumns.some(column=>column.name==="tokens")) db.exec("ALTER TABLE reservations ADD COLUMN tokens INTEGER");
  if(!reservationColumns.some(column=>column.name==="settled_at")) db.exec("ALTER TABLE reservations ADD COLUMN settled_at INTEGER");
  if(!knowledgeColumns.some(column=>column.name==="version_id")) db.exec("ALTER TABLE knowledge ADD COLUMN version_id TEXT");
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
          const saved=db.prepare("SELECT value,version_id FROM knowledge WHERE id=?").get(learned.id) as
            {value:string;version_id:string|null}|undefined;
          const entry=saved ? JSON.parse(String(saved.value)) as LearningEntry : learned;
          let previousVersionId=saved?.version_id??null;
          if(saved && !previousVersionId) {
            const legacy=legacyKnowledgeVersion(entry);
            insertKnowledgeVersion(legacy);
            previousVersionId=legacy.versionId;
          }
          const updated=sealEvaluation(entry,{runId:run.id,outcome,recordedAt:run.finishedAt});
          const version=createKnowledgeVersion(updated,previousVersionId,run.finishedAt);
          insertKnowledgeVersion(version);
          db.prepare(`INSERT INTO knowledge(id,value,version_id) VALUES(?,?,?)
            ON CONFLICT(id) DO UPDATE SET value=excluded.value,version_id=excluded.version_id`)
            .run(updated.id,JSON.stringify(updated),version.versionId);
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
    async knowledgeVersions() {
      const stored=db.prepare("SELECT value FROM knowledge_versions ORDER BY recorded_at,version_id").all()
        .map(row=>JSON.parse(String(row.value)) as KnowledgeVersionRecord);
      const known=new Set(stored.map(item=>item.knowledgeId));
      const current=db.prepare("SELECT value FROM knowledge ORDER BY id").all()
        .map(row=>JSON.parse(String(row.value)) as LearningEntry);
      for(const entry of current)if(!known.has(entry.id))stored.push(legacyKnowledgeVersion(entry));
      return stored.sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.versionId.localeCompare(b.versionId));
    },
    async archiveKnowledgeHistory() {
      return (db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get() as {count:number}).count;
    },
    async importKnowledge(snapshot) {
      const verified=verifySnapshot(snapshot);
      tx(()=>{
        for(const entry of verified.entries) {
          const existing=db.prepare("SELECT value,version_id FROM knowledge WHERE id=?").get(entry.id) as
            {value:string;version_id:string|null}|undefined;
          if(existing) {
            if(JSON.stringify(JSON.parse(String(existing.value)))!==JSON.stringify(entry)) throw new Error("Knowledge conflicts with existing local entry");
          } else {
            const version=legacyKnowledgeVersion(entry);
            insertKnowledgeVersion(version);
            db.prepare("INSERT INTO knowledge(id,value,version_id) VALUES(?,?,?)")
              .run(entry.id,JSON.stringify(entry),version.versionId);
          }
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
        const row = db.prepare("SELECT day,amount,scope,status FROM reservations WHERE id=?").get(id);
        if (!row) return;
        if (row.status === "settled") return;
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
        db.prepare("UPDATE reservations SET status='settled',actual=?,tokens=?,settled_at=? WHERE id=?")
          .run(amount,tokens,Date.now(),id);
      });
    },
  };

  function insertKnowledgeVersion(version:KnowledgeVersionRecord) {
    const value=JSON.stringify(version);
    const saved=db.prepare("SELECT value FROM knowledge_versions WHERE version_id=?").get(version.versionId) as
      {value:string}|undefined;
    if(saved) {
      if(String(saved.value)!==value)throw new Error("Knowledge version conflicts with existing history");
      return;
    }
    db.prepare("INSERT INTO knowledge_versions(version_id,knowledge_id,supersedes,value,recorded_at) VALUES(?,?,?,?,?)")
      .run(version.versionId,version.knowledgeId,version.supersedes,value,version.recordedAt);
  }
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

function firestoreStore(monthlyPaidAiAllowanceMicros:number,env:NodeJS.ProcessEnv): CommandStore {
  const knowledgeArchiveBucket=env.COMMAND_KNOWLEDGE_ARCHIVE_BUCKET??"";
  const db = new Firestore({ projectId, databaseId:"zioncore-command" });
  const inboxDb = new Firestore({ projectId, databaseId:"zioncore-command-inbox" });
  const slots = db.collection("commandSlots");
  const runs = db.collection("commandPublicRuns");
  const inbox = inboxDb.collection("commandInbox");
  const spending = db.collection("commandSpending");
  const reservations = db.collection("commandReservations");
  const executionSpending=db.collection("commandExecutionSpending");
  const knowledgeVersions=db.collection("commandKnowledgeVersions");
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
      const committedVersions:KnowledgeVersionRecord[]=[];
      await db.runTransaction(async tr => {
        committedVersions.length=0;
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
          const pointer=knowledgePointer(existing[index]?.data());
          const saved=pointer.entry;
          let previousVersionId=pointer.versionId??null;
          if(saved && !previousVersionId) {
            const legacy=legacyKnowledgeVersion(saved);
            tr.create(knowledgeVersions.doc(legacy.versionId),legacy);
            committedVersions.push(legacy);
            previousVersionId=legacy.versionId;
          }
          const updated=sealEvaluation(saved??entry,{runId:run.id,outcome,recordedAt:run.finishedAt});
          const version=createKnowledgeVersion(updated,previousVersionId,run.finishedAt);
          tr.create(knowledgeVersions.doc(version.versionId),version);
          committedVersions.push(version);
          tr.set(knowledgeRefs[index]!,{entry:updated,versionId:version.versionId});
        });
        tr.set(learningStats,{
          internalMissionRuns:(stats?.internalMissionRuns??0)+Number(run.outcome==="completed"&&run.learning.tracking==="measured"&&run.learning.knowledgeReused&&run.learning.verification==="passed"&&run.learning.externalAiCalls===0&&run.learning.paidAiCalls===0),
          externallyAssistedRuns:(stats?.externallyAssistedRuns??0)+Number(run.learning.tracking==="measured"&&run.learning.externalAiCalls>0),
          paidAiCalls:(stats?.paidAiCalls??0)+(run.learning.tracking==="measured"?run.learning.paidAiCalls:0),
        });
      });
      for(const version of committedVersions)await archiveKnowledgeVersion(version,knowledgeArchiveBucket);
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
      return snapshot.docs.flatMap(doc=>{
        const pointer=knowledgePointer(doc.data());
        return pointer.entry?[currentKnowledge(pointer.entry)]:[];
      });
    },
    async knowledgeVersions() {
      return readKnowledgeVersions(knowledgeArchiveBucket);
    },
    async archiveKnowledgeHistory() {
      const current=await db.collection("commandKnowledge").limit(400).get();
      for(const doc of current.docs) {
        const ref=doc.ref;
        await db.runTransaction(async tr=>{
          const snapshot=await tr.get(ref);
          if(!snapshot.exists)return;
          const pointer=knowledgePointer(snapshot.data());
          if(!pointer.entry)return;
          if(pointer.versionId) {
            const saved=await tr.get(knowledgeVersions.doc(pointer.versionId));
            if(saved.exists)return;
          }
          const version=legacyKnowledgeVersion(pointer.entry);
          const versionRef=knowledgeVersions.doc(version.versionId);
          const saved=await tr.get(versionRef);
          if(!saved.exists)tr.create(versionRef,version);
          tr.set(ref,{entry:pointer.entry,versionId:version.versionId});
        });
      }
      const snapshot=await knowledgeVersions.orderBy("recordedAt","asc").limit(1000).get();
      const stored=snapshot.docs.flatMap(doc=>{
        const value=doc.data() as KnowledgeVersionRecord;
        return value.versionId===doc.id && verifyKnowledgeVersion(value)?[value]:[];
      });
      if(stored.length!==snapshot.size)throw new Error("Stored knowledge history failed integrity checks");
      for(const version of stored)await archiveKnowledgeVersion(version,knowledgeArchiveBucket);
      const archived=await readKnowledgeVersions(knowledgeArchiveBucket);
      if(archived.length<stored.length)throw new Error("Knowledge archive is missing a stored version");
      return archived.length;
    },
    async importKnowledge(snapshot) {
      const verified=verifySnapshot(snapshot);
      const batch=db.batch();
      const newVersions:KnowledgeVersionRecord[]=[];
      for(const entry of verified.entries) {
        const ref=db.collection("commandKnowledge").doc(entry.id);
        const existing=await ref.get();
        if(existing.exists) {
          const saved=knowledgePointer(existing.data()).entry;
          if(JSON.stringify(saved)!==JSON.stringify(entry)) throw new Error("Knowledge conflicts with existing Firestore entry");
        } else {
          const version=legacyKnowledgeVersion(entry);
          batch.create(knowledgeVersions.doc(version.versionId),version);
          batch.create(ref,{entry,versionId:version.versionId});
          newVersions.push(version);
        }
      }
      if(verified.entries.length) await batch.commit();
      for(const version of newVersions)await archiveKnowledgeVersion(version,knowledgeArchiveBucket);
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
        tr.create(reservations.doc(id),{ day,amount,status:"reserved",...(scope?{scope}:{}) });
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
        const settlement=firestoreReservationSettlement(saved,amount,tokens,Date.now());
        if(!saved || !settlement)return;
        const ref = spending.doc(String(saved.day));
        const budget = (await tr.get(ref)).data() as Budget;
        const executionRef=saved.scope?executionSpending.doc(String(saved.scope)):undefined;
        const execution=executionRef?(await tr.get(executionRef)).data() as Budget|undefined:undefined;
        if(executionRef&&!execution)throw new Error("Missing execution budget");
        tr.set(ref,{ reserved:budget.reserved-Number(saved.amount),settled:budget.settled+amount,
          tokens:budget.tokens+tokens,requests:budget.requests??0 });
        if(executionRef && execution)tr.set(executionRef,{...execution,reserved:execution.reserved-Number(saved.amount),
          settled:execution.settled+amount,tokens:execution.tokens+tokens});
        tr.update(reservation,settlement);
      });
    },
  };
}
