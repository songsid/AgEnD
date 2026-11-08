/** Real private SQLite/FULL/WAL, transport floor and audit; staged-file images are inert hashes, not a file-writer test. */
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHubMigrations, bindHubInstance, HUB_INSTANCE_MIGRATION, openHubDatabase } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { parseGroupPolicy } from "../src/hub/group-policy/model.js";
import { HUB_TRANSPORT_MIGRATION, HubTransportStore } from "../src/hub/store.js";
import { HubFileVersionFloor } from "../src/hub/version-floor.js";
import { readHubSessionEpoch } from "../src/hub/session-epoch.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION, readHubDirectorySettingsHead,
  type HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";
import { createHubDirectorySettingsProof } from "../src/hub/settings-directory-proof.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import { createHubDirectoryMountBarrier } from "../src/hub/settings-directory-mount.js";
import { withHubDirectoryRecovery } from "../src/hub/settings-directory-recovery.js";
import { readHubDirectorySettingsImage, createHubSettingsWriter, SETTINGS_JOURNAL, type HubSettingsWriterDeps } from "../src/hub/settings-commit.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { BIND_PASSWORD_REF, BIND_SECRET_REL } from "../src/hub/init/layout.js";
import { ensurePrivateDirectory } from "../src/hub/private-files.js";
import { atomicWriteFileSync } from "../src/atomic-write.js";

