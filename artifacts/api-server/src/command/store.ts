import { Firestore } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommandRun } from "@workspace/api-zod";

const projectId = "gen-lang-client-0266144152";
const leaseMs = 4 * 60_000;
type Lease = { id: string; token: string };
type Slot = { token: string; until: number; attempts: number; status: string; run?: CommandRun };
type Suggestion = { programme: string; text: string };
type Budget = { reserved: number; settled: number; tokens: number };

export interface CommandStore {
  readonly production: boolean;
  list(): Promise<CommandRun[]>;
  claim(id: string): Promise<Lease | null>;
  complete(lease: Lease, run: CommandRun): Promise<void>;
  enqueue(input: Suggestion): Promise<string>;
  review(): Promise<number>;
  reserve(id: string, amount: number, cap: number): Promise<boolean>;
  settle(id: string, actual: number, tokens: number): Promise<void>;
}

export function openStore(env = process.env): CommandStore {
  if (env.COMMAND_STORE === "firestore") {
    if (env.GOOGLE_CLOUD_PROJECT !== projectId || env.FIRESTORE_DATABASE !== "zioncore-command" ||
        env.FIRESTORE_EMULATOR_HOST) throw new Error("Command requires the dedicated production Firestore database");
    return firestoreStore();
  }
  if (env.NODE_ENV === "production" || env.COMMAND_STORE && env.COMMAND_STORE !== "sqlite") {
    throw new Error("Production must explicitly select Firestore");
  }
  return sqliteStore(resolve(env.COMMAND_SQLITE_PATH ?? resolve(import.meta.dirname, "../../../.local/command/preview.sqlite")));
}

function sqliteStore(path: string): CommandStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, programme TEXT, text TEXT, status TEXT, submitted INTEGER);
    CREATE TABLE IF NOT EXISTS spend(day TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, day TEXT NOT NULL, amount INTEGER NOT NULL);`);
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
        .all().map(row => (JSON.parse(String(row.value)) as Slot).run!);
    },
    async claim(id) {
      return tx(() => {
        const next = nextSlot(get(id));
        if (!next) return null;
        set(id, next);
        return { id, token: next.token };
      });
    },
    async complete(lease, run) {
      tx(() => { const old = get(lease.id); checkLease(old, lease); set(lease.id, { ...old, status: "complete", run }); });
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
      return Number(db.prepare("UPDATE inbox SET status='triaged' WHERE id IN (SELECT id FROM inbox WHERE status='queued' ORDER BY submitted LIMIT 25)").run().changes);
    },
    async reserve(id, amount, cap) {
      return tx(() => {
        const day = month();
        const budget = getSpend(day);
        if (budget.reserved + budget.settled + amount > cap) return false;
        db.prepare("INSERT INTO reservations VALUES(?,?,?)").run(id,day,amount);
        setSpend(day,{ ...budget,reserved: budget.reserved+amount });
        return true;
      });
    },
    async settle(id, amount, tokens) {
      tx(() => {
        const row = db.prepare("SELECT day,amount FROM reservations WHERE id=?").get(id);
        if (!row) return;
        const day = String(row.day);
        const budget = getSpend(day);
        setSpend(day,{ reserved: budget.reserved-Number(row.amount),settled: budget.settled+amount,tokens:budget.tokens+tokens });
        db.prepare("DELETE FROM reservations WHERE id=?").run(id);
      });
    },
  };
}

function nextSlot(previous: Slot | undefined): Slot | null {
  if (previous && (previous.status === "complete" || previous.until > Date.now() || previous.attempts >= 3)) return null;
  return { token: randomUUID(), until: Date.now()+leaseMs, attempts:(previous?.attempts ?? 0)+1,status:"running" };
}

function checkLease(slot: Slot | undefined, lease: Lease): asserts slot is Slot {
  if (!slot || slot.token !== lease.token || slot.until < Date.now() || slot.status !== "running") throw new Error("Lease lost");
}

const month = () => new Date().toISOString().slice(0,7);

function firestoreStore(): CommandStore {
  const db = new Firestore({ projectId, databaseId:"zioncore-command" });
  const inboxDb = new Firestore({ projectId, databaseId:"zioncore-command-inbox" });
  const slots = db.collection("commandSlots");
  const runs = db.collection("commandPublicRuns");
  const inbox = inboxDb.collection("commandInbox");
  const spending = db.collection("commandSpending");
  const reservations = db.collection("commandReservations");
  const globalLimit = inboxDb.doc("commandControl/intake");
  return {
    production:true,
    async list() { return (await runs.orderBy("finishedAt","desc").limit(24).get()).docs.map(doc => doc.data() as CommandRun); },
    async claim(id) {
      return db.runTransaction(async tr => {
        const ref = slots.doc(id);
        const next = nextSlot((await tr.get(ref)).data() as Slot | undefined);
        if (!next) return null;
        tr.set(ref,next);
        return { id, token:next.token };
      });
    },
    async complete(lease, run) {
      await db.runTransaction(async tr => {
        const ref = slots.doc(lease.id);
        const old = (await tr.get(ref)).data() as Slot | undefined;
        checkLease(old,lease);
        tr.update(ref,{ status:"complete" });
        tr.create(runs.doc(lease.id),run);
      });
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
      const batch = inboxDb.batch();
      snapshot.docs.forEach(doc => batch.update(doc.ref,{ status:"triaged" },{lastUpdateTime:doc.updateTime}));
      if (!snapshot.empty) await batch.commit();
      return snapshot.size;
    },
    async reserve(id, amount, cap) {
      const day = month(), ref = spending.doc(day);
      return db.runTransaction(async tr => {
        const budget = (await tr.get(ref)).data() as Budget | undefined ?? { reserved:0,settled:0,tokens:0 };
        if (budget.reserved+budget.settled+amount > cap) return false;
        tr.create(reservations.doc(id),{ day,amount });
        tr.set(ref,{ ...budget,reserved:budget.reserved+amount });
        return true;
      });
    },
    async settle(id, amount, tokens) {
      await db.runTransaction(async tr => {
        const reservation = reservations.doc(id);
        const saved = (await tr.get(reservation)).data();
        if (!saved) return;
        const ref = spending.doc(String(saved.day));
        const budget = (await tr.get(ref)).data() as Budget;
        tr.set(ref,{ reserved:budget.reserved-Number(saved.amount),settled:budget.settled+amount,tokens:budget.tokens+tokens });
        tr.delete(reservation);
      });
    },
  };
}
