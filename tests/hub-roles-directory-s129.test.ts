/** Actual role/session proof and directory proof engine; candidate directory/writer are inert. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { assertHubDirectoryAdministration, bindHubDirectoryAdministration, type HubDirectoryAdministration } from "../src/hub/roles/directory-authority.js";
import { createHubDirectorySettingsProof, type HubDirectoryProofContext, type HubDirectoryProofSource } from "../src/hub/settings-directory-proof.js";
import { BIND_PASSWORD_REF } from "../src/hub/init/layout.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import type { HubDirectorySettingsWriter } from "../src/hub/settings-commit.js";
import { HubSettingsError } from "../src/hub/settings-commit.js";
import { createHubDirectorySettingsControl } from "../src/hub/settings-directory-control.js";
import type { HubMountedDirectory } from "../src/hub/settings-directory-runtime.js";
import * as certificates from "../src/hub/init/directory-certificate.js";

async function world(mode: "auxiliary" | "root" | "host" = "auxiliary") {
  const w = await roleAuthorityWorld(), selected = mode === "auxiliary" ? w.ctx : await w.browser(w.root);
  const who = mode === "auxiliary" ? w.admin : w.root;
  const actor = await selected.ctx.requirePerson(); expect(actor).toEqual(who);
  const directoryActor = await selected.ctx.current(); if (directoryActor.kind !== "directory") throw Error("fixture directory actor");
  const admin = { kind: "hub-administrator" as const, person: who, sessionId: directoryActor.sessionId, requestId: randomUUID() };
  const source: HubDirectoryProofSource = { directory: w.directory, administrator: w.root, config: { realm: "corp", profile: "ad", url: "ldaps://old.example.test", baseDn: "DC=example,DC=test", bindDn: "CN=Service", bindPasswordRef: BIND_PASSWORD_REF },
    bindPassword: "synthetic-service", groups: [], epoch: 0, image: "a".repeat(64), current: () => true };
  const administration = bindHubDirectoryAdministration(await w.authority.require(selected.ctx, "hub.admin"), admin, source);
  const context: HubDirectoryProofContext & { administration?: HubDirectoryAdministration } = mode === "host"
    ? { actor: { kind: "host-owner", sessionId: "owned-host", requestId: randomUUID() }, current: () => true }
    : { actor: admin, current: () => true, ...(mode === "auxiliary" ? { administration } : {}) };
  const eligible = vi.fn<HubDirectory["checkEligibility"]>(async person => ({ eligible: true, person: w.person(person) }));
  const close = vi.fn(async () => {}), candidate: HubDirectory = { realm: "corp", signIn: vi.fn(async () => { throw Error("personal password reached candidate"); }), checkEligibility: eligible, close };
  const prepare = vi.fn<HubDirectorySettingsWriter["prepare"]>((_candidate, _actor, current) => { expect(current()).toBe(true); return { ref: "synthetic-writer", expiresAt: 300_100 }; });
  const commit = vi.fn<HubDirectorySettingsWriter["commit"]>((_ref, _actor, current) => { expect(current()).toBe(true); return { receiptId: randomUUID(), directoryEpoch: 1 }; });
  const readKeys = vi.fn((_person: typeof who) => {});
  const read = <T>(person: typeof who, work: () => Promise<T>) => { readKeys(person); return w.pool.withDirectoryRead(person, work); };
  const writer = { prepare, commit, compensate() { throw Error("not part of this proof engine"); } };
  const deps = { source: () => source, withDirectoryRead: read, createDirectory: () => candidate,
    writer: () => writer, probeTls: async () => "A".repeat(64), now: () => 100 };
  const engine = createHubDirectorySettingsProof(deps);
  const mounted = { current: () => true, decision: { hubId: w.hubId, inspect: () => ({ operationId: null, directoryEpoch: 0, transportRevision: 0, authorizationVersion: 0, policySha: "a".repeat(64) }) },
    source: () => source, sessions: () => ({ recentAuthentication: () => null }), withDirectoryRead: read } as unknown as HubMountedDirectory;
  const controller = createHubDirectorySettingsControl({ hubId: w.hubId, mounted: () => mounted, writer: () => writer, withDecision: async work => work(mounted.decision),
    remount: async () => {}, current: () => true, createDirectory: () => candidate, probeTls: deps.probeTls, now: deps.now });
  const input = () => ({ directory: { ...source.config, baseDn: "OU=Next,DC=example,DC=test" }, changes: ["search" as const], recipients: [{ kind: "host" as const, sink: "owner" }] });
  const save = async () => { const p = await engine.prepare(input(), context); return engine.apply(p.ref, mode === "host" ? {} : { credentials: { login: who.objectId, password: "synthetic" } }, context); };
  const finish = async () => { engine.close(); await controller.close(); };
  const reprove = async () => { context.administration = bindHubDirectoryAdministration(await w.authority.require(selected.ctx, "hub.admin"), admin, source); return context.administration; };
  return { ...w, administration, context, adminActor: admin, who, source, eligible, candidate, close, prepare, commit, engine, input, saveDirectory: save, oldEligibility: w.eligible, deps, controller, read: readKeys, finish, reprove };
}

describe("S129 directory proof administrator identity", () => {
  it("prepares for a current auxiliary administrator, authenticates that actor and checks both candidate identities", async () => {
    const w = await world();
    try {
      await expect(w.saveDirectory()).resolves.toMatchObject({ directoryEpoch: 1 });
      expect(w.eligible.mock.calls.map(([person]) => person)).toEqual([w.root, w.admin]);
      expect(w.prepare.mock.calls[0]![1]).toEqual(w.adminActor);
      expect(w.commit.mock.calls[0]![1]).toEqual(w.adminActor);
      expect(w.prepare.mock.calls[0]![3]).toBe(w.administration);
      expect(w.commit.mock.calls[0]![5]).toBe(w.administration);
      expect(w.read.mock.calls.every(([person]) => person.objectId === w.admin.objectId)).toBe(true);
    } finally { await w.finish(); }
  });
  it("carries the same opaque administrator witness alongside the bounded commit deadline", async () => {
    const w = await world();
    try {
      const p = await w.engine.prepare(w.input(), w.context);
      await w.engine.apply(p.ref, { credentials: { login: w.who.objectId, password: "synthetic" } }, w.context, undefined, () => 1600);
      expect(w.prepare.mock.calls[0]![3]).toBe(w.administration);
      expect(w.commit.mock.calls[0]![4]).toBe(1600);
      expect(w.commit.mock.calls[0]![5]).toBe(w.administration);
    } finally { await w.finish(); }
  });
  it.each(["root", "host"] as const)("retains the old %s proof path", async mode => {
    const w = await world(mode);
    try { await expect(w.saveDirectory()).resolves.toMatchObject({ directoryEpoch: 1 }); expect(w.eligible).toHaveBeenCalledWith(w.root); }
    finally { await w.finish(); }
  });
  it("requires the acting administrator's password rather than the root's password", async () => {
    const w = await world();
    try {
      const p = await w.engine.prepare(w.input(), w.context);
      await expect(w.engine.apply(p.ref, { credentials: { login: w.root.objectId, password: "synthetic" } }, w.context)).rejects.toMatchObject({ code: "denied" });
      expect(w.eligible).not.toHaveBeenCalled(); expect(w.prepare).not.toHaveBeenCalled();
    } finally { await w.finish(); }
  });
  it.each(["root", "actor", "actor-unknown"] as const)("requires current candidate eligibility for %s", async mode => {
    const w = await world();
    w.eligible.mockImplementation(async person => person.objectId === (mode === "root" ? w.root.objectId : w.admin.objectId)
      ? { eligible: false, reason: mode === "actor-unknown" ? "unavailable" : "gone" } : { eligible: true, person: w.person(person) });
    try {
      await expect(w.saveDirectory()).rejects.toMatchObject({ code: mode === "actor-unknown" ? "unavailable" : "denied" });
      expect(w.prepare).not.toHaveBeenCalled(); expect(w.close).toHaveBeenCalledOnce();
    } finally { await w.finish(); }
  });
  it("retains actor eligibility when using a recent server authentication", async () => {
    const w = await world(), deps = w.deps as typeof w.deps & { recentAuthentication?(): number };
    const recent = vi.fn(() => 100); deps.recentAuthentication = recent;
    try {
      const old = vi.spyOn(w.directory, "signIn"); w.oldEligibility.mockClear();
      const p = await w.engine.prepare(w.input(), w.context);
      await w.engine.apply(p.ref, {}, w.context);
      expect(old).not.toHaveBeenCalled();
      expect(w.eligible.mock.calls.map(([person]) => person)).toEqual([w.root, w.admin]);
      expect(w.eligible.mock.calls).toHaveLength(2);
      expect(w.prepare.mock.calls[0]![1]).toEqual(w.adminActor);
      // Fresh old-directory eligibility is independent of candidate eligibility.
      expect(w.oldEligibility).toHaveBeenCalledExactlyOnceWith(w.admin);
      expect(recent).toHaveBeenCalledExactlyOnceWith(w.adminActor, { witness: w.administration,
        source: { directory: w.source.directory, administrator: w.source.administrator, image: w.source.image, epoch: w.source.epoch } });
    } finally { await w.finish(); }
  });
  it("refuses unknown old-directory eligibility despite a recent server authentication", async () => {
    const w = await world(), deps = w.deps as typeof w.deps & { recentAuthentication?(): number };
    deps.recentAuthentication = () => 100; w.oldEligibility.mockClear();
    w.oldEligibility.mockResolvedValue({ eligible: false, reason: "unavailable" });
    try {
      const p = await w.engine.prepare(w.input(), w.context);
      await expect(w.engine.apply(p.ref, {}, w.context)).rejects.toMatchObject({ code: "unavailable" });
      expect(w.oldEligibility).toHaveBeenCalledExactlyOnceWith(w.admin); expect(w.eligible).not.toHaveBeenCalled(); expect(w.prepare).not.toHaveBeenCalled();
    } finally { await w.finish(); }
  });
  it.each(["no-witness", "forged", "foreign-session", "foreign-request", "foreign-person"] as const)("refuses %s before candidate work", async mode => {
    const w = await world(), ctx = { ...w.context, actor: structuredClone(w.context.actor) };
    if (mode === "no-witness") delete ctx.administration;
    if (mode === "forged") ctx.administration = Object.freeze({ directoryAdministration: true });
    if (ctx.actor.kind !== "hub-administrator") throw Error("fixture actor");
    if (mode === "foreign-session") ctx.actor.sessionId = randomUUID();
    if (mode === "foreign-request") ctx.actor.requestId = randomUUID();
    if (mode === "foreign-person") ctx.actor.person = w.other;
    try { await expect(w.engine.prepare(w.input(), ctx)).rejects.toThrow(); expect(w.prepare).not.toHaveBeenCalled(); }
    finally { await w.finish(); }
  });
  it.each(["directory", "image", "epoch", "root"] as const)("binds the witness to its exact %s source", async field => {
    const w = await world(), source = { ...w.source };
    if (field === "directory") source.directory = { ...source.directory };
    if (field === "image") source.image = "b".repeat(64);
    if (field === "epoch") source.epoch++;
    if (field === "root") source.administrator = w.other;
    try {
      expect(() => assertHubDirectoryAdministration(w.administration, w.adminActor, source)).toThrow();
      expect(() => assertHubDirectoryAdministration(w.administration, w.adminActor, w.source)).toThrow();
    } finally { await w.finish(); }
  });
  it("does not let a host recovery consume a browser administrator witness", async () => {
    const w = await world("host"); w.context.administration = w.administration;
    try { await expect(w.saveDirectory()).rejects.toMatchObject({ code: "denied" }); expect(w.prepare).not.toHaveBeenCalled(); }
    finally { await w.finish(); }
  });
  it("refuses a split join.manage permit as directory administration", async () => {
    const w = await world();
    try {
      const permit = await w.authority.require(w.ctx.ctx, "join.manage");
      expect(() => bindHubDirectoryAdministration(permit, w.adminActor, w.source)).toThrow("denied");
    } finally { await w.finish(); }
  });
  it.each(["role-loss", "expiry"] as const)("retires the witness on %s during a held candidate read", async mode => {
    const w = await world();
    if (mode === "expiry") { w.policy.assignments[0]!.expiresAt = 200; w.save(w.policy); await w.reprove(); }
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { release = r; });
    w.eligible.mockImplementationOnce(async person => { enter(); await held; return { eligible: true, person: w.person(person) }; });
    const pending = w.saveDirectory().catch(error => error);
    try {
      await entered;
      if (mode === "expiry") w.time(100); else w.save({ ...w.policy, rolesActive: false });
      release(); expect(await pending).toHaveProperty("code"); expect(w.prepare).not.toHaveBeenCalled(); expect(w.close).toHaveBeenCalledOnce();
      if (mode === "role-loss") w.save(w.policy);
      expect(() => assertHubDirectoryAdministration(w.context.administration!, w.adminActor, w.source)).toThrow();
    } finally { release(); await pending; await w.finish(); }
  });
  it("checks authority after response capture before invoking the commit callback", async () => {
    const w = await world();
    try {
      const p = await w.engine.prepare(w.input(), w.context);
      await expect(w.engine.apply(p.ref, { credentials: { login: w.admin.objectId, password: "synthetic" } }, w.context, undefined,
        () => { w.save({ ...w.policy, rolesActive: false }); })).rejects.toHaveProperty("code");
      expect(w.prepare).toHaveBeenCalledOnce(); expect(w.commit).not.toHaveBeenCalled();
    } finally { await w.finish(); }
  });
  it("keeps the opaque witness through controller reads, preparation and the predecision Save orchestration", async () => {
    const w = await world(), request = { directory: { url: w.source.config.url, baseDn: "OU=Next,DC=example,DC=test", bindDn: w.source.config.bindDn } };
    try {
      expect(w.controller.read(w.context)).toMatchObject({ reauthentication: "required", epoch: 0 });
      const p = await w.controller.prepare(request, w.context), rotation = { discard: vi.fn() };
      await expect(w.controller.apply({ ref: p.ref, credentials: { login: w.admin.objectId, password: "synthetic" } }, w.context,
        { rotation, capture() { throw new HubSettingsError("stale"); } })).rejects.toMatchObject({ code: "stale" });
      expect(w.prepare).toHaveBeenCalledOnce(); expect(w.commit).not.toHaveBeenCalled(); expect(rotation.discard).toHaveBeenCalled();
      w.save({ ...w.policy, rolesActive: false });
      expect(() => w.controller.read(w.context)).toThrow();
    } finally { await w.finish(); }
  });
  it("retains the witness and acting-person physical pool identity through CA inspection", async () => {
    vi.spyOn(certificates, "inspectDirectoryCertificate").mockImplementation(async url => ({ url, leafPem: "synthetic-leaf", chain: [],
      certificate: { fingerprint256: "AA".repeat(32), subject: "Synthetic", issuer: "Synthetic", validTo: "synthetic" } }));
    const w = await world();
    try {
      await expect(w.controller.inspectCa({ url: w.source.config.url }, w.context)).resolves.toHaveProperty("ref");
      expect(w.read.mock.calls.every(([person]) => person.objectId === w.admin.objectId)).toBe(true);
    } finally { await w.finish(); }
  });
});
