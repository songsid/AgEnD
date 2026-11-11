/** Shared sealed writer, real keys/SQLite and deterministic crash boundaries; no live listener or directory. */
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionHubIdentity, readHubMemberTls } from "../src/hub/tls.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { createHubSettingsWriter } from "../src/hub/settings-commit.js";
import { HubTransportStore, migrateHubTransportStore } from "../src/hub/store.js";
import { HUB_COMPANY_JOIN_MIGRATION } from "../src/hub/join/store.js";
import { HUB_MEMBER_ADDRESS_MIGRATION, createHubMemberAddressDecision } from "../src/hub/settings-member-address-decision.js";
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); vi.restoreAllMocks(); });
const actor = { kind: "host-owner" as const, sessionId: "host-session", requestId: "move" };
async function rig() {
  const home = mkdtempSync(join(tmpdir(), "member-address-writer-")), identity = await provisionHubIdentity({ home, memberOrigin: "https://member.example.test:18443" });
  const db = new Database(":memory:"); cleanup.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  let hub: Record<string, unknown> = { enabled: true, hubId: identity.hubId, webOrigin: "https://hub.example.test:18444", memberOrigin: "https://member.example.test:18443",
    webListen: { host: "127.0.0.1", port: 18444 }, memberListen: { host: "127.0.0.1", port: 18443 }, webTls: { certificateFile: "hub/browser/cert.pem", keyFile: "hub/browser/key.pem" },
    directory: { realm: "corp" }, administrator: { realm: "corp", objectId: randomUUID() }, retention: { eventDays: 90, contentDays: 30 }, coexistence: "dedicated" };
  const at = new Date().toISOString(), confirmationId = "a".repeat(32), planDigest = hubPlanDigest(hub);
  writeFileSync(join(home, "hub/init-manifest.json"), JSON.stringify({ v: 1, hubId: identity.hubId, planDigest, committedAt: at, confirmationId,
    signature: sealHubInitialization({ home, planDigest, committedAt: at, confirmationId }) }) + "\n", { mode: 0o600 });
  db.exec("CREATE TABLE audit(id TEXT)"); migrateHubTransportStore(db); HUB_COMPANY_JOIN_MIGRATION.up(db); HUB_MEMBER_ADDRESS_MIGRATION.up(db);
  let floor = 0;
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: v => { floor = v; } }, appendAudit: r => { db.prepare("INSERT INTO audit VALUES(?)").run(r.id); } }); store.initialize();
  const owner = { realm: "corp", objectId: randomUUID() };
  store.mutate({ at: 1000, requestId: "seed", actor: { kind: "local-host" }, action: "fixture.seed", result: "completed" }, s => {
    s.fleets.push({ id: randomUUID(), owner, generation: 2, credentialHash: "b".repeat(64), status: "active", label: "Owned Fleet" });
  });
  const decision = createHubMemberAddressDecision({ db, home, hubId: identity.hubId, transport: store });
  const writer = (step?: (s: string) => void) => createHubSettingsWriter({ home: home + "/", readHub: () => structuredClone(hub),
    saveHub: patches => { for (const p of patches) hub[p.path[1]!] = p.value; }, memberAddressDecision: () => decision, step });
  const candidate = { origin: "https://member.example.test:19443", listen: { host: "127.0.0.1", port: 19443 }, certificate: readHubMemberTls({ home }).certificatePem };
  const verify = () => verifyHubInitialization({ home, hubId: identity.hubId, memberOrigin: hub.memberOrigin as string, planDigest: hubPlanDigest(hub) });
  return { home, hub: () => hub, identity, db, store, decision, writer, candidate, verify };
}
describe("#3429 shared member address writer", () => {
  it("prepares affected fleets without changing state, then retains Hub/issuer/key while invalidating old credentials", async () => {
    const r = await rig(), before = structuredClone(r.hub()), keys = ["tls-key.pem", "issuer-key.pem"].map(n => readFileSync(join(r.home, "hub/keys", n))), w = r.writer();
    const p = w.memberAddress!.prepare(r.candidate, actor, () => true);
    expect(p.summary).toMatchObject({ field: "member-address", fleetsRejoin: true, fleets: [{ label: "Owned Fleet" }] });
    expect(r.hub()).toEqual(before); expect(r.store.read().fleets[0]!.status).toBe("active");
    w.memberAddress!.commit(p.ref, actor, () => true);
    expect(r.verify()).toBeTruthy(); expect(() => r.decision.assertMounted(r.hub())).not.toThrow(); expect(w.pending()).toBe(false);
    expect(r.hub()).toMatchObject({ memberOrigin: r.candidate.origin, memberListen: r.candidate.listen, webOrigin: before.webOrigin, webListen: before.webListen, webTls: before.webTls, hubId: before.hubId });
    expect(readHubMemberTls({ home: r.home }).identity).toEqual(r.identity);
    expect(["tls-key.pem", "issuer-key.pem"].map(n => readFileSync(join(r.home, "hub/keys", n)))).toEqual(keys);
    expect(r.store.read().fleets[0]).toMatchObject({ generation: 3, status: "revoked", credentialHash: null });
    expect(r.decision.notices({ kind: "host" }, () => true).rows).toHaveLength(1);
  });
  it("returning to the previous origin is a new decision and never restores old credentials", async () => {
    const r = await rig(), w = r.writer(), original = structuredClone(r.hub());
    const first = w.memberAddress!.prepare(r.candidate, actor, () => true); w.memberAddress!.commit(first.ref, actor, () => true);
    const second = w.memberAddress!.prepare({ ...r.candidate, origin: original.memberOrigin as string, listen: original.memberListen as { host: string; port: number } }, actor, () => true);
    w.memberAddress!.commit(second.ref, actor, () => true);
    expect(r.hub().memberOrigin).toBe(original.memberOrigin); expect(r.decision.head().revision).toBe(2);
    expect(r.store.read().fleets[0]).toMatchObject({ generation: 3, status: "revoked", credentialHash: null });
    expect(r.decision.notices({ kind: "host" }, () => true).rows).toHaveLength(2); expect(r.verify()).toBeTruthy();
    const person = r.hub().administrator as { realm: string; objectId: string };
    const rename = w.prepare({ kind: "rename", name: "After member move" }, { person, sessionId: "hub-session", requestId: "rename" });
    w.commit(rename.ref, { person, sessionId: "hub-session", requestId: "rename" }, () => true);
    expect(() => r.decision.assertMounted(r.hub())).not.toThrow();
    r.db.exec("DELETE FROM hub_member_address_operations;UPDATE hub_member_address_head SET revision=0,operation_id=NULL");
    expect(() => r.decision.assertMounted(r.hub())).toThrow("recovery"); expect(r.verify()).toBeTruthy();
  });
  it.each(["owner", "epoch", "probe"])("async control retires a replaced %s without borrowing fresh authority", async mode => {
    const r = await rig(), w = r.writer(), { createHubMemberAddressControl } = await import("../src/hub/settings-member-address-control.js");
    let current = true;
    const control = createHubMemberAddressControl({ home: r.home, writer: w, readConfig: () => ({ hub: r.hub() }), running: () => true, settle: async () => {},
      withDecision: async (work, owner) => { if (!owner()) throw Error("retired"); return work(r.decision); },
      probe: async () => { if (mode === "probe") current = false; } });
    const context = { actor, ownerKey: {}, authorityEpoch: 1, current: () => current }, raw = { origin: r.candidate.origin, listen: r.candidate.listen };
    if (mode === "probe") await expect(control.prepare(raw, context)).rejects.toThrow("denied");
    else { const p = await control.prepare(raw, context); await expect(control.commit({ ref: p.ref }, { ...context, ...(mode === "owner" ? { ownerKey: {} } : { authorityEpoch: 2 }) })).rejects.toThrow("expired"); }
    expect(r.decision.head().revision).toBe(0); expect(r.store.read().fleets[0]!.status).toBe("active"); expect(w.pending()).toBe(false);
  });
  for (const at of ["member-certificate", "member-material", "member-staged", "member-decision", "member-identity", "member-manifest", "member-config", "member-receipt", "member-done", "member-cleanup-journal", "member-cleanup-stage"]) {
    it(`crash after ${at}: recover exact identity/manifest/config from SQL without repeating revocation`, async () => {
      const r = await rig(), before = structuredClone(r.hub()), w = r.writer(s => { if (s === at) throw Error("crash"); });
      const p = w.memberAddress!.prepare(r.candidate, actor, () => true); expect(() => w.memberAddress!.commit(p.ref, actor, () => true)).toThrow("crash");
      const decided = !["member-certificate", "member-material", "member-staged"].includes(at);
      r.writer().recover(); expect(r.verify()).toBeTruthy(); expect(r.writer().pending()).toBe(false);
      expect(r.hub().memberOrigin).toBe(decided ? r.candidate.origin : before.memberOrigin);
      expect(r.store.read().fleets[0]!.generation).toBe(decided ? 3 : 2);
      const state = r.store.read(), audits = r.db.prepare("SELECT count(*) n FROM audit").get();
      r.writer().recover(); expect(r.store.read()).toEqual(state); expect(r.db.prepare("SELECT count(*) n FROM audit").get()).toEqual(audits);
    });
  }
  it("a strict ancestor flush failure cannot reach the member SQL decision", async () => {
    const r = await rig(), w = r.writer(), before = structuredClone(r.hub()), p = w.memberAddress!.prepare(r.candidate, actor, () => true);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const spy = vi.mocked(fs.fsyncSync).mockImplementation(fd => { if (actual.fstatSync(fd).isDirectory()) throw Error("directory flush refused"); actual.fsyncSync(fd); });
    try { expect(() => w.memberAddress!.commit(p.ref, actor, () => true)).toThrow("directory flush refused"); }
    finally { spy.mockImplementation(actual.fsyncSync); }
    expect(r.hub()).toEqual(before); expect(r.decision.head().revision).toBe(0); expect(r.store.read().fleets[0]!.status).toBe("active"); expect(r.verify()).toBeTruthy();
  });
  it("fresh owner proof cannot replace the retired preparation or a changed affected-fleet snapshot", async () => {
    const r = await rig(), w = r.writer(); let current = true;
    const p = w.memberAddress!.prepare(r.candidate, actor, () => current); current = false;
    expect(() => w.memberAddress!.commit(p.ref, actor, () => true)).toThrow("denied");
    const fresh = w.memberAddress!.prepare(r.candidate, actor, () => true);
    r.store.mutate({ at: 2000, requestId: "other", actor: { kind: "local-host" }, action: "fixture.other", result: "completed" }, () => {});
    expect(() => w.memberAddress!.commit(fresh.ref, actor, () => true)).toThrow("stale"); expect(w.pending()).toBe(false);
  });
  it("an unrelated identity/config edit after SQL is preserved and holds recovery", async () => {
    for (const file of ["identity", "config"]) {
      const r = await rig(), w = r.writer(s => { if (s === "member-decision") throw Error("crash"); }), p = w.memberAddress!.prepare(r.candidate, actor, () => true);
      expect(() => w.memberAddress!.commit(p.ref, actor, () => true)).toThrow("crash");
      if (file === "identity") { const path = join(r.home, "hub/keys/identity.json"), value = JSON.parse(readFileSync(path, "utf8")); writeFileSync(path, JSON.stringify({ ...value, memberOrigin: "https://wrong.example.test" }), { mode: 0o600 }); }
      else r.hub().name = "outside edit";
      const manifest = readFileSync(join(r.home, "hub/init-manifest.json")); expect(() => r.writer().recover()).toThrow();
      expect(readFileSync(join(r.home, "hub/init-manifest.json"))).toEqual(manifest); expect(w.pending()).toBe(true);
    }
  });
  it("even another valid same-key certificate cannot replace the exact staged bytes after SQL", async () => {
    const r = await rig(), old = readFileSync(join(r.home, "hub/keys/identity.json"));
    const alternate = execFileSync("/usr/bin/openssl", ["req", "-new", "-x509", "-sha256", "-days", "1", "-key", join(r.home, "hub/keys/tls-key.pem"),
      "-subj", "/CN=Owned replacement fixture", "-addext", "subjectAltName=DNS:member.example.test"], { encoding: "utf8", timeout: 10000 });
    const w = r.writer(s => { if (s === "member-decision") {
      const j = JSON.parse(readFileSync(join(r.home, "hub/settings-journal.json"), "utf8")); writeFileSync(join(r.home, `hub/member-address/${j.id}/cert.pem`), alternate, { mode: 0o600 });
    } });
    const p = w.memberAddress!.prepare(r.candidate, actor, () => true); expect(() => w.memberAddress!.commit(p.ref, actor, () => true)).toThrow("recovery");
    expect(readFileSync(join(r.home, "hub/keys/identity.json"))).toEqual(old); expect(w.pending()).toBe(true);
  });
  it("a postcommit staged certificate replacement is refused before identity publication", async () => {
    const r = await rig(), old = readFileSync(join(r.home, "hub/keys/identity.json")), w = r.writer(s => { if (s === "member-decision") {
      const j = JSON.parse(readFileSync(join(r.home, "hub/settings-journal.json"), "utf8")); writeFileSync(join(r.home, `hub/member-address/${j.id}/cert.pem`), "tampered", { mode: 0o600 });
    } });
    const p = w.memberAddress!.prepare(r.candidate, actor, () => true); expect(() => w.memberAddress!.commit(p.ref, actor, () => true)).toThrow("recovery");
    expect(readFileSync(join(r.home, "hub/keys/identity.json"))).toEqual(old); expect(() => r.writer().recover()).toThrow("recovery");
  });
});