const admin = { realm: "fictional", objectId: "11111111-1111-4111-8111-111111111111" };
const other = { realm: "fictional", objectId: "22222222-2222-4222-8222-222222222222" };
const image = (label: string) => ({ configDigest: label.repeat(64), configSha: label.repeat(64), directorySha: label.repeat(64), manifestSha: label.repeat(64), bindSecretSha: label.repeat(64) });
const before = image("a"), after = image("b"), third = image("c");
const cleanup: Array<() => void> = [];
function rig(options: { home?: string; hubId?: string } = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "hub-directory-decision-")); chmodSync(home, 0o700);
  const hubId = options.hubId ?? randomUUID(), key = randomBytes(32);
  const migrations = [HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS,
    groupPolicyMigration(hubId, admin.realm, "generation-old"), HUB_DIRECTORY_SETTINGS_MIGRATION];
  const floor = new HubFileVersionFloor(home, "hub/floors/test"); floor.initialize();
  let db = openHubDatabase(home, "hub/test.sqlite", { create: true });
  let store: HubTransportStore, decision: ReturnType<typeof createHubDirectorySettingsDecision>;
  let auditHook: (() => unknown) | undefined;
  function open() {
    applyHubMigrations(db, migrations);
    const audit = createHubAudit({ db, contentKey: key, now: () => 1000 });
    store = new HubTransportStore(db, { floor, appendAudit(record, owning) {
      audit.appendInTransaction(record, owning);
      const f = auditHook; auditHook = undefined; return f?.() as void;
    } });
    if (!db.prepare("SELECT 1 FROM hub_transport_state").get()) store.initialize();
    decision = createHubDirectorySettingsDecision({ db, transport: store, hubId });
  }
  open();
  db.prepare("INSERT INTO hub_people VALUES(?,?,?,?,?,'active',0)").run(`${admin.realm}/${admin.objectId}`, admin.realm, admin.objectId, "Fictional Admin", "admin");
  db.prepare("INSERT INTO hub_sessions VALUES(?,?,?,?,?,?,'active',0)").run("a".repeat(64), "old-session", `${admin.realm}/${admin.objectId}`, 0, 0, 100_000);
  const request = (over: Partial<HubDirectoryDecisionRequest> = {}): HubDirectoryDecisionRequest => ({
    id: randomUUID(), expected: decision.inspect(), before, after, generation: "generation-new", receiptSha: "d".repeat(64),
    actor: { kind: "hub-administrator", person: { ...admin }, sessionId: "old-session", requestId: randomUUID() }, at: 1000,
    changes: ["server", "secret"], recipients: [{ kind: "host", sink: "owner-needs-you" }, { kind: "person", person: other }], ...over,
  });
  const result = { home, contentKey: Buffer.from(key), get db() { return db; }, get store() { return store; }, get decision() { return decision; }, floor, hubId, migrations, request,
    auditOnce: (f: () => unknown) => { auditHook = f; },
    policy: () => parseGroupPolicy(JSON.parse((db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body)),
    restart: () => { db.close(); db = openHubDatabase(home, "hub/test.sqlite", { create: false }); open(); },
    counts: () => Object.fromEntries(["hub_settings_operations", "hub_settings_security_notices", "hub_audit"].map(table =>
      [table, (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n])),
    close: () => { if (db.open) db.close(); rmSync(home, { recursive: true, force: true }); expect(existsSync(home)).toBe(false); },
  };
  cleanup.push(result.close); return result;
}
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

describe("one durable directory decision", () => {
  it("commits exact staged hashes, binding/version, epoch/session end, audit and FULL old-recipient notice together", () => {
    const r = rig(), input = r.request();
    const saved = r.decision.decide(input, () => {});
    expect(saved).toMatchObject({ id: input.id, kind: "directory", compensates: null, previousGeneration: "generation-old", directoryEpoch: 1, authorizationVersion: 1, after });
    expect(r.decision.inspect()).toMatchObject({ operationId: input.id, directoryEpoch: 1, transportRevision: 1, authorizationVersion: 1 });
    expect(r.policy()).toMatchObject({ state: "never-enabled", generation: "generation-new", revision: 2 });
    expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "ended" });
    expect(r.counts()).toEqual({ hub_settings_operations: 1, hub_settings_security_notices: 1, hub_audit: 1 });
    expect(r.decision.notices()).toEqual([expect.objectContaining({ operationId: input.id, phase: "applying", actor: input.actor,
      changes: input.changes, recipients: input.recipients })]);
    expect(r.db.prepare("SELECT kind,target,state FROM hub_settings_security_targets ORDER BY kind").all()).toEqual([
      { kind: "host", target: "owner-needs-you", state: "queued" }, { kind: "person", target: `${other.realm}/${other.objectId}`, state: "queued" },
    ]);
    expect(r.floor.read()).toBe(1);
    expect(r.decision.imageCurrent(before)).toBe(false); expect(r.decision.imageCurrent(after)).toBe(true);
  });
  it("survives physical DB close/reopen with exactly the same decision and full old recipient snapshot", () => {
    const r = rig(), input = r.request(), result = r.decision.decide(input, () => {}), notices = r.decision.notices();
    r.restart();
    expect(r.decision.operation(input.id)).toEqual(result); expect(r.decision.notices()).toEqual(notices);
    expect(r.decision.inspect()).toMatchObject({ directoryEpoch: 1, operationId: input.id });
    expect(r.decision.imageCurrent(before)).toBe(false);
    expect(() => r.decision.decide(input, () => {})).toThrow(/conflict/);
    expect(r.counts().hub_settings_operations).toBe(1);
  });
  it("allows a separately verified cosmetic rename without rebinding directory authority, but rejects a directory/secret mismatch", () => {
    const r = rig(); r.decision.decide(r.request(), () => {});
    const renamed = { ...after, configSha: "e".repeat(64), configDigest: "e".repeat(64), manifestSha: "e".repeat(64) };
    expect(r.decision.imageCurrent(renamed)).toBe(true);
    expect(r.decision.imageCurrent({ ...renamed, directorySha: "f".repeat(64) })).toBe(false);
    r.decision.decide(r.request({ before: renamed, after: third }), () => {});
    expect(r.decision.inspect().directoryEpoch).toBe(2);
  });
  it("snapshots nested actor, recipients, staged hashes and expected image before callbacks", () => {
    const r = rig(), input = r.request(), original = structuredClone(input); let n = 0;
    r.decision.decide(input, () => {
      if (++n !== 1) return;
      input.after.configSha = "f".repeat(64); input.actor.sessionId = "replacement";
      input.recipients[0] = { kind: "host", sink: "replacement" }; input.expected.directoryEpoch = 99;
    });
    expect(r.decision.operation(original.id)).toMatchObject({ actor: original.actor, after: original.after });
    expect(r.decision.notices()[0]!.recipients).toEqual(original.recipients);
  });
  it.each(["policy", "head", "transport", "actor"] as const)("refuses a stale %s before the floor or any decision effect", kind => {
    const r = rig(), input = r.request();
    if (kind === "policy") input.expected.policySha = "f".repeat(64);
    if (kind === "head") input.expected.operationId = randomUUID();
    if (kind === "transport") input.expected.transportRevision++;
    if (kind === "actor" && input.actor.kind === "hub-administrator") input.actor.person.realm = "elsewhere";
    expect(() => r.decision.decide(input, () => {})).toThrow();
    expect(r.floor.read()).toBe(0); expect(readHubSessionEpoch(r.db)).toBe(0); expect(r.counts().hub_settings_operations).toBe(0);
  });
  it("requires a host sink and refuses unknown payload keys instead of storing secrets", () => {
    const r = rig(), input = r.request();
    input.recipients = [{ kind: "person", person: other }];
    expect(() => r.decision.decide(input, () => {})).toThrow(/invalid/);
    expect(() => r.decision.decide({ ...r.request(), password: "do-not-persist" } as HubDirectoryDecisionRequest, () => {})).toThrow(/invalid/);
    expect(r.floor.read()).toBe(0);
  });
  it("never accepts a different store DB as the owning transaction", () => {
    const r = rig(), other = rig(), wrong = createHubDirectorySettingsDecision({ db: r.db, transport: other.store, hubId: r.hubId });
    expect(() => wrong.decide(r.request(), () => {})).toThrow(/invalid/);
    expect(r.counts().hub_settings_operations).toBe(0); expect(other.counts().hub_settings_operations).toBe(0);
    expect(r.floor.read()).toBe(0); expect(other.floor.read()).toBe(0);
  });
  it("refuses an outer savepoint: the settings decision owns the durable commit", () => {
    const r = rig();
    expect(() => r.db.transaction(() => r.decision.decide(r.request(), () => {})).immediate()).toThrow(/invalid/);
    expect(r.floor.read()).toBe(0);
  });
  it("a stale final proof rolls back EVERY SQL effect and leaves an advanced floor uncertain across restart", () => {
    const r = rig(), input = r.request(); let n = 0;
    expect(() => r.decision.decide(input, () => { if (++n === 2) throw Error("session expired"); })).toThrow("session expired");
    expect(r.counts()).toEqual({ hub_settings_operations: 0, hub_settings_security_notices: 0, hub_audit: 0 });
    expect(r.policy().generation).toBe("generation-old"); expect(readHubSessionEpoch(r.db)).toBe(0);
    expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "active" });
    expect(r.floor.read()).toBe(1); expect(() => r.store.read()).toThrow(/uncertain/);
    expect(() => r.decision.imageCurrent(before)).toThrow(/uncertain/);
    r.restart(); expect(() => r.store.read()).toThrow(/uncertain/);
  });
  it.each(["audit-failure", "audit-thenable", "notice-deletion", "target-deletion", "reentrant-version", "proof-thenable"])("%s never commits partial authority", kind => {
    const r = rig(), input = r.request();
    if (kind === "audit-failure") r.auditOnce(() => { throw Error("audit refused"); });
    if (kind === "audit-thenable") r.auditOnce(() => Promise.resolve());
    if (kind === "notice-deletion") r.auditOnce(() => { r.db.exec("DELETE FROM hub_settings_security_targets; DELETE FROM hub_settings_security_notices"); });
    if (kind === "target-deletion") r.auditOnce(() => { r.db.exec("DELETE FROM hub_settings_security_targets WHERE kind='host'"); });
    if (kind === "reentrant-version") r.auditOnce(() => {
      r.store.mutate({ at: 1000, requestId: randomUUID(), actor: { kind: "local-host" }, action: "test.changed", result: "completed" }, s => { s.revocationVersion++; });
    });
    let calls = 0;
    expect(() => r.decision.decide(input, () => { if (kind === "proof-thenable" && ++calls === 2) return Promise.resolve() as unknown as void; })).toThrow();
    expect(r.counts()).toEqual({ hub_settings_operations: 0, hub_settings_security_notices: 0, hub_audit: 0 });
    expect(readHubSessionEpoch(r.db)).toBe(0); expect(() => r.store.read()).toThrow(/uncertain/);
  });
  it("a failed notice INSERT rolls back without raising the floor", () => {
    const r = rig();
    r.db.exec("CREATE TRIGGER refuse_notice BEFORE INSERT ON hub_settings_security_notices BEGIN SELECT RAISE(ABORT,'full'); END");
    expect(() => r.decision.decide(r.request(), () => {})).toThrow("full");
    expect(r.counts()).toEqual({ hub_settings_operations: 0, hub_settings_security_notices: 0, hub_audit: 0 });
    expect(r.floor.read()).toBe(0); expect(readHubSessionEpoch(r.db)).toBe(0);
  });
});

