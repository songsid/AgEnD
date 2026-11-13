/** Inert orchestration controls. Real SQL/HTTPS composition is covered separately in hub-compose. */
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { HubSettingsError } from "../src/hub/settings-commit.js";
import { HubProtocolError } from "../src/hub/validation.js";
import { createHubDirectorySaveCoordinator, type HubDirectorySaveDeps } from "../src/hub/settings-directory-save.js";
import type { HubDirectorySettingsDecision, HubDirectorySettingsOperation } from "../src/hub/settings-directory-decision.js";
import type { HubDirectorySettingsProof, HubDirectoryProofContext } from "../src/hub/settings-directory-proof.js";
import type { HubDirectoryResponse } from "../src/hub/directory-response-owner.js";
import type { HubDirectorySettingsWriter } from "../src/hub/settings-commit.js";
import type { HubMountedDirectory } from "../src/hub/settings-directory-runtime.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(roleMode = false) {
  const hubId = randomUUID(), id = randomUUID(), compensation = randomUUID(), events: string[] = [];
  let time = 1000, live = true, owner = true, connected = true, active = true, failure = false, failRestore = false;
  let deadline: void | number;
  let proofGate: (() => Promise<void>) | undefined, mountGate: (() => Promise<void>) | undefined;
  let releaseGate: (() => Promise<void>) | undefined, beforeBuild: (() => void) | undefined, afterBuild: (() => void) | undefined;
  let permitted = true, released = false;
  const actor = { kind: "hub-administrator" as const, person: { realm: "fictional", objectId: randomUUID() }, sessionId: "owned-session", requestId: randomUUID() };
  const context: HubDirectoryProofContext = { actor, current: () => live,
    ...(roleMode ? { administration: { directoryAdministration: true as const } } : {}) };
  const expected = { operationId: null, directoryEpoch: 0, transportRevision: 0, authorizationVersion: 0, policySha: "a".repeat(64) };
  const head = { ...expected } as Omit<typeof expected, "operationId"> & { operationId: string | null };
  const original = { id, kind: "directory", compensates: null, actor: structuredClone(actor), expected, directoryEpoch: 1, recovery: { v: 1, expiresAt: 301_000 } } as unknown as HubDirectorySettingsOperation;
  let mountReady = false;
  const intent = vi.fn((): ReturnType<HubDirectorySettingsDecision["mountRecovery"]> => ({ operation: structuredClone(original), expiresAt: 301_000, state: mountReady ? "ready" : "pending", completedAt: mountReady ? time : null }));
  const settled = vi.fn(() => { events.push("mount-ready"); mountReady = true; });
  const decision = { hubId, inspect: () => ({ ...head }), operation: vi.fn(() => structuredClone(original)), mountRecovery: intent, completeMount: settled } as unknown as HubDirectorySettingsDecision;
  const complete = vi.fn(() => ({ token: "fixture-opaque-token", maxAgeMs: 10_000 }));
  const assertRole = vi.fn(() => { if (!permitted) throw new HubProtocolError("denied"); });
  const release = Object.freeze({ assertCurrent: assertRole,
    release: vi.fn(() => { assertRole(); if (released) throw new HubProtocolError("revoked"); released = true;
      events.push("role-release"); return { token: "fixture-role-token", maxAgeMs: 10_000 }; }), discard: vi.fn() });
  const prepareRole = vi.fn(async () => { events.push("role-acquire"); await releaseGate?.(); assertRole(); return release; });
  const helpers = { completeDirectoryRotation: complete, ...(roleMode ? { prepareRoleDirectoryRotationRelease: prepareRole } : {}) };
  let sessionsView = helpers;
  const old = { decision, current: () => live } as unknown as HubMountedDirectory;
  const mounted = { decision, current: () => active, sessions: () => sessionsView } as unknown as HubMountedDirectory;
  let replacementMount: HubMountedDirectory | undefined;
  const rotation = { discard: vi.fn() }, packets: Array<{ status: number; json: string; cookie?: string }> = [];
  const response: HubDirectoryResponse = { current: () => connected, discard: vi.fn(async () => { connected = false; }),
    reply: vi.fn(async (build, current) => { expect(current()).toBe(true); beforeBuild?.();
      if (roleMode) events.push("role-response");
      const packet = build(); afterBuild?.(); expect(current()).toBe(true); packets.push(packet); connected = false; }) };
  const capture = vi.fn(() => { events.push("capture"); return response; });
  const proof = { close: vi.fn(), apply: vi.fn<HubDirectorySettingsProof["apply"]>(async (_ref, _input, ctx, _rotation, beforeCommit) => {
    await proofGate?.();
    if (!ctx.current()) throw Error("proof revoked");
    deadline = beforeCommit?.(); if (!ctx.current()) throw Error("proof revoked");
    events.push("decision"); live = false; active = false; head.operationId = id; head.directoryEpoch = 1;
    return { receiptId: id, directoryEpoch: 1 };
  }) };
  const compensate = vi.fn<HubDirectorySettingsWriter["compensate"]>((target, intent) => {
    expect(target).toBe(id); expect(intent(structuredClone(original))).toBe(true); events.push("compensate");
    head.operationId = compensation; head.directoryEpoch = 2; return { receiptId: compensation, directoryEpoch: 2 };
  });
  const remount = vi.fn(async () => { events.push("remount"); await mountGate?.(); active = head.directoryEpoch === 1 ? !failure : !failRestore; });
  const deps: HubDirectorySaveDeps = { hubId, proof: proof as unknown as HubDirectorySettingsProof,
    mounted: () => live ? old : active ? replacementMount ?? mounted : null, writer: () => ({ compensate }) as unknown as HubDirectorySettingsWriter,
    withDecision: vi.fn(async work => work(decision)), remount, current: () => owner, now: () => time };
  const coordinator = createHubDirectorySaveCoordinator(deps);
  const save = () => coordinator.apply("owned-draft", {}, context, { capture, rotation });
  return { coordinator, context, deps, proof, rotation, response, packets, events, capture, save, id, compensation, head, original, complete,
    helpers, mounted, prepareRole, release, loseRole: () => { permitted = false; },
    replaceMounted: (next: HubMountedDirectory) => { replacementMount = next; },
    replaceSessionsView: () => { sessionsView = { ...helpers }; },
    releaseGate: (gate: () => Promise<void>) => { releaseGate = gate; }, beforeBuild: (hook: () => void) => { beforeBuild = hook; }, afterBuild: (hook: () => void) => { afterBuild = hook; },
    compensate, remount, intent, settled, decision, get deadline() { return deadline; }, tick: (n: number) => { time += n; }, stop: () => { owner = false; }, disconnect: () => { connected = false; },
    fail: (restore = false) => { failure = true; failRestore = restore; }, proofGate: (gate: () => Promise<void>) => { proofGate = gate; },
    mountGate: (gate: () => Promise<void>) => { mountGate = gate; } };
}

