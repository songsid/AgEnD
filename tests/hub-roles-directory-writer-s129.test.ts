/** Actual private seal/files + SQLite/session/role decision; fictional directory, no mounted route. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { HUB_DIRECTORY_RECOVERY_MIGRATION } from "../src/hub/settings-directory-recovery-intent.js";
import { BIND_PASSWORD_REF, BIND_SECRET_REL } from "../src/hub/init/layout.js";
import { ensurePrivateDirectory } from "../src/hub/private-files.js";
import { atomicWriteFileSync } from "../src/atomic-write.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { bindHubDirectoryAdministration, type HubDirectoryAdministration } from "../src/hub/roles/directory-authority.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION, type HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";
import { createHubSettingsWriter, readHubDirectorySettingsImage, SETTINGS_JOURNAL, type HubDirectorySettingsCandidate, type HubDirectorySettingsWriter, type HubSettingsWriterDeps } from "../src/hub/settings-commit.js";

type Actor = HubDirectoryDecisionRequest["actor"];
type AdmissionWriter = {
  prepare(candidate: HubDirectorySettingsCandidate, actor: Actor, current: () => boolean, administration?: HubDirectoryAdministration): ReturnType<HubDirectorySettingsWriter["prepare"]>;
  commit(ref: string, actor: Actor, current: () => boolean, rotation?: Parameters<HubDirectorySettingsWriter["commit"]>[3], deadline?: number,
    administration?: HubDirectoryAdministration): ReturnType<HubDirectorySettingsWriter["commit"]>;
};
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function world(wrapped = false) {
  const home = mkdtempSync(join(tmpdir(), "hub-role-directory-writer-")); homes.push(home); chmodSync(home, 0o700);
  const memberOrigin = "https://member.example.test", identity = await provisionHubIdentity({ home, memberOrigin });
  const w = await roleAuthorityWorld({ hubId: identity.hubId, cutover: true }); HUB_DIRECTORY_SETTINGS_MIGRATION.up(w.db); HUB_DIRECTORY_RECOVERY_MIGRATION.up(w.db);
  const decision = createHubDirectorySettingsDecision({ db: w.db, transport: w.store, hubId: w.hubId, roleProofs: true });
  let mountedDecision = decision, frameHook: (() => void) | undefined;
  const config = join(home, "hub/owned-config.json"), manifest = join(home, "hub/init-manifest.json");
  const hub = { enabled: true, hubId: w.hubId, name: "Owned fixture", memberOrigin, webOrigin: "https://hub.example.test",
    webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 },
    administrator: w.root, directory: { realm: "corp", profile: "ad" as const, url: "ldaps://old.example.test", baseDn: "DC=example,DC=test",
      bindDn: "CN=owned-service", bindPasswordRef: BIND_PASSWORD_REF }, retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated" };
  ensurePrivateDirectory(home, "hub/secrets"); writeFileSync(join(home, BIND_SECRET_REL), "owned old bind", { mode: 0o600 });
  writeFileSync(config, JSON.stringify(hub), { mode: 0o600 });
  const planDigest = hubPlanDigest(hub), confirmationId = "c".repeat(32), committedAt = "2026-11-08T00:00:00.000Z";
  writeFileSync(manifest, JSON.stringify({ v: 1, hubId: w.hubId, planDigest, confirmationId, committedAt,
    signature: sealHubInitialization({ home, planDigest, confirmationId, committedAt }) }), { mode: 0o600 });
  const readHub = () => JSON.parse(readFileSync(config, "utf8")) as typeof hub;
  const clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g1", transport: w.store,
    current: w.options.current, now: w.options.now });
  const authority = createHubManagementAuthority({ ...w.options, assertAuthorizationTime: clock.assertAuthorizationTime,
    directoryDecision: { db: w.db, hubId: w.hubId, assertAuthorizationTime(proof) { clock.assertDirectoryDecision(proof); frameHook?.(); } } });
  const found = await w.ctx.ctx.current(); if (found.kind !== "directory") throw Error("fixture actor");
  const actor = { kind: "hub-administrator" as const, person: found.person, sessionId: found.sessionId, requestId: w.ctx.ctx.requestId };
  const source = () => {
    const expected = mountedDecision.proofBasis()?.expected ?? mountedDecision.inspect();
    return { directory: w.directory, administrator: w.root, epoch: expected.directoryEpoch, decisionProof: mountedDecision.administrationProof,
      image: createHash("sha256").update(JSON.stringify([w.hubId, expected, readHubDirectorySettingsImage(home, readHub())])).digest("hex") };
  };
  w.core.deps.management = authority;
  const permit = wrapped ? await w.core.management(w.ctx.ctx, "hub.admin") : await authority.require(w.ctx.ctx, "hub.admin");
  if (!("permission" in permit)) throw Error("fixture actual permit");
  const administration = bindHubDirectoryAdministration(permit, actor, source());
  let stepHook: ((step: string) => void) | undefined;
  const provider = () => ({ decision: mountedDecision, source: source() });
  const deps = { home, readHub, now: w.options.now, directoryDecision: () => mountedDecision, directoryAdministration: provider,
    saveHub(patches) { const next = readHub(); for (const p of patches) { if (p.remove) delete (next as Record<string, unknown>)[p.path[1]!]; else (next as Record<string, unknown>)[p.path[1]!] = p.value; }
      atomicWriteFileSync(config, JSON.stringify(next), { mode: 0o600 }); }, step: (name: string) => stepHook?.(name),
  } satisfies HubSettingsWriterDeps & { directoryAdministration: typeof provider };
  const candidate = () => ({ directory: { ...readHub().directory, baseDn: "OU=Next,DC=example,DC=test" }, changes: ["search" as const], recipients: [{ kind: "host" as const, sink: "owner" }] });
  let latestOptions: typeof deps;
  const writer = (over: Partial<typeof deps> = {}) => { latestOptions = { ...deps, ...over }; return createHubSettingsWriter(latestOptions); };
  const admission = (value: ReturnType<typeof writer>) => value.directory! as AdmissionWriter;
  const save = (value = writer(), witness: HubDirectoryAdministration | undefined = administration, who: Actor = actor, current = () => true) => {
    const d = admission(value), draft = d.prepare(candidate(), who, current, witness); return d.commit(draft.ref, who, current, undefined, undefined, witness);
  };
  return { ...w, authority, clock, home, readHub, manifest: () => readFileSync(manifest, "utf8"), decision, source, permit, administration, actor, deps, candidate, writer, admission, save,
    writerOptions: () => latestOptions, mount: (next: typeof decision) => { mountedDecision = next; }, onFrame: (fn: () => void) => { frameHook = fn; },
    step(fn?: (name: string) => void) { stepHook = fn; }, verifies: () => verifyHubInitialization({ home, hubId: w.hubId, memberOrigin, planDigest: hubPlanDigest(readHub()) }) };
}

describe("S129 sealed directory writer admission", () => {
  it("uses the actual auxiliary administrator witness without replacing the configured root", async () => {
    const w = await world(), old = w.readHub(); let result: ReturnType<typeof w.save> | undefined;
    expect(() => { result = w.save(); }).not.toThrow();
    expect(w.readHub()).toEqual({ ...old, directory: w.candidate().directory });
    expect(w.verifies().planDigest).toBe(hubPlanDigest(w.readHub()));
    expect(w.decision.operation(result!.receiptId).actor).toEqual(w.actor);
    expect(w.readHub().administrator).toEqual(w.root);
  });
  it("refuses an auxiliary admin with only a successful current callback", async () => {
    const w = await world(), d = w.admission(w.writer());
    expect(() => d.prepare(w.candidate(), w.actor, () => true)).toThrow();
    expect(w.decision.inspect().operationId).toBeNull();
  });
  it("retains the root and D3 writer contracts without composing role admission", async () => {
    for (const mode of ["root", "host"] as const) {
      const w = await world(), writer = w.writer({ directoryAdministration: undefined as never });
      const actor: Actor = mode === "root" ? { ...w.actor, person: w.root } : { kind: "host-owner", sessionId: "owned-host", requestId: randomUUID() };
      const d = w.admission(writer);
      expect(() => { const draft = d.prepare(w.candidate(), actor, () => true); d.commit(draft.ref, actor, () => true); }).not.toThrow();
      expect(w.verifies()).toBeDefined();
    }
  });
});

describe("S129 trusted writer source and final proof", () => {
  it("carries the final numeric clock sample through HubCore's retained wrapper", async () => {
    const w = await world(true); expect(() => w.save()).not.toThrow();
  });
  it.each(["missing-provider", "forged", "session", "request", "host", "not-current"] as const)("refuses %s before a setting changes", async mode => {
    const w = await world(), before = w.readHub(), actor: Actor = structuredClone(w.actor);
    if (mode === "session") actor.sessionId = randomUUID();
    if (mode === "request") actor.requestId = randomUUID();
    const who: Actor = mode === "host" ? { kind: "host-owner", sessionId: "owned-host", requestId: randomUUID() } : actor;
    const writer = w.writer(mode === "missing-provider" ? { directoryAdministration: undefined as never } : {});
    const witness = mode === "forged" ? { directoryAdministration: true as const } : w.administration;
    expect(() => w.save(writer, witness, who, () => mode !== "not-current")).toThrow();
    expect(w.readHub()).toEqual(before); expect(w.decision.inspect().operationId).toBeNull();
  });
  it("binds the witness source to the sealed configured root, not just its realm", async () => {
    const w = await world(), wrong = { ...w.source(), administrator: w.other };
    const witness = bindHubDirectoryAdministration(w.permit, w.actor, wrong);
    const writer = w.writer({ directoryAdministration: () => ({ decision: w.decision, source: wrong }) });
    expect(() => w.save(writer, witness)).toThrow(); expect(w.decision.inspect().operationId).toBeNull();
  });
  it.each(["empty", "async", "foreign-owner"] as const)("refuses a %s trusted source packet", async mode => {
    const w = await world(), other = mode === "foreign-owner" ? await world() : undefined;
    const writer = w.writer({ directoryAdministration: (() => mode === "empty" ? null : mode === "async"
      ? Promise.resolve({ decision: w.decision, source: w.source() }) : { decision: other!.decision, source: w.source() }) as never });
    expect(() => w.save(writer)).toThrow(); expect(w.decision.inspect().operationId).toBeNull();
  });
  it.each(["provider", "reader"] as const)("refuses replacement of the %s function and consumes the preparation", async mode => {
    const w = await world(), writer = w.writer(), d = w.admission(writer), p = d.prepare(w.candidate(), w.actor, () => true, w.administration), options = w.writerOptions();
    const provider = options.directoryAdministration, reader = options.directoryDecision;
    if (mode === "provider") options.directoryAdministration = () => provider();
    else options.directoryDecision = () => reader();
    expect(() => d.commit(p.ref, w.actor, () => true, undefined, undefined, w.administration)).toThrow();
    options.directoryAdministration = provider; options.directoryDecision = reader;
    expect(() => d.commit(p.ref, w.actor, () => true, undefined, undefined, w.administration)).toThrow();
    expect(w.decision.inspect().operationId).toBeNull();
  });
  it("refuses a remounted decision even with a fresh current witness and unchanged SQL", async () => {
    const w = await world(), writer = w.writer(), d = w.admission(writer), p = d.prepare(w.candidate(), w.actor, () => true, w.administration);
    w.mount(createHubDirectorySettingsDecision({ db: w.db, transport: w.store, hubId: w.hubId, roleProofs: true }));
    const current = bindHubDirectoryAdministration(await w.authority.require(w.ctx.ctx, "hub.admin"), w.actor, w.source());
    expect(() => d.commit(p.ref, w.actor, () => true, undefined, undefined, current)).toThrow();
    expect(w.decision.inspect().operationId).toBeNull();
  });
  it("refuses a role provider wired to a decision without callback-local frames", async () => {
    const w = await world(); w.mount(createHubDirectorySettingsDecision({ db: w.db, transport: w.store, hubId: w.hubId }));
    const current = bindHubDirectoryAdministration(w.permit, w.actor, w.source());
    expect(() => w.save(w.writer(), current)).toThrow(); expect(w.decision.inspect().operationId).toBeNull();
  });
  it("does not downgrade a root's witness-required preparation to the bare legacy path", async () => {
    const w = await world(), browser = await w.browser(w.root), found = await browser.ctx.current();
    if (found.kind !== "directory") throw Error("fixture root");
    const actor = { kind: "hub-administrator" as const, person: found.person, sessionId: found.sessionId, requestId: browser.ctx.requestId };
    const witness = bindHubDirectoryAdministration(await w.authority.require(browser.ctx, "hub.admin"), actor, w.source());
    const d = w.admission(w.writer()), p = d.prepare(w.candidate(), actor, () => true, witness);
    expect(() => d.commit(p.ref, actor, () => true)).toThrow(); expect(w.decision.inspect().operationId).toBeNull();
  });
  it("refuses a provider identity swap from inside the actual frame proof", async () => {
    const w = await world(), writer = w.writer(), options = w.writerOptions(), original = options.directoryAdministration;
    const permit = { ...w.permit, assertDirectoryDecision(proof: Parameters<NonNullable<typeof w.permit.assertDirectoryDecision>>[0]) {
      const at = w.permit.assertDirectoryDecision!(proof); options.directoryAdministration = () => original(); return at;
    } };
    const witness = bindHubDirectoryAdministration(permit, w.actor, w.source());
    expect(() => w.save(writer, witness)).toThrow(); expect(w.decision.inspect().operationId).toBeNull();
  });
  it.each([undefined, NaN, Infinity, 0, 99] as const)("refuses an unusable final proof sample (%s)", async sample => {
    const w = await world(), permit = { ...w.permit, assertDirectoryDecision(proof: Parameters<NonNullable<typeof w.permit.assertDirectoryDecision>>[0]) {
      w.permit.assertDirectoryDecision!(proof); return sample;
    } };
    const witness = bindHubDirectoryAdministration(permit, w.actor, w.source());
    expect(() => w.save(w.writer(), witness)).toThrow(); expect(w.decision.inspect().operationId).toBeNull();
  });
  it("rechecks authority after the last writer-clock callback revokes the actual browser", async () => {
    const w = await world(); let samples = 0;
    const writer = w.writer({ now() {
      const at = w.options.now(), row = w.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string };
      if (w.decision.proofBasis() && JSON.parse(row.body).generation !== "g1" && ++samples === 2) w.sessions.signOut(w.ctx.token);
      return at;
    } });
    expect(() => w.save(writer)).toThrow(); expect(samples).toBe(2);
    expect(w.db.prepare("SELECT id FROM hub_settings_operations").all()).toEqual([]);
    // The external floor may have advanced; no post-rollback transport-health claim.
  });
  it("checks the recovery deadline against the proof's own final clock sample", async () => {
    const w = await world(), d = w.admission(w.writer()), p = d.prepare(w.candidate(), w.actor, () => true, w.administration); let proofs = 0;
    w.onFrame(() => {
      const row = w.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string };
      if (JSON.parse(row.body).generation !== "g1" && ++proofs === 2) w.time(60);
    });
    expect(() => d.commit(p.ref, w.actor, () => true, undefined, 150, w.administration)).toThrow(); expect(proofs).toBe(2);
    expect(w.db.prepare("SELECT id FROM hub_settings_operations").all()).toEqual([]);
  });
  it("refuses a proof clock behind the final writer sample even while both stay within the deadline", async () => {
    const w = await world(); let ahead = false;
    const d = w.admission(w.writer({ now: () => w.options.now() + (ahead ? 1 : 0) }));
    const p = d.prepare(w.candidate(), w.actor, () => true, w.administration);
    ahead = true; // Separate monotonic clocks: writer101, actual role clock100, preparation100.
    expect(() => d.commit(p.ref, w.actor, () => true, undefined, undefined, w.administration)).toThrow();
    expect(w.db.prepare("SELECT id FROM hub_settings_operations").all()).toEqual([]);
  });
  it("commits under the same recovery deadline while the final role proof remains current", async () => {
    const w = await world(), d = w.admission(w.writer()), p = d.prepare(w.candidate(), w.actor, () => true, w.administration);
    const result = d.commit(p.ref, w.actor, () => true, undefined, 150, w.administration);
    expect(w.decision.operation(result.receiptId)).toMatchObject({ actor: w.actor, recovery: { v: 1, expiresAt: 150 } });
    expect(w.verifies()).toBeDefined();
  });
  it.each(["staged", "directory-decision", "directory-secret", "manifest", "config", "done"] as const)(
    "recovers the modeled %s interruption without reusing an expired administrator permit", async point => {
      const w = await world(), old = w.readHub(), writer = w.writer(); let crashed = false;
      w.step(name => { if (!crashed && name === point) { crashed = true; throw Error("owned modeled interruption"); } });
      expect(() => w.save(writer)).toThrow("owned modeled interruption"); expect(crashed).toBe(true);
      w.step(); w.time(6000);
      expect(() => w.permit.assertCurrent()).toThrow();
      const recovery = w.writer({ directoryAdministration: undefined as never });
      expect(() => recovery.recover()).not.toThrow(); expect(() => recovery.recover()).not.toThrow();
      expect(recovery.pending()).toBe(false);
      const ops = w.db.prepare("SELECT body FROM hub_settings_operations").all() as { body: string }[];
      expect(ops.length).toBe(point === "staged" ? 0 : 1);
      expect(w.readHub()).toEqual(point === "staged" ? old : { ...old, directory: w.candidate().directory });
      if (ops.length) expect(JSON.parse(ops[0]!.body).actor).toEqual(w.actor);
      expect(w.verifies()).toBeDefined();
      const expected = { ...w.policy, ...(point === "staged" ? {} : { generation: JSON.parse(ops[0]!.body).generation, revision: w.policy.revision + 1 }) };
      expect(JSON.parse((w.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body)).toEqual(expected);
      expect(() => readFileSync(join(w.home, SETTINGS_JOURNAL))).toThrow();
    });
});