describe("forward compensation", () => {
  it("restores original CONTENT under a NEW operation/epoch while preserving newer revoke/deny/provenance and both notices", () => {
    const r = rig(), first = r.request(), original = r.decision.decide(first, () => {}), fleetId = randomUUID();
    r.store.mutate({ at: 2000, requestId: randomUUID(), actor: { kind: "local-host" }, action: "test.revoked", result: "completed" }, s => {
      s.fleets.push({ id: fleetId, owner: other, generation: 7, credentialHash: null, status: "revoked" }); s.revocationVersion++;
    });
    const latest = { ...r.policy(), state: "enabled" as const, revision: 3, denies: [{ person: other, deny: ["pair_fleet" as const] }] };
    r.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(latest));
    r.db.exec("CREATE TABLE test_provenance(id TEXT PRIMARY KEY,body TEXT NOT NULL); INSERT INTO test_provenance VALUES('kept','manual-authority')");
    const compensation = r.request({ before: after, after: before, generation: original.previousGeneration, actor: first.actor, recipients: first.recipients });
    const saved = r.decision.compensate(first.id, compensation, () => {});
    expect(saved).toMatchObject({ kind: "directory-compensation", compensates: first.id, directoryEpoch: 2, authorizationVersion: 3 });
    expect(r.floor.read()).toBe(3); expect(r.policy()).toEqual({ ...latest, generation: "generation-old", revision: 4 });
    expect(r.store.read().fleets).toEqual([{ id: fleetId, owner: other, generation: 7, credentialHash: null, status: "revoked" }]);
    expect(r.db.prepare("SELECT body FROM test_provenance").get()).toEqual({ body: "manual-authority" });
    expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "ended" });
    expect(r.decision.notices()).toHaveLength(2); expect(r.decision.notices().map(n => n.recipients)).toEqual([first.recipients, first.recipients]);
    expect(r.counts().hub_audit).toBe(3); expect(r.decision.imageCurrent(before)).toBe(true);
    r.restart(); expect(r.decision.operation(saved.id)).toEqual(saved); expect(r.decision.inspect().directoryEpoch).toBe(2);
  });
  it.each(["new-head", "third-image", "recipient", "actor", "generation"] as const)("refuses %s rather than improvising a restore", kind => {
    const r = rig(), first = r.request(), original = r.decision.decide(first, () => {});
    if (kind === "new-head") r.decision.decide(r.request({ before: after, after: third, generation: "generation-third" }), () => {});
    const input = r.request({ before: after, after: before, generation: original.previousGeneration, actor: first.actor, recipients: first.recipients });
    if (kind === "third-image") input.after = third;
    if (kind === "recipient") input.recipients = [{ kind: "host", sink: "replacement-owner" }];
    if (kind === "actor" && input.actor.kind === "hub-administrator") input.actor.person = other;
    if (kind === "generation") input.generation = "unrelated";
    const floor = r.floor.read(); expect(() => r.decision.compensate(first.id, input, () => {})).toThrow(/conflict/); expect(r.floor.read()).toBe(floor);
  });
  it("never compensates a compensation or revives a cancelled automatic reservation", () => {
    const r = rig(), first = r.request(), offerId = randomUUID();
    r.store.mutate({ at: 0, requestId: randomUUID(), actor: { kind: "local-host" }, action: "test.offer", result: "completed" }, s => {
      s.pairings.push({ id: offerId, owner: other, codeHash: "a".repeat(64), expiresAt: 50_000, fleetId: null, claimHash: null, fingerprint: null,
        ownerConfirmed: false, adminApproved: false, state: "offered", automatic: { label: "Fictional", initiatingSessionId: "session" } });
    });
    first.expected = r.decision.inspect(); const original = r.decision.decide(first, () => {});
    expect(r.store.read().pairings[0]).toMatchObject({ state: "revoked", codeHash: null });
    const comp = r.decision.compensate(first.id, r.request({ before: after, after: before, generation: original.previousGeneration, actor: first.actor }), () => {});
    expect(r.store.read().pairings[0]!.state).toBe("revoked");
    expect(() => r.decision.compensate(comp.id, r.request({ before, after }), () => {})).toThrow(/conflict/);
  });
});

describe("missing authority cannot reset", () => {
  it.each(["row", "partial-table", "operation"] as const)("refuses a lost %s without recreating zero", kind => {
    const r = rig(); r.decision.decide(r.request(), () => {});
    if (kind === "row") r.db.exec("DELETE FROM hub_settings_head");
    if (kind === "partial-table") { r.db.pragma("foreign_keys=OFF"); r.db.exec("DROP TABLE hub_settings_security_notices"); }
    if (kind === "operation") { r.db.pragma("foreign_keys=OFF"); r.db.exec("DELETE FROM hub_settings_operations"); }
    expect(() => r.db.transaction(() => HUB_DIRECTORY_SETTINGS_MIGRATION.up(r.db)).immediate()).toThrow(/uncertain/);
    expect(readHubSessionEpoch(r.db)).toBe(1);
  });
  it("refuses an older binary's registry and a forged head/epoch mismatch", () => {
    const r = rig(); r.decision.decide(r.request(), () => {});
    expect(() => applyHubMigrations(r.db, r.migrations.filter(m => m.component !== HUB_DIRECTORY_SETTINGS_MIGRATION.component))).toThrow(/does not know/);
    r.db.prepare("UPDATE hub_settings_head SET directory_epoch=0").run();
    expect(() => readHubDirectorySettingsHead(r.db)).toThrow(/uncertain/);
  });
});