describe("S129 Save successor release", () => {
  it("acquires after mount completion and releases only inside the originating response", async () => {
    const r = fixture(true);
    try {
      await expect(r.save()).resolves.toMatchObject({ state: "ready" });
      expect(r.prepareRole).toHaveBeenCalledExactlyOnceWith(r.rotation, r.id); expect(r.complete).not.toHaveBeenCalled();
      expect(r.events).toEqual(["capture", "decision", "remount", "mount-ready", "role-acquire", "role-response", "role-release"]);
      expect(r.packets[0]?.cookie).toContain("fixture-role-token"); expect(r.release.discard).toHaveBeenCalledOnce();
    } finally { await r.coordinator.close(); }
  });
  it("refuses a missing role adapter without a legacy completion fallback", async () => {
    const r = fixture(true); delete r.helpers.prepareRoleDirectoryRotationRelease;
    try {
      await expect(r.save()).rejects.toMatchObject({ code: "unavailable" });
      expect(r.complete).not.toHaveBeenCalled(); expect(r.packets).toEqual([]);
      expect(r.compensate).not.toHaveBeenCalled(); expect(r.head.operationId).toBe(r.id);
    } finally { await r.coordinator.close(); }
  });
  it("keeps a committed ready directory after fresh successor authorization refuses", async () => {
    const r = fixture(true); r.prepareRole.mockRejectedValue(new HubProtocolError("denied"));
    try {
      await expect(r.save()).rejects.toMatchObject({ code: "denied" });
      expect(r.complete).not.toHaveBeenCalled(); expect(r.packets).toEqual([]);
      expect(r.compensate).not.toHaveBeenCalled(); expect(r.head.operationId).toBe(r.id);
      expect(r.settled).toHaveBeenCalledOnce();
    } finally { await r.coordinator.close(); }
  });
  it("holds the response until fresh successor acquisition settles", async () => {
    const r = fixture(true), entered = deferred(), held = deferred();
    r.releaseGate(async () => { entered.resolve(); await held.promise; });
    const saving = r.save(); void saving.catch(() => {});
    try {
      const boundary = await Promise.race([entered.promise.then(() => "acquiring"), saving.then(() => "finished", () => "refused")]);
      expect(boundary).toBe("acquiring"); expect(r.response.reply).not.toHaveBeenCalled();
      held.resolve(); await expect(saving).resolves.toMatchObject({ state: "ready" });
    } finally { held.resolve(); await Promise.allSettled([saving]); await r.coordinator.close(); }
  });
  it.each(["before", "after"] as const)("withholds a cookie when authority changes %s packet construction", async phase => {
    const r = fixture(true); r[phase === "before" ? "beforeBuild" : "afterBuild"](r.loseRole);
    try {
      await expect(r.save()).rejects.toThrow(); expect(r.packets).toEqual([]); expect(r.complete).not.toHaveBeenCalled();
      expect(r.compensate).not.toHaveBeenCalled(); expect(r.head.operationId).toBe(r.id);
    } finally { await r.coordinator.close(); }
  });
  it("drains a held successor acquisition on close before finishing cleanup", async () => {
    const r = fixture(true), entered = deferred(), held = deferred();
    r.releaseGate(async () => { entered.resolve(); await held.promise; });
    const saving = r.save(); void saving.catch(() => {}); await entered.promise;
    let closed = false; const closing = r.coordinator.close().then(() => { closed = true; });
    try {
      await Promise.resolve(); expect(closed).toBe(false); expect(r.release.discard).not.toHaveBeenCalled();
      held.resolve(); await expect(saving).rejects.toThrow(); await closing;
      expect(r.packets).toEqual([]); expect(r.complete).not.toHaveBeenCalled(); expect(r.release.discard).toHaveBeenCalledOnce();
    } finally { held.resolve(); await Promise.allSettled([saving, closing]); await r.coordinator.close(); }
  });
  it.each(["mount", "provider", "view", "method"] as const)("retires an awaited successor acquisition after its %s changes", async mode => {
    const r = fixture(true), entered = deferred(), held = deferred();
    r.releaseGate(async () => { entered.resolve(); await held.promise; });
    const saving = r.save(); void saving.catch(() => {}); await entered.promise;
    try {
      if (mode === "mount") r.replaceMounted({ ...r.mounted });
      else if (mode === "provider") {
        const previous = r.mounted.sessions; r.mounted.sessions = () => previous.call(r.mounted);
      }
      else if (mode === "view") r.replaceSessionsView();
      else r.helpers.prepareRoleDirectoryRotationRelease = vi.fn(async () => r.release);
      held.resolve(); await expect(saving).rejects.toThrow(); expect(r.packets).toEqual([]);
      expect(r.complete).not.toHaveBeenCalled(); expect(r.compensate).not.toHaveBeenCalled();
    } finally { held.resolve(); await Promise.allSettled([saving]); await r.coordinator.close(); }
  });
  it("refuses a non-void final assertion instead of accepting it as authority", async () => {
    const r = fixture(true); r.release.assertCurrent.mockImplementation(() => true as unknown as void);
    try { await expect(r.save()).rejects.toMatchObject({ code: "unavailable" }); expect(r.packets).toEqual([]); }
    finally { await r.coordinator.close(); }
  });
  it("refuses a mutable release object", async () => {
    const r = fixture(true); r.prepareRole.mockResolvedValue({ ...r.release });
    try { await expect(r.save()).rejects.toMatchObject({ code: "unavailable" }); expect(r.packets).toEqual([]); }
    finally { await r.coordinator.close(); }
  });
  it("keeps the legacy root completion when the new helper is merely available", async () => {
    const r = fixture(); r.helpers.prepareRoleDirectoryRotationRelease = r.prepareRole;
    try {
      await expect(r.save()).resolves.toMatchObject({ state: "ready" }); expect(r.prepareRole).not.toHaveBeenCalled();
      expect(r.complete).toHaveBeenCalledOnce(); expect(r.packets[0]?.cookie).toContain("fixture-opaque-token");
    } finally { await r.coordinator.close(); }
  });
  it("does not acquire a successor for forward compensation", async () => {
    const r = fixture(true); r.fail();
    try {
      await expect(r.save()).resolves.toMatchObject({ state: "restored" }); expect(r.prepareRole).not.toHaveBeenCalled();
      expect(r.release.release).not.toHaveBeenCalled(); expect(r.packets[0]?.cookie).toBeUndefined();
    } finally { await r.coordinator.close(); }
  });
  it("does not acquire authority for an already disconnected response", async () => {
    const r = fixture(true); r.mountGate(async () => { r.disconnect(); });
    try {
      await expect(r.save()).resolves.toMatchObject({ state: "ready" }); expect(r.prepareRole).not.toHaveBeenCalled();
      expect(r.packets).toEqual([]); expect(r.compensate).not.toHaveBeenCalled();
    } finally { await r.coordinator.close(); }
  });
  it("still cleans rotation and response when successor discard reports an error", async () => {
    const r = fixture(true); r.release.discard.mockImplementation(() => { throw Error("inert release cleanup"); });
    try {
      await expect(r.save()).rejects.toThrow("inert release cleanup"); expect(r.rotation.discard).toHaveBeenCalledOnce();
      expect(r.response.discard).toHaveBeenCalled();
    } finally { await r.coordinator.close(); }
  });
});

