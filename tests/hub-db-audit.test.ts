/**
 * S-51 (S5b): the Hub's private databases (src/hub/db.ts) and the audit sink (src/hub/audit). Private modes, the
 * migration registry (no downgrade), the created-together set, the instance binding, the unit of work, the hash-chained
 * audit with S1's store bridge, encrypted content, scoped and audited reads, and retention with a checkpoint.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  applyHubMigrations, bindHubInstance, createHubUnitOfWork, HUB_INSTANCE_MIGRATION, HubStateError, hubTxDatabase, inspectStateSet, openHubDatabase,
  type HubMigration,
} from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION, HubAuditAccessError } from "../src/hub/audit/index.js";
import { HUB_TRANSPORT_MIGRATION, HubTransportStore } from "../src/hub/store.js";
import type { HubAuditRecord, HubRequestContext, PersonKey } from "../src/hub/types.js";

const homes: string[] = [];
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "agend-hubdb-"));
  chmodSync(h, 0o700);
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const mode = (p: string) => statSync(p).mode & 0o777;
const PERSON = (n: number): PersonKey => ({ realm: "corp", objectId: `0000000${n}-0000-4000-8000-000000000000` });

function record(over: Partial<HubAuditRecord> = {}): HubAuditRecord {
  return { id: randomUUID(), sequence: 0, at: Date.now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "test.event", result: "completed", policyVersion: 0, ...over };
}

function ctx(person: PersonKey | null): HubRequestContext {
  return {
    requestId: randomUUID(),
    current: async () => (person ? { kind: "directory", person, sessionId: "s" } : { kind: "local-host", sessionId: "s", directoryBinding: null }),
    requirePerson: async () => {
      if (!person) throw new Error("no person");
      return person;
    },
    requireAdmin: async () => ({ kind: "local-host", sessionId: "s", directoryBinding: null }),
  };
}

function openAudited(h = home()) {
  const db = openHubDatabase(h, "hub/hub.sqlite", { create: true });
  applyHubMigrations(db, [HUB_INSTANCE_MIGRATION, HUB_AUDIT_MIGRATION]);
  const key = randomBytes(32);
  const audit = createHubAudit({ db, contentKey: key });
  const uow = createHubUnitOfWork(db);
  return { h, db, audit, uow, key };
}

describe("private Hub database", () => {
  it("creates the file, its directory and WAL/SHM privately, and never overwrites an existing database", () => {
    const h = home();
    const db = openHubDatabase(h, "hub/hub.sqlite", { create: true });
    db.exec("CREATE TABLE t(x)");
    db.prepare("INSERT INTO t VALUES(1)").run();
    expect(mode(join(h, "hub"))).toBe(0o700);
    for (const f of ["hub.sqlite", "hub.sqlite-wal", "hub.sqlite-shm"]) {
      if (existsSync(join(h, "hub", f))) expect(mode(join(h, "hub", f)), f).toBe(0o600);
    }
    expect(existsSync(join(h, "hub/hub.sqlite-wal"))).toBe(true);
    db.close();
    expect(() => openHubDatabase(h, "hub/hub.sqlite", { create: true })).toThrow(HubStateError);
    expect(() => openHubDatabase(home(), "hub/hub.sqlite", { create: false })).toThrow(/missing/);
  });

  it("refuses a symlinked or group-readable directory", () => {
    const h = home();
    const elsewhere = home();
    symlinkSync(elsewhere, join(h, "hub"));
    expect(() => openHubDatabase(h, "hub/hub.sqlite", { create: true })).toThrow(HubStateError);
    const h2 = home();
    mkdirSync(join(h2, "hub"), { mode: 0o750 });
    chmodSync(join(h2, "hub"), 0o750);
    expect(() => openHubDatabase(h2, "hub/hub.sqlite", { create: true })).toThrow(HubStateError);
  });

  it("migrates every component once, refuses a newer or unknown component, and validates the list", () => {
    const h = home();
    const db = openHubDatabase(h, "hub/hub.sqlite", { create: true });
    let ran = 0;
    const m1: HubMigration = { component: "test-a", version: 1, up: (d) => { ran += 1; d.exec("CREATE TABLE IF NOT EXISTS a(x)"); } };
    applyHubMigrations(db, [m1]);
    applyHubMigrations(db, [m1]);
    expect(ran).toBe(1);
    const m2: HubMigration = { ...m1, version: 2, up: (d) => { ran += 1; d.exec("CREATE TABLE IF NOT EXISTS a2(x)"); } };
    applyHubMigrations(db, [m2]);
    expect(ran).toBe(2);
    const err = (() => { try { applyHubMigrations(db, [m1]); } catch (e) { return e as HubStateError; } })();
    expect(err?.code).toBe("hub-state-newer");
    expect(() => applyHubMigrations(db, [])).toThrow(/does not know/);
    expect(() => applyHubMigrations(db, [m2, m2])).toThrow(/duplicate/);
    expect(() => applyHubMigrations(db, [{ ...m2, component: "Bad Name" }])).toThrow(/invalid/);
    // A migration that fails rolls the whole step back.
    const boom: HubMigration = { component: "test-b", version: 1, up: (d) => { d.exec("CREATE TABLE b(x)"); throw new Error("boom"); } };
    expect(() => applyHubMigrations(db, [m2, boom])).toThrow(/boom/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeUndefined();
  });

  it("the created-together set is new, complete, or refused when partial — prerequisites never count", () => {
    const h = home();
    const set = { database: "hub/hub.sqlite", floors: ["hub/floors/transport"], keys: ["hub/keys/content.key"] };
    mkdirSync(join(h, "hub/keys"), { recursive: true, mode: 0o700 });
    writeFileSync(join(h, "hub/keys/identity.json"), "{}"); // S1's identity: a prerequisite, not part of the set
    writeFileSync(join(h, "hub/init-manifest.json"), "{}");
    expect(inspectStateSet(h, set)).toBe("new");
    mkdirSync(join(h, "hub/floors"), { mode: 0o700 });
    writeFileSync(join(h, "hub/floors/transport"), "0");
    let err: HubStateError | undefined;
    try { inspectStateSet(h, set); } catch (e) { err = e as HubStateError; }
    expect(err?.code).toBe("hub-state-mismatch");
    expect(err?.message).toMatch(/hub\/hub.sqlite.*content.key/);
    writeFileSync(join(h, "hub/hub.sqlite"), "");
    writeFileSync(join(h, "hub/keys/content.key"), "x");
    expect(inspectStateSet(h, set)).toBe("complete");
  });

  it("binds the database to one Hub id", () => {
    const h = home();
    const db = openHubDatabase(h, "hub/hub.sqlite", { create: true });
    applyHubMigrations(db, [HUB_INSTANCE_MIGRATION]);
    expect(() => bindHubInstance(db, "hub-a", "complete", 1)).toThrow(/does not say/);
    bindHubInstance(db, "hub-a", "new", 1);
    bindHubInstance(db, "hub-a", "complete", 2);
    expect(() => bindHubInstance(db, "hub-b", "complete", 2)).toThrow(/another Hub/);
    expect(() => bindHubInstance(db, "hub-a", "new", 2)).toThrow(/already has an owner/);
  });

  it("unit of work: immediate transactions, savepoints, no async, and hubTxDatabase only while the transaction lives", () => {
    const h = home();
    const db = openHubDatabase(h, "hub/hub.sqlite", { create: true });
    db.exec("CREATE TABLE t(x)");
    const uow = createHubUnitOfWork(db);
    let leaked: Parameters<Parameters<typeof uow.atomic>[0]>[0] | undefined;
    uow.atomic((tx) => {
      leaked = tx;
      hubTxDatabase(tx).prepare("INSERT INTO t VALUES(1)").run();
      expect(() => uow.atomic((inner) => { hubTxDatabase(inner).prepare("INSERT INTO t VALUES(2)").run(); throw new Error("inner"); })).toThrow("inner");
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(1);
    expect(() => hubTxDatabase(leaked!)).toThrow(/not active/);
    // A leaked token stays dead even while another transaction is open on the same database.
    uow.atomic(() => {
      expect(() => hubTxDatabase(leaked!)).toThrow(/not active/);
    });
    expect(() => uow.atomic(() => Promise.resolve(1) as unknown as number)).toThrow(/synchronous/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(1);
  });
});

describe("audit sink", () => {
  it("appends a hash chain inside the caller's transaction; a failed append aborts everything in it", () => {
    const { db, audit, uow } = openAudited();
    db.exec("CREATE TABLE work(x)");
    uow.atomic((tx) => {
      hubTxDatabase(tx).prepare("INSERT INTO work VALUES('a')").run();
      audit.append(tx, record({ action: "work.done" }));
    });
    expect(() =>
      uow.atomic((tx) => {
        hubTxDatabase(tx).prepare("INSERT INTO work VALUES('b')").run();
        audit.append(tx, record({ action: "NOT VALID" }));
      }),
    ).toThrow(/invalid action/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM work").get() as { n: number }).n).toBe(1);
    expect(() => audit.appendInTransaction(record(), db)).toThrow(/only inside a transaction/);
    expect(audit.verifyChain()).toEqual({ ok: true, checked: 1 });
  });

  it("is S1's store audit writer: same transaction, S5 sequence, S1 revision kept; a failing audit refuses the mutation", () => {
    const { db, audit, h } = openAudited();
    applyHubMigrations(db, [HUB_INSTANCE_MIGRATION, HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION]);
    let floor = 0;
    const store = new HubTransportStore(db, { floor: { read: () => floor, raise: (n) => { floor = n; } }, appendAudit: (r, d) => audit.appendInTransaction(r, d) });
    store.initialize();
    store.mutate({ at: Date.now(), requestId: "r1", actor: { kind: "local-host" }, action: "pairing.created", result: "allowed" }, (s) => { s.nextLinkEpoch += 1; });
    const row = db.prepare("SELECT sequence, component_sequence, action FROM hub_audit").get() as { sequence: number; component_sequence: number; action: string };
    expect(row).toEqual({ sequence: 1, component_sequence: 1, action: "pairing.created" });
    // A store on another database cannot write into this audit.
    const other = new Database(join(h, "other.sqlite"));
    expect(() => audit.appendInTransaction(record(), other)).toThrow(/another database/);
    other.close();
    // Audit failure (its table is gone) refuses the mutation, and S1 freezes the store.
    db.exec("DROP TABLE hub_audit");
    expect(() => store.mutate({ at: Date.now(), requestId: "r2", actor: { kind: "local-host" }, action: "pairing.created", result: "allowed" }, (s) => { s.nextLinkEpoch += 1; })).toThrow(/hub_audit/);
    // The change did not commit (still revision 1), and S1 froze the store: no later read trusts it.
    expect(JSON.parse((db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state).revision).toBe(1);
    expect(() => store.read()).toThrow();
  });

  it("stores question/answer text encrypted, under refs it generates, in the caller's transaction", () => {
    const { db, audit, uow, key } = openAudited();
    const secret = "the quarterly numbers " + randomUUID();
    const ref = uow.atomic((tx) => {
      const r = audit.content.put(tx, { question: secret });
      audit.append(tx, record({ action: "room.asked", contentRef: r }));
      return r;
    });
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    expect(audit.content.get(ref)).toEqual({ question: secret });
    const raw = db.prepare("SELECT ciphertext FROM hub_audit_content").get() as { ciphertext: Buffer };
    expect(raw.ciphertext.includes(Buffer.from(secret))).toBe(false);
    expect(readFileSync(join(openAudited().h, "hub/hub.sqlite")).length).toBeGreaterThan(0);
    // Another key cannot read it; a made-up ref finds nothing.
    const wrong = createHubAudit({ db, contentKey: Buffer.alloc(32, 7) });
    expect(() => wrong.content.get(ref)).toThrow();
    expect(audit.content.get("0".repeat(32))).toBeUndefined();
    expect(audit.content.get("../etc")).toBeUndefined();
    expect(key.length).toBe(32);
    // contentRef must name a stored row.
    expect(() => uow.atomic((tx) => audit.append(tx, record({ contentRef: "f".repeat(32) })))).toThrow(/contentRef/);
  });

  it("reads: the asked owner sees only their events, an auditor sees all, the local host none; every read is recorded first", async () => {
    const { audit, uow, db } = openAudited();
    const owner = PERSON(1), other = PERSON(2), auditor = PERSON(3);
    const ref = uow.atomic((tx) => {
      const r = audit.content.put(tx, { question: "q1", answer: "a1" });
      audit.append(tx, record({ action: "room.asked", ownerAtEvent: owner, contentRef: r, actor: { kind: "person", person: other } }));
      audit.append(tx, record({ action: "room.asked", ownerAtEvent: other }));
      audit.setAuditor(tx, auditor, true, { kind: "local-host" }, "r");
      return r;
    });
    const mine = await audit.read(ctx(owner), {});
    expect(mine.map((r) => r.action)).toEqual(["room.asked"]);
    expect(mine[0]!.contentRef).toBe(ref);
    const all = await audit.read(ctx(auditor), {});
    expect(all.filter((r) => r.action === "room.asked")).toHaveLength(2);
    await expect(audit.read(ctx(null), {})).rejects.toBeInstanceOf(HubAuditAccessError);
    const reads = db.prepare("SELECT COUNT(*) AS n FROM hub_audit WHERE action = 'audit.read'").get() as { n: number };
    expect(reads.n).toBe(2);
    // Content: the owner and an auditor; not someone else.
    const id = mine[0]!.id;
    expect(await audit.readContent(ctx(owner), id)).toMatchObject({ question: "q1", answer: "a1" });
    await expect(audit.readContent(ctx(PERSON(4)), id)).rejects.toBeInstanceOf(HubAuditAccessError);
    expect((await audit.readContent(ctx(auditor), id)).audience).toHaveLength(2);
    // A read that cannot be recorded fails.
    db.exec("CREATE TRIGGER no_more BEFORE INSERT ON hub_audit BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(audit.read(ctx(owner), {})).rejects.toThrow(/disk full/);
    expect(audit.verifyChain().ok).toBe(true);
  });

  it("detects a tampered row", () => {
    const { db, audit, uow } = openAudited();
    uow.atomic((tx) => {
      for (let i = 0; i < 3; i += 1) audit.append(tx, record({ action: `test.n${i}` }));
    });
    expect(audit.verifyChain()).toEqual({ ok: true, checked: 3 });
    db.prepare("UPDATE hub_audit SET result = 'denied' WHERE sequence = 2").run();
    expect(audit.verifyChain()).toEqual({ ok: false, sequence: 2 });
  });

  it("retention: old content and a contiguous prefix of old events go, the chain still verifies from its checkpoint", () => {
    let t = Date.UTC(2026, 0, 1);
    const h = home();
    const db = openHubDatabase(h, "hub/hub.sqlite", { create: true });
    applyHubMigrations(db, [HUB_INSTANCE_MIGRATION, HUB_AUDIT_MIGRATION]);
    const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => t });
    const uow = createHubUnitOfWork(db);
    const day = 86_400_000;
    const old = uow.atomic((tx) => {
      const r = audit.content.put(tx, { question: "old" });
      audit.append(tx, record({ at: t, action: "test.old", contentRef: r }));
      audit.append(tx, record({ at: t, action: "test.keep-me" }));
      return r;
    });
    t += 40 * day;
    uow.atomic((tx) => audit.append(tx, record({ at: t, action: "test.new" })));
    expect(() => audit.purge({ contentDays: 0, eventDays: 1 })).toThrow(/no default/);
    // The second old event is still needed (unresolved evidence): the prefix stops there.
    const result = audit.purge({ contentDays: 30, eventDays: 30 }, (r) => r.action === "test.keep-me");
    expect(result).toEqual({ content: 1, events: 1 });
    expect(audit.content.get(old)).toBeUndefined();
    expect((db.prepare("SELECT action FROM hub_audit ORDER BY sequence").all() as { action: string }[]).map((r) => r.action)).toEqual(["test.keep-me", "test.new", "audit.purge"]);
    expect(audit.verifyChain().ok).toBe(true);
  });
});

describe("review #3113 regressions", () => {
  it("P1: the auditor assignment is checked where the data leaves; a revocation racing the read is honoured", async () => {
    for (let depth = 0; depth < 6; depth += 1) {
      for (const kind of ["content", "metadata"] as const) {
        const { audit, uow, db } = openAudited();
        const owner = PERSON(1), auditor = PERSON(3);
        const id = uow.atomic((tx) => {
          const r = audit.content.put(tx, { question: "PRIVATE OWNER QUESTION" });
          const rec = record({ action: "room.asked", ownerAtEvent: owner, contentRef: r });
          audit.append(tx, rec);
          audit.setAuditor(tx, auditor, true, { kind: "local-host" }, "assign");
          return rec.id;
        });
        const c = ctx(auditor);
        c.requirePerson = () => {
          let left = depth;
          const revoke = () => (left-- > 0 ? queueMicrotask(revoke) : uow.atomic((tx) => audit.setAuditor(tx, auditor, false, { kind: "local-host" }, "remove")));
          queueMicrotask(revoke);
          return Promise.resolve(auditor);
        };
        let got: unknown;
        try {
          got = kind === "content" ? (await audit.readContent(c, id)).question : (await audit.read(c, {})).filter((r) => r.action === "room.asked").length;
        } catch {
          got = undefined;
        }
        await new Promise((r) => setTimeout(r, 0));
        const seq = (action: string) => (db.prepare("SELECT MAX(sequence) AS s FROM hub_audit WHERE action = ?").get(action) as { s: number | null }).s;
        const removed = seq("audit.auditor-removed")!;
        const readAt = seq(kind === "content" ? "audit.read-content" : "audit.read");
        const disclosed = kind === "content" ? got === "PRIVATE OWNER QUESTION" : got === 1;
        // Disclosure is allowed only by a read that happened (and was recorded) before the revocation.
        if (disclosed) expect(readAt !== null && readAt < removed, `${kind} depth ${depth}`).toBe(true);
        else if (readAt !== null) expect(readAt > removed || kind === "metadata", `${kind} depth ${depth}`).toBe(true);
      }
    }
    // Control: an unchanged assignment reads normally.
    const { audit, uow } = openAudited();
    const id = uow.atomic((tx) => {
      const r = audit.content.put(tx, { question: "q" });
      const rec = record({ ownerAtEvent: PERSON(1), contentRef: r });
      audit.append(tx, rec);
      audit.setAuditor(tx, PERSON(3), true, { kind: "local-host" }, "assign");
      return rec.id;
    });
    expect((await audit.readContent(ctx(PERSON(3)), id)).question).toBe("q");
  });

  it("P2: content is bound to its record — a transplanted ref or record id never decrypts for another record", async () => {
    const { audit, uow, db } = openAudited();
    const a = PERSON(1), b = PERSON(2);
    const [refA, idB] = uow.atomic((tx) => {
      const ra = audit.content.put(tx, { question: "A's secret" });
      audit.append(tx, record({ ownerAtEvent: a, contentRef: ra }));
      const rb = audit.content.put(tx, { question: "B's own" });
      const recB = record({ ownerAtEvent: b, contentRef: rb });
      audit.append(tx, recB);
      return [ra, recB.id];
    });
    expect((await audit.readContent(ctx(b), idB)).question).toBe("B's own");
    db.prepare("UPDATE hub_audit SET content_ref = ? WHERE id = ?").run(refA, idB); // DB-level substitution
    await expect(audit.readContent(ctx(b), idB)).rejects.toThrow(/another record/);
    db.prepare("UPDATE hub_audit_content SET record_id = NULL WHERE record_id = ?").run(idB); // and the content rows too
    db.prepare("UPDATE hub_audit_content SET record_id = ? WHERE ref = ?").run(idB, refA);
    await expect(audit.readContent(ctx(b), idB)).rejects.toThrow();
    // A ref can be attached to one record only.
    expect(() => uow.atomic((tx) => audit.append(tx, record({ contentRef: refA })))).toThrow(/another record|already/);
    // Unbound content (no record in its transaction) is never served.
    const loose = uow.atomic((tx) => audit.content.put(tx, { question: "loose" }));
    expect(audit.content.get(loose)).toBeUndefined();
  });

  it("P2: the head must match even when no rows are left — an erased table or suffix fails verification", () => {
    expect(openAudited().audit.verifyChain()).toEqual({ ok: true, checked: 0 }); // genesis
    const { audit, uow, db } = openAudited();
    uow.atomic((tx) => { for (let i = 0; i < 3; i += 1) audit.append(tx, record({ action: `test.n${i}` })); });
    db.exec("DELETE FROM hub_audit");
    expect(audit.verifyChain().ok).toBe(false);
    // After a checkpoint: an erased suffix fails, the intact checkpoint-only chain passes.
    let t = Date.UTC(2026, 0, 1);
    const h = home();
    const db2 = openHubDatabase(h, "hub/hub.sqlite", { create: true });
    applyHubMigrations(db2, [HUB_INSTANCE_MIGRATION, HUB_AUDIT_MIGRATION]);
    const audit2 = createHubAudit({ db: db2, contentKey: randomBytes(32), now: () => t });
    const uow2 = createHubUnitOfWork(db2);
    uow2.atomic((tx) => audit2.append(tx, record({ at: t, action: "test.old" })));
    t += 40 * 86_400_000;
    audit2.purge({ contentDays: 30, eventDays: 30 });
    expect(audit2.verifyChain().ok).toBe(true);
    db2.exec("DELETE FROM hub_audit");
    expect(audit2.verifyChain().ok).toBe(false);
  });

  it("P2: async migration or transaction callbacks are refused and rolled back, and their late rejections are observed", async () => {
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRejection);
    try {
      const h = home();
      const db = openHubDatabase(h, "hub/hub.sqlite", { create: true });
      const late: HubMigration = { component: "test-async", version: 1, up: (async (d: Database.Database) => { await null; d.exec("CREATE TABLE late(x)"); throw new Error("late"); }) as unknown as HubMigration["up"] };
      expect(() => applyHubMigrations(db, [late])).toThrow(/synchronous/);
      const published = db.prepare("SELECT name FROM sqlite_master WHERE name = 'hub_schema'").get()
        ? db.prepare("SELECT 1 FROM hub_schema WHERE component = 'test-async'").get() : undefined;
      expect(published).toBeUndefined(); // the version was never published
      const uow = createHubUnitOfWork(db);
      expect(() => uow.atomic((async (tx: Parameters<Parameters<typeof uow.atomic>[0]>[0]) => { await null; hubTxDatabase(tx); }) as never)).toThrow(/synchronous/);
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