async function writerRig() {
  const home = mkdtempSync(join(tmpdir(), "hub-directory-writer-")); chmodSync(home, 0o700);
  const memberOrigin = "https://hub.example.test:8443", identity = await provisionHubIdentity({ home, memberOrigin });
  const r = rig({ home, hubId: identity.hubId });
  const hub = { enabled: true, hubId: identity.hubId, name: "Fictional Hub", memberOrigin, webOrigin: "https://hub.example.test",
    webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 },
    directory: { realm: "fictional", profile: "ad", url: "ldaps://old.example.test", baseDn: "DC=example,DC=test", bindDn: "CN=service", bindPasswordRef: BIND_PASSWORD_REF },
    administrator: admin, retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated" };
  const configFile = join(home, "hub/test-config.json"), manifestFile = join(home, "hub/init-manifest.json"), secretFile = join(home, BIND_SECRET_REL);
  ensurePrivateDirectory(home, "hub/secrets"); writeFileSync(secretFile, "\ufeff old secret \n", { mode: 0o600 });
  writeFileSync(configFile, JSON.stringify(hub), { mode: 0o600 });
  const planDigest = hubPlanDigest(hub), confirmationId = "c".repeat(32), committedAt = "2026-11-08T00:00:00.000Z";
  writeFileSync(manifestFile, JSON.stringify({ v: 1, hubId: identity.hubId, planDigest, confirmationId, committedAt,
    signature: sealHubInitialization({ home, planDigest, confirmationId, committedAt }) }), { mode: 0o600 });
  const readHub = () => JSON.parse(readFileSync(configFile, "utf8")) as typeof hub;
  let now = 1000, crash: string | undefined, stageHook: (() => void) | undefined;
  let stepHook: { name: string; run(): void } | undefined;
  const deps: HubSettingsWriterDeps = { home, readHub, now: () => now, directoryDecision: () => r.decision,
    saveHub(patches) {
      const next = readHub();
      for (const p of patches) {
        expect(p.path[0]).toBe("hub");
        if (p.remove) delete (next as Record<string, unknown>)[p.path[1]!]; else (next as Record<string, unknown>)[p.path[1]!] = p.value;
      }
      atomicWriteFileSync(configFile, JSON.stringify(next), { mode: 0o600 });
    },
    step(name) {
      if (name === "staged") { const f = stageHook; stageHook = undefined; f?.(); }
      if (name === stepHook?.name) { const f = stepHook.run; stepHook = undefined; f(); }
      if (name === crash) { crash = undefined; throw Error(`crash:${name}`); }
    },
  };
  const actor = { kind: "hub-administrator" as const, person: { ...admin }, sessionId: "old-session", requestId: randomUUID() };
  const candidate = () => ({ directory: { ...readHub().directory, url: "ldaps://new.example.test", baseDn: "OU=People,DC=example,DC=test", profile: "ad" as const },
    bindPassword: "\ufeff new secret \n", changes: ["server", "search", "secret"] as HubDirectoryDecisionRequest["changes"],
    recipients: [{ kind: "host" as const, sink: "owner-needs-you" }, { kind: "person" as const, person: other }] });
  return Object.assign(r, { readHub, secret: () => readFileSync(secretFile, "utf8"), manifest: () => readFileSync(manifestFile, "utf8"),
    actor, candidate, writer: (over: Partial<HubSettingsWriterDeps> = {}) => createHubSettingsWriter({ ...deps, ...over }), crash: (step: string) => { crash = step; },
    stagedOnce: (f: () => void) => { stageHook = f; }, tick: (ms: number) => { now += ms; },
    stepOnce: (name: string, run: () => void) => { stepHook = { name, run }; },
    verifies: () => verifyHubInitialization({ home, hubId: identity.hubId, memberOrigin, planDigest: hubPlanDigest(readHub()) }),
    tamperConfig: () => { const h = readHub(); h.name = "Third image"; writeFileSync(configFile, JSON.stringify(h)); },
  });
}

