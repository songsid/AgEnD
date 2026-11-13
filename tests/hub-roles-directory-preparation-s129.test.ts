/** Actual role policy, sessions, transport and physical admission; fictional directory. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { assertHubDirectoryAdministration, assertHubDirectoryPreparation, authorizeHubDirectoryPreparation, bindHubDirectoryAdministration,
  bindHubDirectoryPreparation, type HubDirectoryPreparation } from "../src/hub/roles/directory-authority.js";
import { BIND_PASSWORD_REF } from "../src/hub/init/layout.js";
import { createHubDirectorySettingsProof, type HubDirectoryProofContext, type HubDirectoryProofSource } from "../src/hub/settings-directory-proof.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import type { HubDirectorySettingsWriter } from "../src/hub/settings-commit.js";
function held() { let enter!: () => void, release!: () => void; return { entered: new Promise<void>(r => { enter = r; }), wait: new Promise<void>(r => { release = r; }), enter: () => enter(), release: () => release() }; }

describe("S129 long directory preparation", () => {
  it("retains operation identity beyond the old five-second permit and acquires a fresh effect proof", async () => {
    const w = await roleAuthorityWorld(), preparation = await w.authority.prepareDirectory(w.ctx.ctx);
    w.time(6000); w.elapsed(6000);
    expect(() => preparation.assertCurrent()).not.toThrow();
    const before = w.eligible.mock.calls.length, permit = await preparation.authorize();
    expect(w.eligible.mock.calls.length).toBeGreaterThan(before);
    expect(permit.actor.person).toEqual(w.admin); expect(permit.permission).toBe("hub.admin");
    expect(permit.expiresAt).toBe(11100); expect(() => permit.assertCurrent()).not.toThrow();
  });
  it("keeps ordinary effect proofs at five seconds", async () => {
    const w = await roleAuthorityWorld(), permit = await w.authority.require(w.ctx.ctx, "hub.admin");
    w.time(5000); expect(() => permit.assertCurrent()).toThrow();
  });
  it("does not grant directory preparation to an ordinary signed-in person", async () => {
    const w = await roleAuthorityWorld(), person = await w.browser(w.other);
    await expect(w.authority.prepareDirectory(person.ctx)).rejects.toMatchObject({ code: "denied" });
  });
  it("retains a long preparation past the ordinary twenty-second acquisition budget", async () => {
    const w = await roleAuthorityWorld(), p = await w.authority.prepareDirectory(w.ctx.ctx);
    w.time(90000); w.elapsed(90000); expect(() => p.assertCurrent()).not.toThrow();
    const permit = await p.authorize(); expect(permit.expiresAt).toBe(95100);
    expect(() => p.assertCurrent()).toThrow(); await expect(p.authorize()).rejects.toThrow();
    w.time(5000); expect(() => permit.assertCurrent()).toThrow();
  });
  it.each(["wall", "elapsed"] as const)("bounds preparation at five minutes of %s time", async mode => {
    const w = await roleAuthorityWorld(), p = await w.authority.prepareDirectory(w.ctx.ctx);
    if (mode === "wall") w.time(300000); else w.elapsed(300000);
    expect(() => p.assertCurrent()).toThrow(); await expect(p.authorize()).rejects.toThrow();
  });
  it.each(["role", "version", "session", "person", "provider", "directory", "current", "identity", "request", "closed", "cancel", "clock"] as const)(
    "permanently retires preparation after observed %s change", async mode => {
      const w = await roleAuthorityWorld(), ctx = w.ctx.ctx, p = await w.authority.prepareDirectory(ctx);
      const old = { require: w.authority.require, check: w.directory.checkEligibility, current: ctx.current, identity: ctx.isIdentityCurrent, requestId: ctx.requestId };
      if (mode === "role") w.save({ ...w.policy, revision: 2, assignments: [] });
      if (mode === "version") w.advance();
      if (mode === "session") w.sessions.signOut(w.ctx.token);
      if (mode === "person") { await w.browser(w.other); w.db.prepare("UPDATE hub_sessions SET person=? WHERE id=?").run(`${w.other.realm}/${w.other.objectId}`, p.actor.sessionId); }
      if (mode === "provider") w.authority.require = (...args) => old.require(...args);
      if (mode === "directory") w.directory.checkEligibility = (...args) => old.check(...args);
      if (mode === "current") ctx.current = (...args) => old.current(...args);
      if (mode === "identity") ctx.isIdentityCurrent = () => true;
      if (mode === "request") (ctx as { requestId: string }).requestId = randomUUID();
      if (mode === "closed") w.authority.close();
      if (mode === "cancel") p.retire();
      if (mode === "clock") w.time(-1);
      expect(() => p.assertCurrent()).toThrow();
      w.save(w.policy); w.authority.require = old.require; w.directory.checkEligibility = old.check; ctx.current = old.current; ctx.isIdentityCurrent = old.identity;
      (ctx as { requestId: string }).requestId = old.requestId;
      if (mode === "person") w.db.prepare("UPDATE hub_sessions SET person=? WHERE id=?").run(`${w.admin.realm}/${w.admin.objectId}`, p.actor.sessionId);
      if (mode === "clock") w.time(1);
      expect(() => p.assertCurrent()).toThrow(); await expect(p.authorize()).rejects.toThrow();
    });
  it.each(["gone", "unknown", "foreign"] as const)("fresh effect acquisition refuses %s eligibility", async mode => {
    const w = await roleAuthorityWorld(), p = await w.authority.prepareDirectory(w.ctx.ctx); w.time(6000);
    w.eligible.mockResolvedValueOnce(mode === "foreign" ? { eligible: true, person: w.person(w.other) } : { eligible: false, reason: mode === "gone" ? "gone" : "unavailable" });
    await expect(p.authorize()).rejects.toThrow(); expect(() => p.assertCurrent()).toThrow();
  });
  it("keeps the new physical proof acquisition within its ordinary twenty-second budget", async () => {
    const w = await roleAuthorityWorld(), p = await w.authority.prepareDirectory(w.ctx.ctx), gate = held();
    w.eligible.mockImplementationOnce(async who => { gate.enter(); await gate.wait; return { eligible: true, person: w.person(who) }; });
    const settled = p.authorize().then(value => ({ value }), error => ({ error })); await gate.entered;
    w.time(20000); w.elapsed(20000); gate.release();
    expect(await settled).toHaveProperty("error"); expect(() => p.assertCurrent()).toThrow();
  });
  it("holds the actual pool slot through fresh eligibility and keeps one acquisition flight", async () => {
    const w = await roleAuthorityWorld(), p = await w.authority.prepareDirectory(w.ctx.ctx), gate = held();
    w.eligible.mockImplementationOnce(async who => { gate.enter(); await gate.wait; return { eligible: true, person: w.person(who) }; });
    const flight = p.authorize().then(value => ({ value }), error => ({ error })); await gate.entered;
    const slots: (() => void)[] = [], readers = Array.from({ length: 3 }, () => w.pool.withDirectoryRead(w.admin, () => new Promise<void>(r => slots.push(r))));
    try {
      await expect(p.authorize()).rejects.toMatchObject({ code: "backpressure" });
      await expect(w.authority.require(w.ctx.ctx, "hub.admin")).rejects.toMatchObject({ code: "backpressure" });
    } finally { slots.forEach(r => r()); gate.release(); await Promise.all(readers); await flight; }
    expect(await flight).toMatchObject({ value: { actor: { person: w.admin } } }); expect(() => p.assertCurrent()).toThrow();
  });
  it.each(["cancel", "role", "session", "provider", "deadline"] as const)("refuses %s while fresh physical eligibility is held", async mode => {
    const w = await roleAuthorityWorld(), p = await w.authority.prepareDirectory(w.ctx.ctx), gate = held();
    w.eligible.mockImplementationOnce(async who => { gate.enter(); await gate.wait; return { eligible: true, person: w.person(who) }; });
    const settled = p.authorize().then(value => ({ value }), error => ({ error })); await gate.entered;
    if (mode === "cancel") p.retire();
    if (mode === "role") w.save({ ...w.policy, revision: 2, assignments: [] });
    if (mode === "session") w.sessions.signOut(w.ctx.token);
    if (mode === "provider") { const old = w.authority.require; w.authority.require = (...args) => old(...args); }
    if (mode === "deadline") w.time(300000);
    gate.release(); expect(await settled).toHaveProperty("error"); expect(() => p.assertCurrent()).toThrow();
  });
  it("keeps root-only management on a legacy policy and suspended self-use separate from management", async () => {
    const w = await roleAuthorityWorld(); w.save({ ...w.policy, state: "suspended" });
    expect((await (await w.authority.prepareDirectory(w.ctx.ctx)).authorize()).source).toBe("roles");
    w.db.prepare("UPDATE hub_group_policy SET body=?").run(w.legacyRaw);
    await expect(w.authority.prepareDirectory(w.ctx.ctx)).rejects.toMatchObject({ code: "denied" });
    const root = await w.browser(w.root); expect((await (await w.authority.prepareDirectory(root.ctx)).authorize()).source).toBe("legacy");
  });
});

async function engineWorld(root = false) {
  const w = await roleAuthorityWorld(), browser = root ? await w.browser(w.root) : w.ctx;
  const preparation = await w.authority.prepareDirectory(browser.ctx);
  const actor = { kind: "hub-administrator" as const, person: preparation.actor.person, sessionId: preparation.actor.sessionId, requestId: browser.ctx.requestId };
  const source: HubDirectoryProofSource = { directory: w.directory, config: { realm: "corp", profile: "ad", url: "ldaps://old.example.test", baseDn: "DC=example,DC=test", bindDn: "CN=Service", bindPasswordRef: BIND_PASSWORD_REF },
    administrator: w.root, bindPassword: "synthetic-service", groups: [], epoch: 0, image: "a".repeat(64), current: w.options.current };
  const handle = bindHubDirectoryPreparation(preparation, actor, source);
  const context: HubDirectoryProofContext = { actor, current: w.options.current, preparation: handle };
  const check = vi.fn<HubDirectory["checkEligibility"]>(async who => ({ eligible: true, person: w.person(who) }));
  const candidate: HubDirectory = { realm: "corp", checkEligibility: check, async signIn() { throw Error("personal credential reached candidate"); }, close: vi.fn(async () => {}) };
  const prepare = vi.fn<HubDirectorySettingsWriter["prepare"]>((_candidate, who, proof, administration) => {
    expect(proof()).toBe(true); assertHubDirectoryAdministration(administration!, who, source);
    return { ref: "owned-writer", expiresAt: w.options.now() + 300000 };
  });
  const commit = vi.fn<HubDirectorySettingsWriter["commit"]>((_ref, who, proof, _rotation, _deadline, administration) => {
    expect(proof()).toBe(true); assertHubDirectoryAdministration(administration!, who, source);
    return { receiptId: randomUUID(), directoryEpoch: 1 };
  });
  const probe = vi.fn(async () => "A".repeat(64));
  const engine = createHubDirectorySettingsProof({ source: () => source, createDirectory: () => candidate, now: w.options.now, withDirectoryRead: (who, work) => w.pool.withDirectoryRead(who, work),
    probeTls: probe, writer: () => ({ prepare, commit, compensate() { throw Error("outside this layer"); } }) });
  const input = { directory: { ...source.config, baseDn: "OU=Next,DC=example,DC=test" }, changes: ["search" as const], recipients: [{ kind: "host" as const, sink: "owned" }] };
  const save = async (current = context) => { const draft = await engine.prepare(input, current); return engine.apply(draft.ref, { credentials: { login: actor.person.objectId, password: "synthetic" } }, current); };
  return { ...w, browser, preparation, handle, actor, source, context, check, candidate, prepare, commit, probe, engine, input, saveDirectory: save };
}
describe("S129 preparation exchange at the directory proof engine", () => {
  it.each(["directory", "root"] as const)("cannot initially bind an actual preparation to another %s", async mode => {
    const w = await engineWorld(), source = { ...w.source };
    if (mode === "directory") source.directory = { ...w.directory }; else source.administrator = w.other;
    try { expect(() => bindHubDirectoryPreparation(w.preparation, w.actor, source)).toThrow(); }
    finally { w.engine.close(); }
  });
  it("finishes a slow candidate using a new opaque five-second proof after LDAP closes", async () => {
    const w = await engineWorld(), oldChecks = w.eligible.mock.calls.length;
    w.check.mockImplementation(async who => { w.time(6000); w.elapsed(6000); return { eligible: true, person: w.person(who) }; });
    try {
      await expect(w.saveDirectory()).resolves.toMatchObject({ directoryEpoch: 1 });
      expect(w.candidate.close).toHaveBeenCalledOnce(); expect(w.eligible.mock.calls.length).toBeGreaterThan(oldChecks);
      expect(w.prepare.mock.calls[0]![3]).toEqual({ directoryAdministration: true });
      expect(w.commit.mock.calls[0]![5]).toBe(w.prepare.mock.calls[0]![3]);
      expect(w.commit.mock.calls[0]![1]).toEqual(w.actor); expect(() => w.preparation.assertCurrent()).toThrow();
    } finally { w.engine.close(); }
  });
  it.each(["directory", "root", "epoch", "image", "frame", "session", "request", "forged"] as const)("refuses a %s preparation binding without writer effects", async mode => {
    const w = await engineWorld(), actor = structuredClone(w.actor), source = { ...w.source };
    if (mode === "directory") source.directory = { ...w.directory };
    if (mode === "root") source.administrator = w.other;
    if (mode === "epoch") source.epoch++;
    if (mode === "image") source.image = "b".repeat(64);
    if (mode === "frame") source.decisionProof = () => null;
    if (mode === "session") actor.sessionId = randomUUID();
    if (mode === "request") actor.requestId = randomUUID();
    const handle: HubDirectoryPreparation = mode === "forged" ? { directoryPreparation: true } : w.handle;
    try {
      expect(() => assertHubDirectoryPreparation(handle, actor, source)).toThrow();
      if (mode !== "forged") expect(() => assertHubDirectoryPreparation(w.handle, w.actor, w.source)).toThrow();
      expect(w.prepare).not.toHaveBeenCalled();
    } finally { w.engine.close(); }
  });
  it("cannot use a preparation handle as writer administration", async () => {
    const w = await engineWorld();
    try { expect(() => assertHubDirectoryAdministration(w.handle as never, w.actor, w.source)).toThrow(); }
    finally { w.engine.close(); }
  });
  it.each(["host", "mixed"] as const)("refuses %s context before candidate inspection", async mode => {
    const w = await engineWorld();
    try {
      const context: HubDirectoryProofContext = mode === "host" ? { ...w.context, actor: { kind: "host-owner", sessionId: "owned", requestId: randomUUID() } }
        : { ...w.context, administration: bindHubDirectoryAdministration(await w.authority.require(w.browser.ctx, "hub.admin"), w.actor, w.source) };
      await expect(w.engine.prepare(w.input, context)).rejects.toThrow(); expect(w.probe).not.toHaveBeenCalled();
    } finally { w.engine.close(); }
  });
  it("does not downgrade a root's role-prepared draft to legacy Save", async () => {
    const w = await engineWorld(true);
    try {
      const p = await w.engine.prepare(w.input, w.context);
      await expect(w.engine.apply(p.ref, { credentials: { login: w.root.objectId, password: "synthetic" } }, { actor: w.actor, current: w.context.current })).rejects.toThrow();
      expect(w.prepare).not.toHaveBeenCalled();
    } finally { w.engine.close(); }
  });
  it("refuses renewed old-directory ineligibility after candidate validation and consumes the draft", async () => {
    const w = await engineWorld();
    try {
      const p = await w.engine.prepare(w.input, w.context); w.eligible.mockResolvedValueOnce({ eligible: false, reason: "gone" });
      await expect(w.engine.apply(p.ref, { credentials: { login: w.admin.objectId, password: "synthetic" } }, w.context)).rejects.toThrow();
      expect(w.candidate.close).toHaveBeenCalledOnce(); expect(w.prepare).not.toHaveBeenCalled();
      await expect(w.engine.apply(p.ref, {}, w.context)).rejects.toThrow();
    } finally { w.engine.close(); }
  });
  it.each(["source", "abort", "session"] as const)("refuses %s change during final fresh eligibility", async mode => {
    const w = await engineWorld(), gate = held(), abort = new AbortController(); w.context.signal = abort.signal;
    try {
      const p = await w.engine.prepare(w.input, w.context);
      w.eligible.mockImplementationOnce(async who => { gate.enter(); await gate.wait; return { eligible: true, person: w.person(who) }; });
      const settled = w.engine.apply(p.ref, { credentials: { login: w.admin.objectId, password: "synthetic" } }, w.context).then(value => ({ value }), error => ({ error }));
      await gate.entered;
      if (mode === "source") w.source.image = "b".repeat(64);
      if (mode === "abort") abort.abort();
      if (mode === "session") w.sessions.signOut(w.browser.token);
      gate.release(); expect(await settled).toHaveProperty("error"); expect(w.prepare).not.toHaveBeenCalled();
    } finally { gate.release(); w.engine.close(); }
  });
  it("consumes the handle once and passes only a new administration proof across the exchange", async () => {
    const w = await engineWorld();
    try {
      const proof = await authorizeHubDirectoryPreparation(w.handle, w.actor, w.source);
      expect(() => assertHubDirectoryAdministration(proof, w.actor, w.source)).not.toThrow();
      await expect(authorizeHubDirectoryPreparation(w.handle, w.actor, w.source)).rejects.toThrow();
    } finally { w.engine.close(); }
  });
  it("refuses a source image replaced during standalone proof exchange before returning any witness", async () => {
    const w = await engineWorld(), gate = held();
    w.eligible.mockImplementationOnce(async who => { gate.enter(); await gate.wait; return { eligible: true, person: w.person(who) }; });
    const settled = authorizeHubDirectoryPreparation(w.handle, w.actor, w.source).then(value => ({ value }), error => ({ error }));
    try {
      await gate.entered; w.source.image = "b".repeat(64); gate.release();
      expect(await settled).toHaveProperty("error");
    } finally { gate.release(); w.engine.close(); }
  });
  it("does not extend a final effect proof for a slow precommit callback", async () => {
    const w = await engineWorld();
    try {
      const p = await w.engine.prepare(w.input, w.context);
      await expect(w.engine.apply(p.ref, { credentials: { login: w.admin.objectId, password: "synthetic" } }, w.context, undefined, () => { w.time(5000); return undefined; })).rejects.toThrow();
      expect(w.commit).not.toHaveBeenCalled();
    } finally { w.engine.close(); }
  });
});
