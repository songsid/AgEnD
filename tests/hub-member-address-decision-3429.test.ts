/** Real SQLite/transport/floor logic and private synthetic Hub identity; no live fleet or directory. */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { HUB_MEMBER_ADDRESS_MIGRATION, HUB_MEMBER_RELOCATION_MIGRATION, createHubMemberAddressDecision, type HubMemberAddressOperation } from "../src/hub/settings-member-address-decision.js";
import { HUB_COMPANY_JOIN_MIGRATION } from "../src/hub/join/store.js";
import { HubTransportStore, migrateHubTransportStore } from "../src/hub/store.js";
import { canonicalArguments, personKeyString, sha256 } from "../src/hub/identity.js";
const owned: Array<() => void> = [];
afterEach(() => { for (const stop of owned.splice(0)) stop(); });
async function rig() {
  const home = mkdtempSync(join(tmpdir(), "member-address-sql-")), identity = await provisionHubIdentity({ home, memberOrigin: "https://127.0.0.1:18443" });
  const db = new Database(":memory:"); owned.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  db.exec("CREATE TABLE audit(id TEXT,action TEXT)"); migrateHubTransportStore(db); HUB_COMPANY_JOIN_MIGRATION.up(db); HUB_MEMBER_ADDRESS_MIGRATION.up(db); HUB_MEMBER_RELOCATION_MIGRATION.up(db);
  let floor = 0;
  const audit = vi.fn((event: { id: string; action: string }, own: Database.Database) => { expect(own).toBe(db); own.prepare("INSERT INTO audit VALUES(?,?)").run(event.id, event.action); });
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } }, appendAudit: audit }); store.initialize();
  const alice = { realm: "corp", objectId: randomUUID() }, bob = { realm: "corp", objectId: randomUUID() }, admin = { realm: "corp", objectId: randomUUID() };
  const a = randomUUID(), b = randomUUID(), old = randomUUID();
  store.mutate({ at: 1000, requestId: "seed", actor: { kind: "local-host" }, action: "fixture.seed", result: "completed" }, s => {
    s.fleets.push({ id: a, owner: alice, generation: 3, credentialHash: "a".repeat(64), status: "active", label: "Alice Fleet" },
      { id: b, owner: bob, generation: 5, credentialHash: "b".repeat(64), status: "active", label: "Bob Fleet" },
      { id: old, owner: bob, generation: 7, credentialHash: null, status: "revoked", label: "Already revoked" });
    for (const state of ["offered", "pending", "claimed"] as const) s.pairings.push({ id: randomUUID(), owner: alice, codeHash: state === "claimed" ? null : "c".repeat(64),
      expiresAt: 601000, fleetId: null, claimHash: state === "pending" ? "d".repeat(64) : null, fingerprint: null, ownerConfirmed: false, adminApproved: false, state });
  });
  const decision = createHubMemberAddressDecision({ db, home, hubId: identity.hubId, transport: store, now: () => 2000 });
  const operation = (): HubMemberAddressOperation => {
    const expected = decision.inspect();
    return { v: 1, kind: "member-address", id: randomUUID(), revision: expected.revision + 1, expected,
      before: { configSha: "1".repeat(64), manifestSha: "2".repeat(64), identitySha: expected.identitySha },
      after: { configSha: "3".repeat(64), manifestSha: "4".repeat(64), identitySha: "5".repeat(64), certificateSha: "6".repeat(64), memberSha: "7".repeat(64) },
      receiptSha: "8".repeat(64), actor: { kind: "host-owner", sessionId: "host-session", requestId: "move" }, at: 2000,
      webOrigin: "https://hub.example.test", affected: decision.affected(), administrator: admin };
  };
  return { db, home, identity, store, decision, operation, audit, alice, bob, admin, a, b, old, floor: () => floor };
}
describe("#3429 same-transaction transport address decision", () => {
  it("revokes exactly retained active credentials and pending codes, with one version/audit and durable owner/admin/host notices", async () => {
    const r = await rig(), before = r.store.read(), op = r.operation(); r.audit.mockClear(); r.decision.commit(op, () => true);
    const after = r.store.read();
    expect(after.revision).toBe(before.revision + 1); expect(after.revocationVersion).toBe(before.revocationVersion + 1);
    expect(after.fleets).toEqual(before.fleets.map(f => f.credentialHash === null ? f : { ...f, credentialHash: null, status: "revoked", generation: f.generation + 1 }));
    expect(after.pairings).toEqual(before.pairings.map(p => p.state === "claimed" ? p : { ...p, state: "revoked", codeHash: null, claimHash: null }));
    expect(r.decision.head()).toEqual({ operationId: op.id, revision: 1 }); expect(r.decision.lookup(op.id)).toEqual(op); expect(r.audit).toHaveBeenCalledOnce();
    const alice = r.decision.notices({ kind: "person", person: r.alice }, () => true), bob = r.decision.notices({ kind: "person", person: r.bob }, () => true);
    expect(alice.rows[0]).toMatchObject({ action: "reconnect", webOrigin: op.webOrigin, fleets: [{ id: r.a, label: "Alice Fleet" }] });
    expect(bob.rows[0]!.fleets).toEqual([{ id: r.b, label: "Bob Fleet" }]);
    expect(r.decision.notices({ kind: "person", person: r.admin }, () => true).rows[0]!.fleets).toHaveLength(2);
    expect(r.decision.notices({ kind: "host" }, () => true).rows[0]!.fleets).toHaveLength(2);
    expect(r.decision.notices({ kind: "person", person: { ...r.bob, objectId: randomUUID() } }, () => true).rows).toEqual([]);
  });
  it("revoked ownership or a changed transport snapshot refuses before floor/audit/notices", async () => {
    for (const mode of ["owner", "stale", "affected"] as const) {
      const r = await rig(), op = r.operation();
      if (mode === "stale") r.store.mutate({ at: 2000, requestId: "other", actor: { kind: "local-host" }, action: "fixture.other", result: "completed" }, () => {});
      if (mode === "affected") op.affected = [];
      const before = r.store.read(), floor = r.floor(); r.audit.mockClear();
      expect(() => r.decision.commit(op, () => mode !== "owner")).toThrow();
      expect(r.store.read()).toEqual(before); expect(r.floor()).toBe(floor); expect(r.audit).not.toHaveBeenCalled(); expect(r.decision.head().revision).toBe(0);
      expect(r.db.prepare("SELECT count(*) n FROM hub_member_address_notices").get()).toEqual({ n: 0 });
    }
  });
  it("a required audit failure rolls all SQL back and deliberately leaves the raised floor uncertain", async () => {
    const r = await rig(), op = r.operation(); r.audit.mockImplementation(() => { throw Error("disk refused"); });
    expect(() => r.decision.commit(op, () => true)).toThrow("disk refused");
    expect(r.db.prepare("SELECT revision FROM hub_member_address_head").get()).toEqual({ revision: 0 });
    expect(r.db.prepare("SELECT count(*) n FROM hub_member_address_notices").get()).toEqual({ n: 0 });
    expect(() => r.decision.lookup(op.id)).toThrow("uncertain"); // Recovery must not discard an unconfirmed stage.
  });
  it.each(["proof", "credential", "recipient"])("post-audit %s mutation cannot publish a decided image", async mode => {
    const r = await rig(), op = r.operation(); let current = true;
    r.audit.mockImplementation(() => {
      if (mode === "proof") current = false;
      if (mode === "credential") { const row = r.db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }; const s = JSON.parse(row.state); s.fleets[0].owner = r.admin; r.db.prepare("UPDATE hub_transport_state SET state=?").run(JSON.stringify(s)); }
      if (mode === "recipient") r.db.prepare("UPDATE hub_member_address_targets SET state='read'").run();
    });
    // mutate overwrites its own state after audit, so its final exact state still wins in the credential control.
    if (mode === "credential") { expect(() => r.decision.commit(op, () => current)).not.toThrow(); expect(r.store.read().fleets[0]!.owner).toEqual(r.alice); }
    else { expect(() => r.decision.commit(op, () => current)).toThrow(); expect(r.db.prepare("SELECT revision FROM hub_member_address_head").get()).toEqual({ revision: 0 }); }
  });
  it("exact recipient ACK is independent of the 100-row history page, with bounded older access", async () => {
    const r = await rig(), first = r.operation(); r.decision.commit(first, () => true);
    for (let revision = 2; revision <= 102; revision++) {
      const op = { ...first, id: randomUUID(), revision, expected: { ...first.expected, revision: revision - 1 } };
      r.db.prepare("INSERT INTO hub_member_address_operations VALUES(?,?)").run(op.id, canonicalArguments(op));
      r.db.prepare("INSERT INTO hub_member_address_notices VALUES(?,?,?)").run(op.id, revision, canonicalArguments(op));
      r.db.prepare("INSERT INTO hub_member_address_targets VALUES(?,'person',?,'unread')").run(op.id, personKeyString(r.alice));
    }
    const recipient = { kind: "person" as const, person: r.alice }, latest = r.decision.notices(recipient, () => true);
    expect(latest.rows).toHaveLength(100); expect(latest.rows.some(n => n.id === first.id)).toBe(false); expect(latest.before).not.toBeNull();
    expect(r.decision.notices(recipient, () => true, latest.before!).rows).toHaveLength(2);
    r.decision.acknowledge(first.id, recipient, () => true);
    expect(r.decision.notices(recipient, () => true, latest.before!).rows.at(-1)).toMatchObject({ id: first.id, state: "read" });
    expect(() => r.decision.acknowledge(first.id, { kind: "person", person: { ...r.alice, objectId: randomUUID() } }, () => true)).toThrow("denied");
    expect(() => r.decision.acknowledge(first.id, recipient, () => false)).toThrow("denied");
  });
  it("a lost/partial member component is never recreated", async () => {
    const r = await rig(); r.db.exec("DROP TABLE hub_member_address_targets"); expect(() => HUB_MEMBER_ADDRESS_MIGRATION.up(r.db)).toThrow("recovery");
  });
});