describe("directory-v2 uses the SAME sealed settings writer", () => {
  it("stages privately, commits through SQL, installs the exact seal/secret, and never returns write-only data", async () => {
    const r = await writerRig(), w = r.writer(), old = r.readHub(), candidate = r.candidate();
    const p = w.directory!.prepare(candidate, r.actor, () => true);
    expect(Object.keys(p).sort()).toEqual(["expiresAt", "ref"]); expect(r.readHub()).toEqual(old);
    const done = w.directory!.commit(p.ref, { ...r.actor, requestId: randomUUID() }, () => true);
    expect(Object.keys(done).sort()).toEqual(["directoryEpoch", "receiptId"]);
    expect(done.directoryEpoch).toBe(1); expect(w.pending()).toBe(false);
    expect(r.readHub()).toEqual({ ...old, directory: candidate.directory }); expect(r.secret()).toBe("\ufeff new secret \n");
    expect(r.verifies().planDigest).toBe(hubPlanDigest(r.readHub()));
    expect(r.decision.operation(done.receiptId).after.bindSecretSha).not.toBe(r.decision.operation(done.receiptId).before.bindSecretSha);
  });
  it.each(["staged", "directory-decision", "directory-secret", "manifest", "config", "done"])("recovers a stopped process at %s using the DB decision, not the file phase", async point => {
    const r = await writerRig(), w = r.writer(), old = r.readHub(), oldSecret = r.secret();
    const p = w.directory!.prepare(r.candidate(), r.actor, () => true); r.crash(point);
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow(`crash:${point}`);
    expect(w.pending()).toBe(true); r.restart();
    const recovered = r.writer(); recovered.recover(); expect(recovered.pending()).toBe(false);
    if (point === "staged") {
      expect(r.readHub()).toEqual(old); expect(r.secret()).toBe(oldSecret); expect(r.decision.inspect().directoryEpoch).toBe(0);
    } else {
      expect(r.readHub().directory.url).toBe("ldaps://new.example.test"); expect(r.secret()).toBe("\ufeff new secret \n");
      expect(r.decision.inspect().directoryEpoch).toBe(1); expect(r.decision.notices()).toHaveLength(1);
    }
    expect(() => r.verifies()).not.toThrow();
  });
  it("never trusts a forged installing journal when no SQL decision exists", async () => {
    const r = await writerRig(), w = r.writer(), old = r.readHub();
    const p = w.directory!.prepare(r.candidate(), r.actor, () => true); r.crash("staged");
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow();
    const path = join(r.home, SETTINGS_JOURNAL), j = JSON.parse(readFileSync(path, "utf8")); j.phase = "installing";
    writeFileSync(path, JSON.stringify(j)); w.recover();
    expect(r.readHub()).toEqual(old); expect(r.decision.inspect().directoryEpoch).toBe(0);
  });
  it("a third current file or tampered staged material is refused before any recovery overwrite", async () => {
    const r = await writerRig(), w = r.writer();
    const p = w.directory!.prepare(r.candidate(), r.actor, () => true); r.crash("directory-decision");
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow();
    const originalManifest = r.manifest(), originalSecret = r.secret(); r.tamperConfig();
    expect(() => w.recover()).toThrow(/outside/); expect(r.manifest()).toBe(originalManifest); expect(r.secret()).toBe(originalSecret);
  });
  it("a tampered staged secret refuses recovery before writing the still-old active files", async () => {
    const r = await writerRig(), w = r.writer();
    const p = w.directory!.prepare(r.candidate(), r.actor, () => true); r.crash("directory-decision");
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow();
    const oldHub = r.readHub(), oldSecret = r.secret(), oldManifest = r.manifest();
    const j = JSON.parse(readFileSync(join(r.home, SETTINGS_JOURNAL), "utf8"));
    writeFileSync(join(r.home, "hub/settings-staged", `${j.id}.directory-new-secret`), "tampered");
    expect(() => w.recover()).toThrow(/staged/);
    expect(r.readHub()).toEqual(oldHub); expect(r.secret()).toBe(oldSecret); expect(r.manifest()).toBe(oldManifest);
  });
  it("rejects changed staged material before SQL authorization and keeps the old service files", async () => {
    const r = await writerRig(), w = r.writer(), old = r.readHub(), oldSecret = r.secret();
    const p = w.directory!.prepare(r.candidate(), r.actor, () => true);
    r.stagedOnce(() => {
      const j = JSON.parse(readFileSync(join(r.home, SETTINGS_JOURNAL), "utf8"));
      writeFileSync(join(r.home, "hub/settings-staged", `${j.id}.directory-new-secret`), "changed before SQL");
    });
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow(/stale/);
    expect(r.floor.read()).toBe(0); expect(r.counts().hub_settings_operations).toBe(0);
    expect(r.readHub()).toEqual(old); expect(r.secret()).toBe(oldSecret); expect(w.pending()).toBe(false);
  });
  it("never accepts an async boolean proof or leaks its rejection", async () => {
    const r = await writerRig(), w = r.writer();
    expect(() => w.directory!.prepare(r.candidate(), r.actor, () => Promise.reject(Error("async proof")) as unknown as boolean)).toThrow(/denied/);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(r.floor.read()).toBe(0);
  });
  it("binds the shared writer to this Hub's SQL participant", async () => {
    const r = await writerRig(), another = rig(), w = r.writer({ directoryDecision: () => another.decision });
    expect(() => w.directory!.prepare(r.candidate(), r.actor, () => true)).toThrow(/another Hub/);
    expect(r.floor.read()).toBe(0); expect(another.floor.read()).toBe(0);
  });
  it("refuses a non-admin actor, a substituted prepare image, and session/clock changes without issuing a decision", async () => {
    const r = await writerRig(), w = r.writer();
    expect(() => w.directory!.prepare(r.candidate(), { ...r.actor, person: other }, () => true)).toThrow(/denied/);
    expect(() => w.directory!.prepare(r.candidate(), r.actor, () => { r.tamperConfig(); return true; })).toThrow(/stale/);
    expect(r.floor.read()).toBe(0);
  });
  it("the prepared reference is single-use and bound to session and monotonic time window", async () => {
    const r = await writerRig(), w = r.writer();
    const p = w.directory!.prepare(r.candidate(), r.actor, () => true);
    expect(() => w.directory!.commit(p.ref, { ...r.actor, sessionId: "other-session" }, () => true)).toThrow(/denied/);
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow(/expired/);
    const next = w.directory!.prepare(r.candidate(), r.actor, () => true); r.tick(-1);
    expect(() => w.directory!.commit(next.ref, r.actor, () => true)).toThrow(/denied/);
    expect(r.floor.read()).toBe(0);
  });
  it("held expiry before SQL cancels cleanly; expired/disconnected actor after SQL cannot abandon completion", async () => {
    const r = await writerRig(), w = r.writer(), old = r.readHub();
    const p = w.directory!.prepare(r.candidate(), r.actor, () => true); r.stagedOnce(() => r.tick(300_000));
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow();
    expect(w.pending()).toBe(false); expect(r.readHub()).toEqual(old); expect(r.floor.read()).toBe(0);
    const next = w.directory!.prepare(r.candidate(), r.actor, () => true); r.crash("directory-decision");
    expect(() => w.directory!.commit(next.ref, r.actor, () => true)).toThrow(); r.tick(300_000);
    r.writer().recover(); expect(r.readHub().directory.url).toBe("ldaps://new.example.test");
  });
  it("a late post-floor proof failure holds recovery, and never treats uncertain SQL absence as permission to discard", async () => {
    const r = await writerRig(), w = r.writer(), old = r.readHub(), oldSecret = r.secret();
    const p = w.directory!.prepare(r.candidate(), r.actor, () => true);
    r.auditOnce(() => r.tick(300_000));
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow();
    expect(w.pending()).toBe(true); expect(r.floor.read()).toBe(1); expect(readHubSessionEpoch(r.db)).toBe(0);
    expect(() => w.recover()).toThrow(/uncertain/); expect(w.pending()).toBe(true);
    expect(r.readHub()).toEqual(old); expect(r.secret()).toBe(oldSecret);
  });
  it.each([
    { name: "expires at the upper bound", advance: 300_000, allowed: false },
    { name: "moves before the preparation", advance: -1, allowed: false },
    { name: "stays inside the bounds", advance: 299_999, allowed: true },
  ])("rechecks the writer clock after the final proof when it $name", async ({ advance, allowed }) => {
    const r = await writerRig(), w = r.writer(), old = r.readHub(), oldSecret = r.secret(), oldManifest = r.manifest();
    let proofs = 0;
    const current = () => { if (++proofs === 4) r.tick(advance); return true; };
    const p = w.directory!.prepare(r.candidate(), r.actor, current);
    if (allowed) {
      expect(w.directory!.commit(p.ref, r.actor, current)).toMatchObject({ directoryEpoch: 1 });
      expect(r.readHub().directory.url).toBe("ldaps://new.example.test"); expect(r.secret()).toBe("\ufeff new secret \n");
      expect(r.counts()).toEqual({ hub_settings_operations: 1, hub_settings_security_notices: 1, hub_audit: 1 });
      expect(readHubSessionEpoch(r.db)).toBe(1); expect(w.pending()).toBe(false); expect(() => r.verifies()).not.toThrow();
    } else {
      expect(() => w.directory!.commit(p.ref, r.actor, current)).toThrow(/denied/);
      expect(r.readHub()).toEqual(old); expect(r.secret()).toBe(oldSecret); expect(r.manifest()).toBe(oldManifest);
      expect(r.counts()).toEqual({ hub_settings_operations: 0, hub_settings_security_notices: 0, hub_audit: 0 });
      expect(r.policy().generation).toBe("generation-old"); expect(readHubSessionEpoch(r.db)).toBe(0);
      expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "active" });
      expect(w.pending()).toBe(true); expect(() => w.recover()).toThrow(/uncertain/);
      r.restart();
      const recovered = r.writer(); expect(() => recovered.recover()).toThrow(/uncertain/); expect(recovered.pending()).toBe(true);
      expect(r.readHub()).toEqual(old); expect(r.secret()).toBe(oldSecret); expect(r.manifest()).toBe(oldManifest);
      expect(readHubSessionEpoch(r.db)).toBe(0); expect(r.counts().hub_settings_operations).toBe(0);
    }
    expect(proofs).toBe(4); expect(r.floor.read()).toBe(1);
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow(/expired/);
  });
  it("an obsolete installer stops before its next active-file effect when a new durable head appears", async () => {
    const r = await writerRig(), w = r.writer(), oldManifest = r.manifest(), old = r.readHub();
    const p = w.directory!.prepare(r.candidate(), r.actor, () => true);
    r.stepOnce("directory-secret", () => {
      // SQL-only participant control: no second file writer or real mount is invoked.
      const original = r.decision.operation(r.decision.inspect().operationId!);
      r.decision.decide(r.request({ before: original.after, after: third, generation: "newer-generation" }), () => {});
    });
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow(/newer/);
    expect(r.manifest()).toBe(oldManifest); expect(r.readHub()).toEqual(old);
    expect(r.decision.inspect().directoryEpoch).toBe(2);
  });
  it("requires explicit secret for a new target, keeps BOM for same-target reuse, and shares the rename lock", async () => {
    const r = await writerRig(), w = r.writer(), c = r.candidate(); delete (c as { bindPassword?: string }).bindPassword;
    expect(() => w.directory!.prepare(c, r.actor, () => true)).toThrow(/invalid/);
    c.directory = { ...r.readHub().directory, baseDn: c.directory.baseDn, profile: "ad" };
    const p = w.directory!.prepare(c, r.actor, () => true); r.crash("directory-decision");
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow();
    const who = { person: admin, sessionId: "old-session", requestId: randomUUID() };
    expect(() => w.commit(w.prepare({ kind: "rename", name: "Other name" }, who).ref, who, () => true)).toThrow(/busy/);
    w.recover(); expect(r.secret()).toBe("\ufeff old secret \n");
  });
  it("forward compensation uses a fresh seal/receipt, retains new denies and ends every old session", async () => {
    const r = await writerRig(), w = r.writer(), old = r.readHub(), oldSecret = r.secret();
    const done = w.directory!.commit(w.directory!.prepare(r.candidate(), r.actor, () => true).ref, r.actor, () => true), newManifest = r.manifest();
    const latest = { ...r.policy(), revision: 3, denies: [{ person: other, deny: ["pair_fleet" as const] }] };
    r.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(latest));
    r.tick(1);
    const compensated = w.directory!.compensate(done.receiptId, () => true);
    expect(compensated.directoryEpoch).toBe(2); expect(r.readHub()).toEqual(old); expect(r.secret()).toBe(oldSecret);
    expect(r.manifest()).not.toBe(newManifest); expect(r.verifies().confirmationId).not.toBe("c".repeat(32));
    expect(r.policy().denies).toEqual(latest.denies); expect(r.decision.notices()).toHaveLength(2);
    expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "ended" });
  });
  it.each(["expired", "staged-expiry", "final-expiry", "in-time"])("binds the compensation intent deadline through final SQL: %s", async mode => {
    const r = await writerRig(), w = r.writer();
    const saved = w.directory!.commit(w.directory!.prepare(r.candidate(), r.actor, () => true).ref, r.actor, () => true);
    const floor = r.floor.read(); let proofs = 0;
    const intent = () => { if (mode === "final-expiry" && ++proofs === 4) r.tick(1); return true; };
    if (mode === "staged-expiry") r.stagedOnce(() => { r.tick(1); });
    if (mode === "in-time") {
      expect(w.directory!.compensate(saved.receiptId, () => true, 1001).directoryEpoch).toBe(2);
    } else {
      expect(() => w.directory!.compensate(saved.receiptId, intent, mode === "expired" ? 1000 : 1001)).toThrow(mode === "expired" ? /expired/ : /denied/);
      expect(r.db.prepare("SELECT directory_epoch FROM hub_settings_head").get()).toEqual({ directory_epoch: 1 });
      expect(r.db.prepare("SELECT count(*) n FROM hub_settings_security_notices").get()).toEqual({ n: 1 });
      if (mode === "final-expiry") { expect(r.floor.read()).toBeGreaterThan(floor); expect(w.pending()).toBe(true); expect(() => r.decision.inspect()).toThrow(/uncertain/); }
    }
  });
  it("a later rename remains usable and is never overwritten by old directory compensation", async () => {
    const r = await writerRig(), w = r.writer();
    const done = w.directory!.commit(w.directory!.prepare(r.candidate(), r.actor, () => true).ref, r.actor, () => true);
    const who = { person: admin, sessionId: "new-session", requestId: randomUUID() };
    w.commit(w.prepare({ kind: "rename", name: "Renamed Hub" }, who).ref, who, () => true);
    expect(() => w.directory!.compensate(done.receiptId, () => true)).toThrow(/stale/);
    const candidate = r.candidate(); candidate.directory.baseDn = "OU=Next,DC=example,DC=test";
    w.directory!.commit(w.directory!.prepare(candidate, r.actor, () => true).ref, r.actor, () => true);
    expect(r.readHub().name).toBe("Renamed Hub"); expect(r.decision.inspect().directoryEpoch).toBe(2); expect(() => r.verifies()).not.toThrow();
  });
});