describe("private directory Save coordinator", () => {
  it("closes the durable mount intent before releasing any successor cookie", async () => {
    const r = fixture();
    r.complete.mockImplementation(() => { expect(r.settled).toHaveBeenCalledOnce(); return { token: "fixture-token", maxAgeMs: 10_000 }; });
    await expect(r.save()).resolves.toMatchObject({ state: "ready" });
    expect(r.events).toEqual(["capture", "decision", "remount", "mount-ready"]); await r.coordinator.close();
  });
  it("a refused durable completion never releases success or a cookie, and does not guess a rollback", async () => {
    const r = fixture(); r.intent.mockReturnValue({ operation: r.original, expiresAt: 301_000, state: "pending", completedAt: null });
    r.settled.mockImplementation(() => { throw Error("completion uncertain"); }); await expect(r.save()).rejects.toThrow("completion uncertain");
    expect(r.complete).not.toHaveBeenCalled(); expect(r.packets).toEqual([]); expect(r.compensate).not.toHaveBeenCalled(); await r.coordinator.close();
  });
  it("captures before the synchronous decision and releases only through the exact successor", async () => {
    const r = fixture(); expect(await r.save()).toEqual({ receiptId: r.id, directoryEpoch: 1, state: "ready" });
    expect(r.deadline).toBe(301_000);
    expect(r.events).toEqual(["capture", "decision", "remount", "mount-ready"]); expect(r.complete).toHaveBeenCalledOnce();
    expect(r.packets[0]).toMatchObject({ status: 200, cookie: expect.stringContaining("fixture-opaque-token") });
    expect(r.compensate).not.toHaveBeenCalled(); expect(r.rotation.discard).toHaveBeenCalled(); await r.coordinator.close();
  });
  it("does not capture or remount when authentication refuses", async () => {
    const r = fixture(); r.proof.apply.mockRejectedValue(Error("authentication refused"));
    await expect(r.save()).rejects.toThrow("authentication refused"); expect(r.capture).not.toHaveBeenCalled(); expect(r.remount).not.toHaveBeenCalled();
    expect(r.rotation.discard).toHaveBeenCalled(); await r.coordinator.close();
  });
  it("requires an admin rotation and refuses a host rotation", async () => {
    const r = fixture();
    await expect(r.coordinator.apply("draft", {}, r.context, { capture: r.capture })).rejects.toMatchObject({ code: "invalid" });
    await expect(r.coordinator.apply("draft", {}, { ...r.context, actor: { kind: "host-owner", sessionId: "host", requestId: "request" } },
      { capture: r.capture, rotation: r.rotation })).rejects.toMatchObject({ code: "invalid" });
    expect(r.proof.apply).not.toHaveBeenCalled(); await r.coordinator.close();
  });
  it("a failed replacement creates one forward compensation and never returns an admin cookie", async () => {
    const r = fixture(); r.fail();
    expect(await r.save()).toEqual({ receiptId: r.compensation, directoryEpoch: 2, state: "restored" });
    expect(r.events).toEqual(["capture", "decision", "remount", "compensate", "remount"]);
    expect(r.compensate.mock.calls[0]?.[2]).toBe(301_000); expect(r.complete).not.toHaveBeenCalled();
    expect(r.packets[0]).toMatchObject({ status: 503 }); expect(r.packets[0]?.cookie).toBeUndefined(); await r.coordinator.close();
  });
  it("a disconnected browser cannot cancel committed physical recovery", async () => {
    const r = fixture(); r.fail(); r.mountGate(async () => { r.disconnect(); });
    expect((await r.save()).state).toBe("restored"); expect(r.compensate).toHaveBeenCalledOnce(); expect(r.packets).toEqual([]);
    expect(r.complete).not.toHaveBeenCalled(); await r.coordinator.close();
  });
  it("a failed restoration stays unavailable, without recursive compensation or cookie release", async () => {
    const r = fixture(); r.fail(true); await expect(r.save()).rejects.toMatchObject({ code: "unavailable" });
    expect(r.compensate).toHaveBeenCalledOnce(); expect(r.complete).not.toHaveBeenCalled(); expect(r.packets).toEqual([]); await r.coordinator.close();
  });
  it("a newer decision is never overwritten by the old recovery intent", async () => {
    const r = fixture(); r.fail(); r.mountGate(async () => { r.head.operationId = randomUUID(); r.head.directoryEpoch = 2; });
    await expect(r.save()).rejects.toMatchObject({ code: "conflict" }); expect(r.compensate).not.toHaveBeenCalled(); await r.coordinator.close();
  });
  it.each(["actor", "expected", "kind", "epoch"])("refuses a mismatched %s operation", async part => {
    const r = fixture();
    if (part === "actor") r.original.actor.requestId = "other-request";
    if (part === "expected") r.original.expected.policySha = "b".repeat(64);
    if (part === "kind") r.original.kind = "directory-compensation";
    if (part === "epoch") r.original.directoryEpoch = 2;
    await expect(r.save()).rejects.toMatchObject({ code: "conflict" }); expect(r.complete).not.toHaveBeenCalled(); await r.coordinator.close();
  });
  it.each([-1, 300_000])("refuses recovery after a held remount crosses clock bound %s", async time => {
    const r = fixture(); r.fail(); r.mountGate(async () => { r.tick(time); });
    await expect(r.save()).rejects.toMatchObject({ code: "revoked" }); expect(r.compensate).not.toHaveBeenCalled(); await r.coordinator.close();
  });
  it.each(["proof", "remount"])("Stop permanently fences a held %s continuation and awaits it", async phase => {
    const r = fixture(), entered = deferred(), held = deferred();
    r[phase === "proof" ? "proofGate" : "mountGate"](async () => { entered.resolve(); await held.promise; });
    const saving = r.save().catch(error => error); await entered.promise;
    let closed = false; const closing = r.coordinator.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); held.resolve(); expect(await saving).toBeInstanceOf(Error); await closing;
    expect(r.compensate).not.toHaveBeenCalled(); expect(r.complete).not.toHaveBeenCalled(); expect(r.packets).toEqual([]);
  });
  it("does not admit a second save while a physical continuation remains held", async () => {
    const r = fixture(), entered = deferred(), held = deferred(); r.proofGate(async () => { entered.resolve(); await held.promise; });
    const first = r.save(); await entered.promise; const second = r.save(); void second.catch(() => {});
    try { expect(r.proof.apply).toHaveBeenCalledOnce(); await expect(second).rejects.toMatchObject({ code: "backpressure" }); }
    finally { held.resolve(); await Promise.allSettled([first, second]); await r.coordinator.close(); }
  });
  it("snapshots the actor and credential input before a held proof", async () => {
    const r = fixture(), entered = deferred(), held = deferred(); r.proofGate(async () => { entered.resolve(); await held.promise; });
    const input = { credentials: { login: "original", password: "fixture-private" } };
    const saving = r.coordinator.apply("draft", input, r.context, { capture: r.capture, rotation: r.rotation });
    await entered.promise; input.credentials.login = "replacement"; r.context.actor.requestId = randomUUID(); held.resolve();
    await expect(saving).resolves.toMatchObject({ state: "ready" }); expect(r.proof.apply.mock.calls[0]?.[1].credentials?.login).toBe("original");
    expect(r.proof.apply.mock.calls[0]?.[2].actor.requestId).toBe(r.original.actor.requestId); await r.coordinator.close();
  });
  it("the host lifetime fences a remount continuation even before coordinator teardown", async () => {
    const r = fixture(); r.fail(); r.mountGate(async () => { r.stop(); });
    await expect(r.save()).rejects.toMatchObject({ code: "revoked" }); expect(r.compensate).not.toHaveBeenCalled();
    expect(r.complete).not.toHaveBeenCalled(); await r.coordinator.close();
  });
  it("close retains and retries unconfirmed response cleanup", async () => {
    const r = fixture(); let failed = true;
    vi.mocked(r.response.discard).mockImplementation(async () => { if (failed) throw Error("unconfirmed socket"); });
    await expect(r.save()).rejects.toThrow("unconfirmed socket"); await expect(r.coordinator.close()).rejects.toThrow("unconfirmed socket");
    failed = false; await r.coordinator.close(); expect(r.response.discard).toHaveBeenCalledTimes(5);
  });
});


