/** Actual role/session/transport/SQLite authority; no mounted source or live directory. */
import { describe, expect, it } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { hubTxDatabase } from "../src/hub/db.js";
import { randomUUID } from "node:crypto";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION, type HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";

function held() {
  let enter!: () => void, release!: () => void;
  return { entered: new Promise<void>(r => { enter = r; }), wait: new Promise<void>(r => { release = r; }), enter: () => enter(), release: () => release() };
}
async function world(decisions = false) {
  const w = await roleAuthorityWorld({ cutover: decisions }); let clockHook = () => {}, mounted = true;
  const clock = decisions ? createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g1",
    transport: w.store, current: w.options.current, now: w.options.now }) : undefined;
  const authority = createHubManagementAuthority({ ...w.options,
    assertAuthorizationTime() { (clock?.assertAuthorizationTime ?? w.options.assertAuthorizationTime)(); clockHook(); },
    ...(clock ? { directoryDecision: { db: w.db, hubId: w.hubId, assertAuthorizationTime(proof) { clock.assertDirectoryDecision(proof); clockHook(); } } } : {}) });
  const deps = { ...w.core.deps, management: authority }, core = new HubCore(deps, hubTxDatabase, () => mounted);
  return { ...w, authority, deps, core, mount(value: boolean) { mounted = value; }, onClock(hook: () => void) { clockHook = hook; } };
}
type World = Awaited<ReturnType<typeof world>>;
const changes = ["provider", "prepare", "require", "directory", "config", "root", "hub", "uow", "atomic", "store", "mode", "clock", "mount", "request", "session-reader", "identity-reader"] as const;
function change(w: World, mode: typeof changes[number]): () => void {
  const d = w.deps;
  if (mode === "provider") { const old = d.management; d.management = { ...old }; return () => { d.management = old; }; }
  if (mode === "prepare") { const old = d.management.prepareDirectory; d.management.prepareDirectory = ctx => old(ctx); return () => { d.management.prepareDirectory = old; }; }
  if (mode === "require") { const old = d.management.require; d.management.require = (...args) => old(...args); return () => { d.management.require = old; }; }
  if (mode === "directory") { const old = d.directory; d.directory = { ...old }; return () => { d.directory = old; }; }
  if (mode === "config") { const old = d.config; d.config = { ...old }; return () => { d.config = old; }; }
  if (mode === "root") { const c = d.config as { administrator: typeof w.root }, old = c.administrator; c.administrator = w.other; return () => { c.administrator = old; }; }
  if (mode === "hub") { const c = d.config as { hubId: string }, old = c.hubId; c.hubId = randomUUID(); return () => { c.hubId = old; }; }
  if (mode === "uow") { const old = d.uow; d.uow = { ...old }; return () => { d.uow = old; }; }
  if (mode === "atomic") { const old = d.uow.atomic; d.uow.atomic = work => old(work); return () => { d.uow.atomic = old; }; }
  if (mode === "store") { const old = d.store; d.store = Object.create(old) as typeof old; return () => { d.store = old; }; }
  if (mode === "mode") { const old = d.current; d.current = () => old(); return () => { d.current = old; }; }
  if (mode === "clock") { const old = d.now; d.now = () => old!(); return () => { d.now = old; }; }
  if (mode === "request") { const c = w.ctx.ctx as { requestId: string }, old = c.requestId; c.requestId = randomUUID(); return () => { c.requestId = old; }; }
  if (mode === "session-reader") { const c = w.ctx.ctx, old = c.current; c.current = () => old(); return () => { c.current = old; }; }
  if (mode === "identity-reader") { const c = w.ctx.ctx, old = c.isIdentityCurrent; c.isIdentityCurrent = (...args) => old!(...args); return () => { c.isIdentityCurrent = old; }; }
  w.mount(false); return () => w.mount(true);
}
describe("S129 directory preparation belongs to its actual Core", () => {
  it("retains a valid slow operation and publishes a fresh proof under the same Core", async () => {
    const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx);
    w.time(6000); expect(() => p.assertCurrent()).not.toThrow();
    const permit = await p.authorize(); expect(permit.actor.person).toEqual(w.admin);
    expect(() => permit.assertCurrent()).not.toThrow();
  });
  it("refuses an original preparation after the Core provider is replaced", async () => {
    const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx);
    w.deps.management = { ...w.authority };
    expect(() => p.assertCurrent()).toThrow();
  });
  it("fences the actual fresh proof after the Core provider is replaced", async () => {
    const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx), permit = await p.authorize();
    w.deps.management = { ...w.authority };
    expect(() => permit.assertCurrent()).toThrow();
  });
  it("does not fabricate a preparation without a management provider", async () => {
    const w = await world(), { management: _management, ...bare } = w.deps, core = new HubCore(bare, hubTxDatabase);
    await expect(core.directoryPreparation(w.ctx.ctx)).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("S129 Core owner retirement and preparation consumption", () => {
  for (const phase of ["preparation", "permit"] as const) {
    it.each(changes)(`permanently refuses ${phase} after an observed %s owner change`, async mode => {
      const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx), proof = phase === "permit" ? await p.authorize() : p;
      const restore = change(w, mode);
      try { expect(() => proof.assertCurrent()).toThrow(); } finally { restore(); }
      expect(() => proof.assertCurrent()).toThrow();
    });
  }
  it("consumes preparation without revoking the acquired permit, including explicit retire and a repeated exchange", async () => {
    const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx); w.time(90000); w.elapsed(90000);
    const permit = await p.authorize(); p.retire();
    expect(() => p.assertCurrent()).toThrow(); await expect(p.authorize()).rejects.toThrow();
    expect(() => permit.assertCurrent()).not.toThrow();
    expect(permit.assertCurrent()).toBe(90100);
    w.time(5000); expect(() => permit.assertCurrent()).toThrow();
  });
  it("retains the physical fresh read until settlement and refuses a second flight without cancelling the first", async () => {
    const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx), gate = held();
    w.eligible.mockImplementationOnce(async who => { gate.enter(); await gate.wait; return { eligible: true, person: w.person(who) }; });
    const flight = p.authorize().then(value => ({ value }), error => ({ error })); await gate.entered;
    try { await expect(p.authorize()).rejects.toMatchObject({ code: "backpressure" }); }
    finally { gate.release(); }
    const out = await flight; expect(out).toHaveProperty("value");
    if (!("value" in out)) throw Error("fixture flight"); expect(() => out.value.assertCurrent()).not.toThrow();
  });
  it.each(["owner", "cancel", "session"] as const)("refuses %s loss during a held fresh physical read", async mode => {
    const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx), gate = held();
    w.eligible.mockImplementationOnce(async who => { gate.enter(); await gate.wait; return { eligible: true, person: w.person(who) }; });
    const flight = p.authorize().then(value => ({ value }), error => ({ error })); await gate.entered;
    if (mode === "owner") change(w, "provider");
    if (mode === "cancel") p.retire();
    if (mode === "session") w.sessions.signOut(w.ctx.token);
    gate.release(); const out = await flight; expect(out).toHaveProperty("error");
    if (!("error" in out)) throw Error("fixture refusal");
    expect(out.error).toMatchObject({ code: mode === "session" ? "revoked" : "unavailable" });
  });
  it("refuses owner replacement during the initial authority read", async () => {
    const w = await world(), gate = held();
    w.eligible.mockImplementationOnce(async who => { gate.enter(); await gate.wait; return { eligible: true, person: w.person(who) }; });
    const flight = w.core.directoryPreparation(w.ctx.ctx).then(value => ({ value }), error => ({ error })); await gate.entered;
    change(w, "provider"); gate.release(); expect(await flight).toHaveProperty("error");
  });
  it("checks Core ownership again after the final permit's clock callback", async () => {
    const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx), permit = await p.authorize();
    w.onClock(() => { w.deps.config = { ...w.deps.config }; });
    expect(() => permit.assertCurrent()).toThrow();
  });
  it("refuses a provider without the optional preparation adapter and preserves legacy management", async () => {
    const w = await world(); w.core.deps.management = { require: w.authority.require };
    await expect(w.core.directoryPreparation(w.ctx.ctx)).rejects.toMatchObject({ code: "unavailable" });
    const actor = (await w.core.management(w.ctx.ctx, "hub.admin")).actor;
    expect(actor.kind).toBe("directory"); if (actor.kind !== "directory") throw Error("fixture admin"); expect(actor.person).toEqual(w.admin);
  });
});
async function decisionWorld() {
  const w = await world(true); HUB_DIRECTORY_SETTINGS_MIGRATION.up(w.db);
  const decision = createHubDirectorySettingsDecision({ db: w.db, transport: w.store, hubId: w.hubId, roleProofs: true });
  const actor = await w.ctx.ctx.current(); if (actor.kind !== "directory") throw Error("fixture actor");
  const image = (v: string) => ({ configDigest: v.repeat(64), configSha: v.repeat(64), directorySha: v.repeat(64), manifestSha: v.repeat(64), bindSecretSha: v.repeat(64) });
  const input: HubDirectoryDecisionRequest = { id: randomUUID(), expected: decision.inspect(), before: image("a"), after: image("b"), generation: "g2", receiptSha: "c".repeat(64),
    actor: { kind: "hub-administrator", person: actor.person, sessionId: actor.sessionId, requestId: w.ctx.ctx.requestId }, at: 100,
    changes: ["search"], recipients: [{ kind: "host", sink: "owner" }] };
  return { ...w, decision, input };
}
describe("S129 Core preparation's fresh explicit SQL proof", () => {
  it("retains the actual decision frame and trusted scalar through its own canonical rebind", async () => {
    const w = await decisionWorld(), p = await w.core.directoryPreparation(w.ctx.ctx), permit = await p.authorize(); p.retire(); let calls = 0;
    expect(() => w.decision.decide(w.input, () => { calls++; return permit.assertDirectoryDecision!(w.decision.administrationProof()!) as number; })).not.toThrow();
    expect(calls).toBe(2); expect(w.decision.inspect().directoryEpoch).toBe(1);
    expect(() => permit.assertCurrent()).toThrow();
  });
  it("rolls back the real SQL transition when Core ownership changes inside the final proof", async () => {
    const w = await decisionWorld(), p = await w.core.directoryPreparation(w.ctx.ctx), permit = await p.authorize(); let calls = 0;
    w.onClock(() => { if (++calls === 2) change(w, "provider"); });
    expect(() => w.decision.decide(w.input, () => permit.assertDirectoryDecision!(w.decision.administrationProof()!) as number)).toThrow();
    expect(calls).toBe(2); expect(w.db.prepare("SELECT id FROM hub_settings_operations").all()).toEqual([]);
    expect(w.db.prepare("SELECT epoch FROM hub_directory_epoch").get()).toEqual({ epoch: 0 });
    expect(w.db.prepare("SELECT body FROM hub_group_policy").get()).toEqual({ body: JSON.stringify(w.policy) });
    // The independent authorization floor advances before final proof, so a rolled-back DB must stay held.
    expect(() => w.store.read()).toThrow();
  });
});