describe("directory decision/material mount barrier (internal, not composed)", () => {
  const barrier = (r: Awaited<ReturnType<typeof writerRig>>, current = () => true) => createHubDirectoryMountBarrier({
    home: r.home, hub: r.readHub(), decision: r.decision, current,
  });
  it("accepts an intact pre-decision seal and exports only an opaque source stamp", async () => {
    const r = await writerRig(), b = barrier(r), stamp = b.capture();
    expect(b.current()).toBe(true); expect(stamp).toEqual({ epoch: 0, image: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(stamp)).not.toContain(r.secret());
    expect(() => b.assertCurrent()).not.toThrow(); b.close(); expect(b.current()).toBe(false); expect(() => b.capture()).toThrow();
  });
  it("permanently fences the old mounted generation after a real SQL decision and admits only the installed successor", async () => {
    const r = await writerRig(), w = r.writer(), old = barrier(r), p = w.directory!.prepare(r.candidate(), r.actor, () => true);
    const saved = w.directory!.commit(p.ref, r.actor, () => true);
    expect(old.current()).toBe(false); expect(() => old.assertCurrent()).toThrow();
    const next = barrier(r); expect(next.capture().epoch).toBe(saved.directoryEpoch); expect(next.current()).toBe(true);
  });
  it("a decided-but-uninstalled or mixed generation never becomes a valid mount", async () => {
    const r = await writerRig(), w = r.writer(), p = w.directory!.prepare(r.candidate(), r.actor, () => true); r.crash("directory-decision");
    expect(() => w.directory!.commit(p.ref, r.actor, () => true)).toThrow("crash:directory-decision");
    expect(() => barrier(r)).toThrow();
    w.recover(); expect(() => barrier(r).assertCurrent()).not.toThrow();
  });
  it("a cosmetic rename after a directory decision still mounts under the same directory authority", async () => {
    const r = await writerRig(), w = r.writer(), p = w.directory!.prepare(r.candidate(), r.actor, () => true);
    w.directory!.commit(p.ref, r.actor, () => true); const old = barrier(r);
    const actor = { person: r.actor.person, sessionId: r.actor.sessionId, requestId: randomUUID() };
    const rename = w.prepare({ kind: "rename", name: "Renamed fictional Hub" }, actor); w.commit(rename.ref, actor, () => true);
    expect(() => old.assertCurrent()).toThrow(); expect(old.current()).toBe(false);
    const next = barrier(r); expect(next.capture().epoch).toBe(1); expect(next.current()).toBe(true);
  });
  it("a matching material hash is insufficient when the issuer seal is invalid", async () => {
    const r = await writerRig(), path = join(r.home, "hub/init-manifest.json"), original = r.manifest();
    const forged = JSON.parse(original); forged.signature = "AAAA"; writeFileSync(path, JSON.stringify(forged), { mode: 0o600 });
    expect(() => barrier(r)).toThrow(); writeFileSync(path, original, { mode: 0o600 }); expect(() => barrier(r)).not.toThrow();
  });
  it("rechecks the owner after material and seal validation before publishing the barrier", async () => {
    const r = await writerRig(); let calls = 0;
    expect(() => barrier(r, () => ++calls === 1)).toThrow(); expect(calls).toBe(2);
    expect(() => barrier(r)).not.toThrow();
  });
  it("a material failure stays fenced when the original secret is restored", async () => {
    const r = await writerRig(), b = barrier(r), original = r.secret(), path = join(r.home, BIND_SECRET_REL);
    writeFileSync(path, "third secret", { mode: 0o600 }); expect(() => b.capture()).toThrow();
    writeFileSync(path, original, { mode: 0o600 }); expect(b.current()).toBe(false); expect(() => barrier(r).assertCurrent()).not.toThrow();
  });
  it("an owner that disappears never revives this generation", async () => {
    const r = await writerRig(); let live = true; const b = barrier(r, () => live); live = false;
    expect(b.current()).toBe(false); live = true; expect(b.current()).toBe(false); expect(() => b.capture()).toThrow();
  });
  it.each(["floor", "head"])("a lost %s is refused, never read as a legacy mount", async kind => {
    const r = await writerRig(), b = barrier(r);
    if (kind === "floor") r.floor.raise(r.store.read().revision + 1); else r.db.exec("DELETE FROM hub_settings_head");
    expect(b.current()).toBe(false); expect(() => barrier(r)).toThrow();
  });
  it("policy changes invalidate the proof stamp without reviving or remounting the directory", async () => {
    const r = await writerRig(), b = barrier(r), before = b.capture();
    const row = r.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }, policy = JSON.parse(row.body);
    policy.revision++; r.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(policy));
    expect(b.current()).toBe(true); expect(b.capture().image).not.toBe(before.image); expect(b.capture().epoch).toBe(before.epoch);
  });
  it("refuses a valid sealed configuration paired with another Hub's valid decision store", async () => {
    const a = await writerRig(), b = await writerRig(), beforeA = a.counts(), beforeB = b.counts();
    expect(() => createHubDirectoryMountBarrier({ home: a.home, hub: a.readHub(), decision: b.decision, current: () => true })).toThrow();
    expect(a.counts()).toEqual(beforeA); expect(b.counts()).toEqual(beforeB); expect(() => barrier(a)).not.toThrow();
  });
  it("captures the configured Hub and owner callback before later input replacement", async () => {
    const r = await writerRig(), input = { home: r.home, hub: r.readHub(), decision: r.decision, current: () => true };
    const b = createHubDirectoryMountBarrier(input), captured = b.capture();
    input.hub.directory.url = "ldaps://foreign.example.test"; input.current = () => false;
    expect(() => b.capture()).not.toThrow(); expect(b.capture()).toEqual(captured); expect(b.current()).toBe(true);
  });
  it.each(["promise", "throw"])("a %s owner is refused without an admission or writer effect", async kind => {
    const r = await writerRig(), old = r.manifest(), counts = r.counts();
    const current = () => { if (kind === "throw") throw Error("owner gone"); return Promise.resolve(true) as unknown as boolean; };
    expect(() => barrier(r, current)).toThrow(); expect(r.manifest()).toBe(old); expect(r.counts()).toEqual(counts);
  });
  it("the shared projection preserves BOM/whitespace bytes and refuses foreign secret references", async () => {
    const r = await writerRig(), w = r.writer(), p = w.directory!.prepare(r.candidate(), r.actor, () => true);
    const saved = w.directory!.commit(p.ref, r.actor, () => true);
    expect(readHubDirectorySettingsImage(r.home, r.readHub())).toEqual(r.decision.operation(saved.receiptId).after);
    expect(r.decision.operation(saved.receiptId).after.bindSecretSha).toBe(createHash("sha256").update(r.secret()).digest("hex"));
    const raw = r.readHub(); raw.directory.bindPasswordRef = "foreign-ref";
    expect(() => readHubDirectorySettingsImage(r.home, raw)).toThrow();
  });
});


