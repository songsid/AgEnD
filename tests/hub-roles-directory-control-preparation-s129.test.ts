/** Actual canonical role/session preparation; inert candidate directory and writer effects. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION } from "../src/hub/settings-directory-decision.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { assertHubDirectoryAdministration, bindHubDirectoryAdministration, bindHubDirectoryPreparation } from "../src/hub/roles/directory-authority.js";
import { createHubDirectorySettingsControl } from "../src/hub/settings-directory-control.js";
import { createHubDirectorySettingsProof, type HubDirectoryProofContext, type HubDirectoryProofSource } from "../src/hub/settings-directory-proof.js";
import type { HubDirectorySessionProof } from "../src/hub/session-directory-transition.js";
import type { HubDirectorySettingsWriter } from "../src/hub/settings-commit.js";
import type { HubMountedDirectory } from "../src/hub/settings-directory-runtime.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import { BIND_PASSWORD_REF } from "../src/hub/init/layout.js";

async function world(mode: "preparation" | "witness" | "root" | "host" = "preparation") {
  const w = await roleAuthorityWorld({ cutover: true });
  HUB_DIRECTORY_SETTINGS_MIGRATION.up(w.db);
  const decision = createHubDirectorySettingsDecision({ db: w.db, hubId: w.hubId, transport: w.store, roleProofs: true });
  const clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g1", transport: w.store,
    current: w.options.current, now: w.options.now });
  const authority = createHubManagementAuthority({ ...w.options, assertAuthorizationTime: clock.assertAuthorizationTime,
    directoryDecision: { db: w.db, hubId: w.hubId, assertAuthorizationTime: clock.assertDirectoryDecision } });
  w.core.deps.management = authority;
  const selected = mode === "root" || mode === "host" ? await w.browser(w.root) : w.ctx;
  const found = await selected.ctx.current(); if (found.kind !== "directory") throw Error("owned directory session");
  const actor = { kind: "hub-administrator" as const, person: found.person, sessionId: found.sessionId, requestId: selected.ctx.requestId };
  const source: HubDirectoryProofSource = { directory: w.directory, administrator: w.root, epoch: 0, image: "a".repeat(64),
    decisionProof: decision.administrationProof, current: w.options.current, bindPassword: "synthetic-service",
    groups: [], config: { realm: "corp", profile: "ad", url: "ldaps://old.example.test", baseDn: "DC=example,DC=test", bindDn: "CN=Service", bindPasswordRef: BIND_PASSWORD_REF } };
  const preparation = mode === "preparation" ? await w.core.directoryPreparation(selected.ctx) : undefined;
  const permit = mode === "witness" ? await authority.require(selected.ctx, "hub.admin") : undefined;
  const context: HubDirectoryProofContext = mode === "host"
    ? { actor: { kind: "host-owner", sessionId: "owned-host", requestId: randomUUID() }, current: w.options.current }
    : { actor, current: () => w.options.current() && selected.ctx.isIdentityCurrent!(actor.person, actor.sessionId),
      ...(preparation ? { preparation: bindHubDirectoryPreparation(preparation, actor, source) } : {}),
      ...(permit ? { administration: bindHubDirectoryAdministration(permit, actor, source) } : {}) };
  const recent = vi.fn((who: typeof actor, proof?: HubDirectorySessionProof) => w.sessions.recentAuthentication(who, proof));
  const candidate: HubDirectory = { realm: "corp", async signIn() { throw Error("personal credentials reached candidate"); },
    checkEligibility: vi.fn(async person => ({ eligible: true as const, person: w.person(person) })), close: vi.fn(async () => {}) };
  const prepare = vi.fn<HubDirectorySettingsWriter["prepare"]>((_candidate, who, current, witness) => {
    expect(current()).toBe(true); if (witness) assertHubDirectoryAdministration(witness, who, source);
    return { ref: "inert-writer", expiresAt: 300100 };
  });
  const commit = vi.fn<HubDirectorySettingsWriter["commit"]>((_ref, who, current, _rotation, _deadline, witness) => {
    expect(current()).toBe(true); if (witness) assertHubDirectoryAdministration(witness, who, source);
    return { receiptId: randomUUID(), directoryEpoch: 1 };
  });
  const writer = { prepare, commit, compensate(): never { throw Error("unmounted compensation"); } };
  const sessions = { recentAuthentication: recent, prepareDirectoryRotation: w.sessions.prepareDirectoryRotation.bind(w.sessions),
    completeDirectoryRotation: w.sessions.completeDirectoryRotation.bind(w.sessions) };
  let physical = 0;
  const mounted: HubMountedDirectory = { decision, current: w.options.current, source: () => source, sessions: () => sessions,
    withDirectoryRead: (person, work) => w.pool.withDirectoryRead(person, async () => { physical++; try { return await work(); } finally { physical--; } }) };
  const probe = vi.fn(async () => "A".repeat(64));
  const deps = { source: () => source, writer: () => writer, withDirectoryRead: mounted.withDirectoryRead,
    recentAuthentication: recent, now: w.options.now, createDirectory: () => candidate, probeTls: probe };
  const engine = createHubDirectorySettingsProof(deps);
  const control = createHubDirectorySettingsControl({ hubId: w.hubId, mounted: () => mounted, writer: () => writer,
    withDecision: async work => work(decision), remount: async () => {}, current: w.options.current,
    now: w.options.now, createDirectory: deps.createDirectory, probeTls: deps.probeTls });
  const input = () => ({ directory: { ...source.config, baseDn: "OU=Next,DC=example,DC=test" }, changes: ["search" as const],
    recipients: [{ kind: "host" as const, sink: "owner" }] });
  const request = () => { const { realm: _realm, profile: _profile, bindPasswordRef: _ref, ...directory } = input().directory; return { directory }; };
  return { ...w, decision, actor, source, selected, context, preparation, recent, candidate, prepare, commit, control, engine, input, request, mounted, probe,
    get physical() { return physical; },
    async finish() { engine.close(); await control.close(); } };
}

describe("S129 preparation-aware directory controller", () => {
  it("reads the auxiliary preparation's actual recent sign-in through the controller", async () => {
    const w = await world();
    try {
      expect(() => w.control.read(w.context)).not.toThrow();
      expect(w.control.read(w.context).reauthentication).toBe("recent");
    } finally { await w.finish(); }
  });
  it("keeps the effect witness when the controller asks its actual session adapter", async () => {
    const w = await world("witness");
    try { expect(w.control.read(w.context).reauthentication).toBe("recent"); }
    finally { await w.finish(); }
  });
  it("uses the recent auxiliary sign-in for a preparation without asking for another password", async () => {
    const w = await world();
    try {
      const draft = await w.engine.prepare(w.input(), w.context);
      await expect(w.engine.apply(draft.ref, {}, w.context)).resolves.toMatchObject({ directoryEpoch: 1 });
      expect(w.commit).toHaveBeenCalledOnce();
    } finally { await w.finish(); }
  });
  it.each(["root", "host"] as const)("retains the bare %s read contract", async mode => {
    const w = await world(mode);
    try { expect(w.control.read(w.context).reauthentication).toBe(mode === "host" ? "host" : "recent"); }
    finally { await w.finish(); }
  });
  it("does not acquire browser sessions for a D3 host read", async () => {
    const w = await world("host"); w.mounted.sessions = () => { throw Error("host read acquired browser sessions"); };
    try { expect(w.control.read(w.context).reauthentication).toBe("host"); expect(w.recent).not.toHaveBeenCalled(); }
    finally { await w.finish(); }
  });
  it("passes a frozen narrow binding and the exact opaque preparation to the real session helper", async () => {
    const w = await world();
    try {
      w.control.read(w.context);
      const proof = w.recent.mock.calls[0]![1]!;
      expect(proof).toHaveProperty("preparation", w.context.preparation);
      expect(Object.isFrozen(proof)).toBe(true); expect(Object.isFrozen(proof.source)).toBe(true);
      expect(Object.keys(proof.source).sort()).toEqual(["administrator", "decisionProof", "directory", "epoch", "image"]);
      expect(proof.source.directory).toBe(w.source.directory); expect(proof.source.decisionProof).toBe(w.source.decisionProof);
      expect(proof.source.administrator).toEqual(w.root);
    } finally { await w.finish(); }
  });
  it("keeps a slow preparation usable without refreshing its recorded authentication", async () => {
    const w = await world(); w.time(90000); w.elapsed(90000);
    try {
      expect(w.control.read(w.context).reauthentication).toBe("recent");
      expect(w.db.prepare("SELECT authenticated_at FROM hub_session_authentication WHERE session_id=?").get(w.actor.sessionId)).toEqual({ authenticated_at: 100 });
      const draft = await w.control.prepare(w.request(), w.context);
      await expect(w.control.test({ ref: draft.ref }, w.context)).resolves.toEqual({ ok: true });
      expect(w.candidate.checkEligibility).toHaveBeenCalledWith(w.root);
      expect(w.candidate.checkEligibility).toHaveBeenCalledWith(w.admin);
      expect(w.commit).not.toHaveBeenCalled();
    } finally { await w.finish(); }
  });
  it("does not extend an ordinary effect witness to the preparation budget", async () => {
    const w = await world("witness"); w.time(5000);
    try { expect(() => w.control.read(w.context)).toThrow(); expect(w.recent).not.toHaveBeenCalled(); }
    finally { await w.finish(); }
  });
  it("keeps a missing attestation missing and requires reauthentication", async () => {
    const w = await world(); w.db.prepare("DELETE FROM hub_session_authentication WHERE session_id=?").run(w.actor.sessionId);
    try {
      expect(w.control.read(w.context).reauthentication).toBe("required");
      const draft = await w.engine.prepare(w.input(), w.context);
      await expect(w.engine.apply(draft.ref, {}, w.context)).rejects.toMatchObject({ code: "reauthentication" });
      expect(w.commit).not.toHaveBeenCalled();
      expect(w.db.prepare("SELECT authenticated_at FROM hub_session_authentication WHERE session_id=?").get(w.actor.sessionId)).toBeUndefined();
    } finally { await w.finish(); }
  });
  it("does not let a new preparation renew an expired sign-in attestation", async () => {
    const w = await world(); w.time(200000); w.elapsed(200000);
    w.context.preparation = bindHubDirectoryPreparation(await w.core.directoryPreparation(w.selected.ctx), w.actor, w.source);
    w.time(100001); w.elapsed(100001);
    try {
      expect(w.control.read(w.context).reauthentication).toBe("required");
      const draft = await w.engine.prepare(w.input(), w.context);
      await expect(w.engine.apply(draft.ref, {}, w.context)).rejects.toMatchObject({ code: "reauthentication" });
      expect(w.commit).not.toHaveBeenCalled();
    } finally { await w.finish(); }
  });
  it("keeps fresh old-directory eligibility mandatory despite a recent authentication", async () => {
    const w = await world();
    try {
      const draft = await w.engine.prepare(w.input(), w.context);
      w.eligible.mockResolvedValueOnce({ eligible: false, reason: "unavailable" });
      await expect(w.engine.apply(draft.ref, {}, w.context)).rejects.toMatchObject({ code: "unavailable" });
      expect(w.candidate.checkEligibility).not.toHaveBeenCalled(); expect(w.commit).not.toHaveBeenCalled();
    } finally { await w.finish(); }
  });
  it.each(["image", "epoch", "root", "frame", "signout", "time", "lifetime"] as const)("withholds a read when %s changes during authentication lookup", async mode => {
    const w = await world();
    w.recent.mockImplementation((actor, proof) => {
      const at = w.sessions.recentAuthentication(actor, proof);
      if (mode === "image") w.source.image = "b".repeat(64);
      if (mode === "epoch") w.source.epoch++;
      if (mode === "root") w.source.administrator = w.other;
      if (mode === "frame") w.source.decisionProof = () => null;
      if (mode === "signout") w.sessions.signOut(w.selected.token);
      if (mode === "time") w.time(300000);
      if (mode === "lifetime") w.stop();
      return at;
    });
    try { expect(() => w.control.read(w.context)).toThrow(); expect(w.commit).not.toHaveBeenCalled(); }
    finally { await w.finish(); }
  });
  it("withholds writer effects when source authority changes during the engine's attestation callback", async () => {
    const w = await world();
    w.recent.mockImplementation((actor, proof) => { const at = w.sessions.recentAuthentication(actor, proof); w.source.image = "b".repeat(64); return at; });
    try {
      const draft = await w.engine.prepare(w.input(), w.context);
      await expect(w.engine.apply(draft.ref, {}, w.context)).rejects.toThrow();
      expect(w.candidate.checkEligibility).not.toHaveBeenCalled(); expect(w.prepare).not.toHaveBeenCalled(); expect(w.commit).not.toHaveBeenCalled();
    } finally { await w.finish(); }
  });
  it("does not revive the retired preparation when a changed source comes back", async () => {
    const w = await world();
    w.recent.mockImplementation((actor, proof) => { const at = w.sessions.recentAuthentication(actor, proof); w.source.image = "b".repeat(64); return at; });
    try {
      expect(() => w.control.read(w.context)).toThrow();
      w.source.image = "a".repeat(64); w.recent.mockImplementation((actor, proof) => w.sessions.recentAuthentication(actor, proof));
      expect(() => w.control.read(w.context)).toThrow();
    } finally { await w.finish(); }
  });
  it("holds the shared physical slot through a cancelled preparation until its probe settles", async () => {
    const w = await world(); let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    w.probe.mockImplementation(async () => { enter(); await held; return "A".repeat(64); });
    const preparing = w.control.prepare(w.request(), w.context); void preparing.catch(() => {}); await entered;
    let settled = false; const closing = w.control.close().then(() => { settled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false); expect(w.physical).toBe(1);
      release(); await expect(preparing).rejects.toThrow(); await closing; expect(w.physical).toBe(0); expect(w.commit).not.toHaveBeenCalled();
    } finally { release(); await preparing.catch(() => {}); await closing; await w.finish(); }
  });
});