describe("#3429 B — members that followed keep their credential (the kept set)", () => {
  const TO = "https://127.0.0.1:19443", FROM = "https://127.0.0.1:18443";
  async function relocated(opts: { keptGeneration?: number; keptCredential?: string; statementDigest?: string } = {}) {
    const r = await rig();
    const sequence = r.decision.reserveRelocation({ attempt: randomUUID(), from: FROM, to: TO, spki: r.decision.inspect().spkiSha256, at: 2000 });
    const digest = "e".repeat(64);
    r.decision.recordRelocationStatements(sequence, [{ fleetId: r.a, digest: opts.statementDigest ?? digest, body: "{}" }]);
    const op = { ...r.operation(), relocation: { sequence, to: TO,
      kept: [{ id: r.a, generation: opts.keptGeneration ?? 3, credentialSha: sha256(opts.keptCredential ?? "a".repeat(64)), digest }] } };
    return { ...r, op, sequence };
  }
  it("the acked Fleet stays active with its credential; the others are revoked; notices name only the revoked", async () => {
    const r = await relocated(), before = r.store.read();
    r.decision.commit(r.op, () => true);
    const after = r.store.read();
    expect(after.fleets.find(f => f.id === r.a)).toEqual(before.fleets.find(f => f.id === r.a));          // untouched
    expect(after.fleets.find(f => f.id === r.b)).toMatchObject({ status: "revoked", credentialHash: null, generation: 6 });
    expect(after.revocationVersion).toBe(before.revocationVersion + 1);
    expect(r.decision.notices({ kind: "person", person: r.alice }, () => true).rows).toEqual([]);          // kept: no notice
    expect(r.decision.notices({ kind: "person", person: r.bob }, () => true).rows[0]!.fleets).toEqual([{ id: r.b, label: "Bob Fleet" }]);
    expect(r.decision.notices({ kind: "person", person: r.admin }, () => true).rows[0]!.fleets).toEqual([{ id: r.b, label: "Bob Fleet" }]);
    expect(r.decision.lookup(r.op.id)).toEqual(r.op);                                                   // the kept set is immutable
  });
  it.each([["another generation", { keptGeneration: 4 }], ["another credential", { keptCredential: "z".repeat(64) }]] as const)(
    "a kept Fleet with %s since it was signed for: stale, nothing written", async (_n, opts) => {
    const r = await relocated(opts), before = r.store.read();
    expect(() => r.decision.commit(r.op, () => true)).toThrow(expect.objectContaining({ code: "stale" }));
    expect(r.store.read()).toEqual(before);
    expect(r.decision.head()).toEqual({ operationId: null, revision: 0 });
  });
  it("a kept Fleet that is not one of this reservation's signed rows: refused, nothing written", async () => {
    const r = await relocated({ statementDigest: "f".repeat(64) }), before = r.store.read();
    expect(() => r.decision.commit(r.op, () => true)).toThrow();
    expect(r.store.read()).toEqual(before);
  });
  it("a reservation per attempt: an abort burns its sequence; the head does not move until the decision", async () => {
    const r = await rig(), spki = r.decision.inspect().spkiSha256;
    expect(r.decision.reserveRelocation({ attempt: "one", from: FROM, to: TO, spki, at: 1 })).toBe(1);
    expect(r.decision.head()).toEqual({ operationId: null, revision: 0 });
    expect(r.decision.reserveRelocation({ attempt: "two", from: FROM, to: "https://127.0.0.1:19555", spki, at: 2 })).toBe(2);   // after an abort
    expect(() => r.decision.reserveRelocation({ attempt: "two", from: FROM, to: TO, spki, at: 3 })).toThrow();                 // one per attempt
    expect(() => r.decision.reserveRelocation({ attempt: "three", from: FROM, to: FROM, spki, at: 3 })).toThrow();
  });
});