it.each(["own", "before-policy-change", "audit-change"])("a real proof-source image accepts only its own transition (%s)", async mode => {
  const r = await writerRig(), writer = r.writer(), mounted = createHubDirectoryMountBarrier({ home: r.home, hub: r.readHub(), decision: r.decision, current: () => true });
  const person = { key: admin, login: "admin", dn: "CN=Admin,DC=example,DC=test", groups: [] };
  const directory: HubDirectory = { realm: admin.realm, signIn: async () => ({ ok: true, person }),
    checkEligibility: async () => ({ eligible: true, person }), close: async () => {} };
  const proof = createHubDirectorySettingsProof({
    source() {
      const stamp = mounted.capture(), ownBasis = r.decision.proofBasis();
      return { directory, config: { ...r.readHub().directory, profile: "ad" as const }, bindPassword: r.secret(), administrator: admin,
        groups: (ownBasis?.policy ?? r.policy()).groups.map(g => ({ key: g.group, dn: g.dn })), ...stamp, current: mounted.current };
    },
    withDirectoryRead: async (_person, work) => work(), createDirectory: () => directory,
    writer: () => writer.directory!, probeTls: async () => "a".repeat(64), now: () => 1000,
  });
  const ctx = { actor: r.actor, current: () => true }, candidate = r.candidate();
  const prepared = await proof.prepare(candidate, ctx), counts = r.counts(), oldManifest = r.manifest(), oldSecret = r.secret();
  const changePolicy = () => {
    const row = r.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }, policy = JSON.parse(row.body);
    policy.revision++; r.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(policy));
  };
  if (mode === "before-policy-change") changePolicy();
  if (mode === "audit-change") r.auditOnce(changePolicy);
  const applying = proof.apply(prepared.ref, { confirmation: prepared.trust!.challenge, credentials: { login: "admin", password: "dummy-person-password" } }, ctx);
  if (mode === "own") {
    await expect(applying).resolves.toMatchObject({ directoryEpoch: 1 });
    expect(mounted.current()).toBe(false); expect(r.decision.inspect().directoryEpoch).toBe(1);
  } else {
    await expect(applying).rejects.toThrow(); expect(r.counts()).toEqual(counts); expect(readHubSessionEpoch(r.db)).toBe(0);
    expect(r.manifest()).toBe(oldManifest); expect(r.secret()).toBe(oldSecret);
    if (mode === "audit-change") expect(() => r.decision.inspect()).toThrow(/uncertain/);
  }
  expect(r.decision.proofBasis()).toBeNull(); proof.close();
});