describe("captured pre-decision Save refusals", () => {
  it("replies with a bounded refusal only after proving the same authoritative pre-decision image", async () => {
    const r = fixture(), error = new HubSettingsError("stale");
    r.proof.apply.mockImplementation(async (_ref, _input, _ctx, _rotation, capture) => { capture?.(); throw error; });
    await expect(r.save()).rejects.toBe(error);
    expect(r.packets).toEqual([{status:409,json:JSON.stringify({ok:false,code:"stale",committed:false})}]);
    expect(r.complete).not.toHaveBeenCalled(); expect(r.remount).not.toHaveBeenCalled(); expect(r.compensate).not.toHaveBeenCalled();
    await r.coordinator.close();
  });
  it("never exposes arbitrary error text on the captured response", async () => {
    const r = fixture(), error = Error("Dummy-private-bind-material");
    r.proof.apply.mockImplementation(async (_ref, _input, _ctx, _rotation, capture) => { capture?.(); throw error; });
    await expect(r.save()).rejects.toBe(error);
    expect(r.packets).toEqual([{status:503,json:JSON.stringify({ok:false,code:"unavailable",committed:false})}]);
    expect(JSON.stringify(r.packets)).not.toContain(error.message); await r.coordinator.close();
  });
  it.each(["advanced", "uncertain"])("discards an %s decision outcome without claiming the settings were not committed", async mode => {
    const r = fixture(), error = new HubSettingsError("recovery");
    r.proof.apply.mockImplementation(async (_ref, _input, _ctx, _rotation, capture) => {
      capture?.(); if (mode === "advanced") { r.head.operationId=r.id; r.head.directoryEpoch=1; }
      else vi.mocked(r.deps.withDecision).mockRejectedValue(new HubProtocolError("uncertain"));
      throw error;
    });
    await expect(r.save()).rejects.toBe(error); expect(r.packets).toEqual([]); expect(r.complete).not.toHaveBeenCalled(); await r.coordinator.close();
  });
  it("rechecks the expected image at the final reply proof", async () => {
    const r = fixture(), error = new HubSettingsError("stale");
    let currentAtReply: boolean | undefined;
    r.proof.apply.mockImplementation(async (_ref, _input, _ctx, _rotation, capture) => { capture?.(); throw error; });
    vi.mocked(r.response.reply).mockImplementation(async (_build,current) => { r.head.authorizationVersion++; currentAtReply = current(); });
    await expect(r.save()).rejects.toBe(error); expect(currentAtReply).toBe(false);
    expect(r.response.reply).toHaveBeenCalledOnce(); expect(r.packets).toEqual([]); await r.coordinator.close();
  });
  it("refuses a packet build after a synchronous authority change", async () => {
    const r = fixture(), error = new HubSettingsError("stale"); let buildError: unknown;
    r.proof.apply.mockImplementation(async (_ref, _input, _ctx, _rotation, capture) => { capture?.(); throw error; });
    vi.mocked(r.response.reply).mockImplementation(async build => {
      r.head.authorizationVersion++;
      try { r.packets.push(build()); } catch (error) { buildError = error; }
    });
    await expect(r.save()).rejects.toBe(error); expect(buildError).toMatchObject({ code: "revoked" });
    expect(r.packets).toEqual([]); await r.coordinator.close();
  });
  it("rejects a borrowed participant for another Hub without publishing a refusal", async () => {
    const r = fixture(), error = new HubSettingsError("stale");
    r.proof.apply.mockImplementation(async (_ref, _input, _ctx, _rotation, capture) => { capture?.(); throw error; });
    vi.mocked(r.deps.withDecision).mockImplementation(async work => work({...r.decision,hubId:randomUUID()}));
    await expect(r.save()).rejects.toBe(error); expect(r.packets).toEqual([]); await r.coordinator.close();
  });
  it("Stop during the held failure lookup prevents any late refusal packet", async () => {
    const r = fixture(), error = new HubSettingsError("stale"), entered = deferred(), held = deferred();
    r.proof.apply.mockImplementation(async (_ref, _input, _ctx, _rotation, capture) => { capture?.(); throw error; });
    vi.mocked(r.deps.withDecision).mockImplementation(async work => { entered.resolve(); await held.promise; return work(r.decision); });
    const saving = r.save(); void saving.catch(() => {}); await entered.promise; r.stop(); held.resolve();
    await expect(saving).rejects.toBe(error); expect(r.packets).toEqual([]); await r.coordinator.close();
  });

});
