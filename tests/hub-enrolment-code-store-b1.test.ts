/** Owned SQLite/private-home store; no directory, backend or live account. */
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubEnrolmentCodes, HUB_ENROLMENT_CODE_MIGRATION, normalEnrolmentCode } from "../src/hub/enrolment-code.js";
import * as privateJoin from "../src/hub/join/private.js";
const homes: string[] = [], databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const admin = { realm: "corp", objectId: "00000000-0000-4000-8000-000000000001" };
function rig() {
  const home = mkdtempSync(join(tmpdir(), "hub-code-b1-")), db = new Database(":memory:"); homes.push(home); databases.push(db);
  HUB_ENROLMENT_CODE_MIGRATION.up(db);
  const clock = { now: Date.UTC(2026, 10, 11, 12) }, events: unknown[] = [], audit = vi.fn((action: string, id: string) => { events.push({ action, id }); });
  const store = new HubEnrolmentCodes({ db, home, hubId: randomUUID(), now: () => clock.now, audit });
  const tx = <T>(work: () => T) => db.transaction(work).immediate();
  const create = (patch = {}) => tx(() => store.create(admin, { expires: "today", maxUses: 30, perPersonFleets: 1, scope: { kind: "directory" }, ...patch }));
  return { home, db, clock, store, tx, create, events, audit };
}
describe("B1 private reusable enrolment-code store", () => {
  it("Crockford normalization has no ambiguous aliases and rejects controls/oversized input", () => {
    expect(normalEnrolmentCode(" abcd-2345 ")).toBe("ABCD2345");
    for (const text of ["ABCI2345", "ABCL2345", "ABCO2345", "ABCU2345", "ABCD\n2345", "A".repeat(17), "短加入碼"]) expect(() => normalEnrolmentCode(text)).toThrow();
  });
  it("re-displays live codes after restart but persists only HMAC and sealed code, with durable private key", () => {
    const r = rig(), made = r.create(), raw = r.db.prepare("SELECT * FROM hub_enrolment_codes").get() as any;
    expect(made.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(JSON.stringify(raw)).not.toContain(normalEnrolmentCode(made.code));
    expect(raw.mac).not.toBe(createHash("sha256").update(normalEnrolmentCode(made.code)).digest("hex"));
    expect(statSync(join(r.home, "hub/secrets/enrolment-code.key")).mode & 0o777).toBe(0o600);
    const again = new HubEnrolmentCodes({ db: r.db, home: r.home, hubId: r.store.hubId, now: () => r.clock.now, audit: r.audit });
    expect(r.tx(() => again.list())[0]).toMatchObject({ id: made.id, code: made.code, state: "live", uses: 0 });
    expect(r.store.lookup(made.code.toLowerCase())).toMatchObject({ id: made.id, maxUses: 30, perPersonFleets: 1 });
    expect(JSON.stringify(r.events)).not.toContain(made.code);
  });
  it("a missing key with retained rows is unavailable, never silently re-keyed", () => {
    const r = rig(); r.create(); unlinkSync(join(r.home, "hub/secrets/enrolment-code.key"));
    const again = new HubEnrolmentCodes({ db: r.db, home: r.home, hubId: r.store.hubId, now: () => r.clock.now, audit: r.audit });
    expect(() => r.tx(() => again.list())).toThrow(); expect(() => r.tx(() => again.create(admin, { expires: "1h", maxUses: 1, perPersonFleets: 1, scope: { kind: "directory" } }))).toThrow();
    expect(existsSync(join(r.home, "hub/secrets/enrolment-code.key"))).toBe(false);
  });
  it("a valid replacement key refuses after restart and after all ended rows are pruned", () => {
    const r = rig(), made = r.create(), path = join(r.home, "hub/secrets/enrolment-code.key");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, JSON.stringify({ v: 1, material: "a".repeat(64) }));
    const restart = () => new HubEnrolmentCodes({ db: r.db, home: r.home, hubId: r.store.hubId, now: () => r.clock.now, audit: r.audit });
    expect(() => r.tx(() => restart().create(admin, {}))).toThrow("unavailable");
    writeFileSync(path, original); r.tx(() => r.store.revoke(made.id, admin)); r.clock.now += 7 * 86400000;
    expect(r.tx(() => r.store.list())).toEqual([]);
    unlinkSync(path); expect(() => r.tx(() => restart().create(admin, {}))).toThrow("unavailable");
    expect(r.db.prepare("SELECT count(*) n FROM hub_enrolment_codes").get()).toEqual({ n: 0 });
  });
  it("the created response is refused if its key changes during required audit", () => {
    const r = rig();
    r.audit.mockImplementationOnce(() => { writeFileSync(join(r.home, "hub/secrets/enrolment-code.key"), JSON.stringify({ v: 1, material: "b".repeat(64) })); });
    expect(() => r.create()).toThrow("unavailable");
    expect(r.db.prepare("SELECT count(*) n FROM hub_enrolment_codes").get()).toEqual({ n: 0 });
  });
  it("a failed key flush cannot be bypassed by a cached material on retry", () => {
    const r = rig(), made = r.create(), sync = vi.spyOn(privateJoin, "syncJoinPrivate").mockImplementation(() => { throw Error("flush refused"); });
    expect(() => r.store.lookup(made.code)).toThrow("unavailable");
    expect(() => r.store.lookup(made.code)).toThrow("unavailable"); expect(sync).toHaveBeenCalledTimes(2);
    sync.mockRestore(); expect(r.store.lookup(made.code).id).toBe(made.id);
  });
  it("a prepared immutable code definition cannot change across a wait, while use advances are allowed", () => {
    const r = rig(), made = r.create(), prepared = r.store.live(made.id);
    r.tx(() => r.store.consume(prepared, { requestId: randomUUID(), fleetId: randomUUID(), owner: admin }));
    expect(r.store.assertDefinition(prepared).uses).toBe(1);
    // Trusted fixture re-seals a different valid definition: the captured image, not just AEAD validity, must fence it.
    const changed = { ...r.store.get(made.id), perPersonFleets: 8 };
    const sealed = (r.store as any).seal(changed, normalEnrolmentCode(made.code));
    r.db.prepare("UPDATE hub_enrolment_codes SET per_person=8,sealed=? WHERE id=?").run(sealed, made.id);
    expect(r.store.live(made.id).perPersonFleets).toBe(8);
    expect(() => r.store.assertDefinition(prepared)).toThrow("revoked");
  });
  it("ended history is retained for seven days from actual revoke or exhaustion, not the original expiry", () => {
    const r = rig(), revoked = r.create({ expires: "7d" }), exhausted = r.create({ expires: "7d", maxUses: 1 });
    r.tx(() => r.store.revoke(revoked.id, admin));
    r.tx(() => r.store.consume(r.store.get(exhausted.id), { requestId: randomUUID(), fleetId: randomUUID(), owner: admin }));
    r.clock.now += 7 * 86400000 - 1; expect(r.tx(() => r.store.list())).toHaveLength(2);
    r.clock.now++; expect(r.tx(() => r.store.list())).toEqual([]);
    expect(r.db.prepare("SELECT count(*) n FROM hub_enrolment_code_uses").get()).toEqual({ n: 0 });
  });
  it("single-use receipts are exact/idempotent; stale CAS cannot consume another use", () => {
    const r = rig(), made = r.create({ maxUses: 2 }), first = r.store.get(made.id), owner = admin;
    const use = { requestId: randomUUID(), fleetId: randomUUID(), owner };
    r.tx(() => r.store.consume(first, use)); r.tx(() => r.store.consume(first, use));
    expect(r.store.get(made.id).uses).toBe(1);
    expect(() => r.tx(() => r.store.consume(first, { ...use, requestId: randomUUID() }))).toThrow();
    expect(() => r.tx(() => r.store.consume(r.store.get(made.id), { ...use, fleetId: randomUUID() }))).toThrow();
    expect(r.db.prepare("SELECT count(*) n FROM hub_enrolment_code_uses").get()).toEqual({ n: 1 });
    r.tx(() => r.store.consume(r.store.get(made.id), { requestId: randomUUID(), fleetId: randomUUID(), owner }));
    expect(r.tx(() => r.store.list())[0]).toMatchObject({ state: "exhausted", uses: 2, code: null });
    expect(() => r.store.lookup(made.code)).toThrow();
  });
  it("revocation and expiry remove sealed copy once; already consumed receipt remains exact", () => {
    const r = rig(), made = r.create({ expires: "1h" }), first = r.store.get(made.id), use = { requestId: randomUUID(), fleetId: randomUUID(), owner: admin };
    r.tx(() => r.store.consume(first, use));
    r.tx(() => r.store.revoke(made.id, admin)); r.tx(() => r.store.revoke(made.id, admin));
    expect(r.tx(() => r.store.list())[0]).toMatchObject({ state: "revoked", code: null, uses: 1 });
    expect(() => r.tx(() => r.store.consume(first, { ...use, requestId: randomUUID() }))).toThrow();
    expect(() => r.tx(() => r.store.consume(first, use))).not.toThrow();
    const next = r.create({ expires: "1h" }); r.clock.now += 3600000;
    expect(r.tx(() => r.store.list()).find(c => c.id === next.id)).toMatchObject({ state: "expired", code: null });
    r.tx(() => r.store.list());
    expect(r.events.filter((e: any) => e.action === "enrolment-code.ended")).toHaveLength(1);
    expect(r.events.filter((e: any) => e.action === "enrolment-code.revoked")).toHaveLength(1);
  });
  it("sealed data binds the whole immutable row and cannot be exchanged between codes", () => {
    const r = rig(), a = r.create(), b = r.create();
    r.db.prepare("UPDATE hub_enrolment_codes SET sealed=(SELECT sealed FROM hub_enrolment_codes WHERE id=?) WHERE id=?").run(a.id, b.id);
    expect(() => r.tx(() => r.store.list())).toThrow(); expect(() => r.store.lookup(b.code)).toThrow();
  });
  it("authenticated sealed metadata cannot be widened in the database", () => {
    const r = rig(), made = r.create(); r.db.prepare("UPDATE hub_enrolment_codes SET per_person=8 WHERE id=?").run(made.id);
    expect(() => r.store.lookup(made.code)).toThrow();
  });
  it("required audit failure rolls the code and use transaction back", () => {
    const r = rig(); r.audit.mockImplementationOnce(() => { throw Error("audit refused"); });
    expect(() => r.create()).toThrow("audit refused"); expect(r.db.prepare("SELECT count(*) n FROM hub_enrolment_codes").get()).toEqual({ n: 0 });
    const made = r.create(); r.audit.mockImplementationOnce(() => { throw Error("audit refused"); });
    expect(() => r.tx(() => r.store.consume(r.store.get(made.id), { requestId: randomUUID(), fleetId: randomUUID(), owner: admin }))).toThrow();
    expect(r.store.get(made.id).uses).toBe(0); expect(r.db.prepare("SELECT count(*) n FROM hub_enrolment_code_uses").get()).toEqual({ n: 0 });
  });
  it("limits live codes to eight and creation to ten per hour, with bounded expiry and per-person eight", () => {
    const r = rig(); const live = Array.from({ length: 8 }, () => r.create()); expect(() => r.create()).toThrow("backpressure");
    r.tx(() => r.store.revoke(live[0]!.id, admin)); const a = r.create(); r.tx(() => r.store.revoke(a.id, admin)); r.create();
    r.tx(() => r.store.revoke(live[1]!.id, admin)); expect(() => r.create()).toThrow("backpressure");
    for (const patch of [{ maxUses: 201 }, { perPersonFleets: 9 }, { expires: "30d" }]) expect(() => r.create(patch)).toThrow();
  });
});