it("the decision's basis is a copied, synchronous proof-only view and always closes", async () => {
  const r = rig(), input = r.request(); expect(r.decision.proofBasis()).toBeNull(); let calls = 0;
  r.decision.decide(input, () => {
    calls++; const view = r.decision.proofBasis()!;
    expect(view.expected).toEqual(input.expected); expect(view.policy.revision).toBe(1);
    view.policy.revision = 999; view.expected.directoryEpoch = 999;
    expect(r.decision.proofBasis()!.expected).toEqual(input.expected); expect(r.decision.proofBasis()!.policy.revision).toBe(1);
  });
  expect(calls).toBe(2); expect(r.decision.proofBasis()).toBeNull();
  const failed = rig(); expect(() => failed.decision.decide(failed.request(), () => { throw Error("lost proof"); })).toThrow();
  expect(failed.decision.proofBasis()).toBeNull();
  const asynchronous = rig(); let after: unknown = "not-run";
  expect(() => asynchronous.decision.decide(asynchronous.request(), (async () => { await Promise.resolve(); after = asynchronous.decision.proofBasis(); }) as any)).toThrow();
  await Promise.resolve(); expect(after).toBeNull(); expect(asynchronous.decision.proofBasis()).toBeNull();
});


it("a stale decision expectation never opens a proof view or invokes its callback", () => {
  const r = rig(), request = r.request(); let calls = 0;
  const row = r.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }, policy = JSON.parse(row.body);
  policy.revision++; r.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(policy));
  expect(() => r.decision.decide(request, () => { calls++; })).toThrow(); expect(calls).toBe(0); expect(r.decision.proofBasis()).toBeNull();
});

async function coldRecoveryRig() {
  const r = await writerRig(); r.migrations.push(HUB_INSTANCE_MIGRATION);
  applyHubMigrations(r.db, r.migrations); bindHubInstance(r.db, r.hubId, "new", 1000);
  const key = "hub/keys/recovery-content.key";
  writeFileSync(join(r.home, key), r.contentKey.toString("base64"), { mode: 0o600 });
  const options = { home: r.home, hubId: r.hubId, memberOrigin: r.readHub().memberOrigin, migrations: r.migrations,
    stateSet: { database: "hub/test.sqlite", floors: ["hub/floors/test"], keys: [key] } };
  return { r, options };
}

describe("cold directory recovery (internal, no production caller)", () => {
  it.each(["staged", "directory-decision", "directory-secret", "manifest", "config"])("recovers %s after the original DB closes, through the same writer", async point => {
    const { r, options } = await coldRecoveryRig(), w = r.writer(), oldHub = r.readHub();
    const draft = w.directory!.prepare(r.candidate(), r.actor, () => true); r.crash(point);
    expect(() => w.directory!.commit(draft.ref, r.actor, () => true)).toThrow();
    const epoch = r.decision.inspect().directoryEpoch; r.db.close();
    let escaped: ReturnType<typeof createHubDirectorySettingsDecision> | undefined;
    withHubDirectoryRecovery(options, decision => {
      escaped = decision;
      r.writer({ directoryDecision: () => decision }).recover();
      expect(decision.inspect().directoryEpoch).toBe(epoch);
      expect(() => createHubDirectoryMountBarrier({ home: r.home, hub: r.readHub(), decision, current: () => true })).not.toThrow();
    });
    expect(() => escaped!.inspect()).toThrow(); expect(r.writer().pending()).toBe(false);
    if (point === "staged") expect(r.readHub()).toEqual(oldHub);
    else expect(r.readHub().directory.url).toBe("ldaps://new.example.test");
    expect(() => r.verifies()).not.toThrow();
  });
  it.each(["new-set", "database", "floor", "key", "key-bytes", "identity", "binding", "registry", "unknown-version", "old-version", "new-version", "head", "epoch", "raised-floor", "notices", "operations", "targets"])("refuses %s before callback and never initializes missing authority", async fault => {
    const { r, options } = await coldRecoveryRig();
    if (fault === "identity") {
      options.hubId = randomUUID();
      r.db.prepare("UPDATE hub_instance SET hub_id=?").run(options.hubId);
      r.db.prepare("UPDATE hub_group_policy SET hub_id=?").run(options.hubId);
    }
    if (fault === "key-bytes") writeFileSync(join(r.home, options.stateSet.keys[0]!), "short", { mode: 0o600 });
    if (fault === "binding") r.db.prepare("UPDATE hub_instance SET hub_id=?").run(randomUUID());
    if (fault === "registry") r.db.exec("DELETE FROM hub_schema WHERE component='s5-directory-settings'");
    if (fault === "unknown-version") r.db.exec("INSERT INTO hub_schema VALUES('future-component',1)");
    if (fault === "old-version") r.db.exec("UPDATE hub_schema SET version=0 WHERE component='s5-directory-settings'");
    if (fault === "new-version") r.db.exec("UPDATE hub_schema SET version=2 WHERE component='s5-directory-settings'");
    if (fault === "head") r.db.exec("DELETE FROM hub_settings_head");
    if (fault === "epoch") r.db.exec("DELETE FROM hub_directory_epoch");
    if (fault === "raised-floor") r.floor.raise(1);
    if (fault === "notices") r.db.exec("DROP TABLE hub_settings_security_notices");
    if (fault === "operations") r.db.exec("DROP TABLE hub_settings_operations");
    if (fault === "targets") r.db.exec("DROP TABLE hub_settings_security_targets");
    r.db.close();
    const paths = [options.stateSet.database, ...options.stateSet.floors, ...options.stateSet.keys];
    const absent = fault === "new-set" ? paths : fault === "database" ? [paths[0]!] : fault === "floor" ? [paths[1]!] : fault === "key" ? [paths[2]!] : [];
    for (const rel of absent) rmSync(join(r.home, rel));
    let calls = 0;
    const recover = () => withHubDirectoryRecovery(options, () => { calls++; });
    const codes: Record<string, string> = { "new-version": "hub-state-newer", "unknown-version": "hub-state-newer",
      registry: "hub-state-mismatch", "old-version": "hub-state-mismatch" };
    if (codes[fault]) expect(recover).toThrowError(expect.objectContaining({ code: codes[fault] }));
    else expect(recover).toThrow();
    expect(calls).toBe(0);
    for (const rel of absent) expect(existsSync(join(r.home, rel))).toBe(false);
  });
  it("closes the physical DB on callback errors and rejects async escape", async () => {
    const { r, options } = await coldRecoveryRig(); r.db.close();
    let escaped: ReturnType<typeof createHubDirectorySettingsDecision> | undefined;
    expect(() => withHubDirectoryRecovery(options, d => { escaped = d; throw Error("work failed"); })).toThrow("work failed");
    expect(() => escaped!.inspect()).toThrow();
    let late: unknown;
    expect(() => withHubDirectoryRecovery(options, async d => { await Promise.resolve(); try { d.inspect(); } catch (e) { late = e; } })).toThrow(/synchronous/);
    await Promise.resolve(); expect(late).toBeInstanceOf(Error);
    expect(withHubDirectoryRecovery(options, d => d.inspect().directoryEpoch)).toBe(0);
  });
});
