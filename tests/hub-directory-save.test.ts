/** Inert orchestration controls. Real SQL/HTTPS composition is covered separately in hub-compose. */
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createHubDirectorySaveCoordinator, type HubDirectorySaveDeps } from "../src/hub/settings-directory-save.js";
import type { HubDirectorySettingsDecision, HubDirectorySettingsOperation } from "../src/hub/settings-directory-decision.js";
import type { HubDirectorySettingsProof } from "../src/hub/settings-directory-proof.js";
import type { HubDirectoryResponse } from "../src/hub/directory-response-owner.js";
import type { HubDirectorySettingsWriter } from "../src/hub/settings-commit.js";
import type { HubMountedDirectory } from "../src/hub/settings-directory-runtime.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const hubId = randomUUID(), id = randomUUID(), compensation = randomUUID(), events: string[] = [];
  let time = 1000, live = true, owner = true, connected = true, active = true, failure = false, failRestore = false;
  let deadline: void | number;
  let proofGate: (() => Promise<void>) | undefined, mountGate: (() => Promise<void>) | undefined;
  const actor = { kind: "hub-administrator" as const, person: { realm: "fictional", objectId: randomUUID() }, sessionId: "owned-session", requestId: randomUUID() };
  const context = { actor, current: () => live };
  const expected = { operationId: null, directoryEpoch: 0, transportRevision: 0, authorizationVersion: 0, policySha: "a".repeat(64) };
  const head = { ...expected } as Omit<typeof expected, "operationId"> & { operationId: string | null };
  const original = { id, kind: "directory", compensates: null, actor: structuredClone(actor), expected, directoryEpoch: 1, recovery: { v: 1, expiresAt: 301_000 } } as unknown as HubDirectorySettingsOperation;
  let mountReady = false;
  const intent = vi.fn((): ReturnType<HubDirectorySettingsDecision["mountRecovery"]> => ({ operation: structuredClone(original), expiresAt: 301_000, state: mountReady ? "ready" : "pending", completedAt: mountReady ? time : null }));
  const settled = vi.fn(() => { events.push("mount-ready"); mountReady = true; });
  const decision = { hubId, inspect: () => ({ ...head }), operation: vi.fn(() => structuredClone(original)), mountRecovery: intent, completeMount: settled } as unknown as HubDirectorySettingsDecision;
  const complete = vi.fn(() => ({ token: "fixture-opaque-token", maxAgeMs: 10_000 }));
  const old = { decision, current: () => live } as unknown as HubMountedDirectory;
  const mounted = { decision, current: () => active, sessions: () => ({ completeDirectoryRotation: complete }) } as unknown as HubMountedDirectory;
  const rotation = { discard: vi.fn() }, packets: Array<{ status: number; json: string; cookie?: string }> = [];
  const response: HubDirectoryResponse = { current: () => connected, discard: vi.fn(async () => { connected = false; }),
    reply: vi.fn(async (build, current) => { expect(current()).toBe(true); packets.push(build()); expect(current()).toBe(true); connected = false; }) };
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
    mounted: () => live ? old : active ? mounted : null, writer: () => ({ compensate }) as unknown as HubDirectorySettingsWriter,
    withDecision: vi.fn(async work => work(decision)), remount, current: () => owner, now: () => time };
  const coordinator = createHubDirectorySaveCoordinator(deps);
  const save = () => coordinator.apply("owned-draft", {}, context, { capture, rotation });
  return { coordinator, context, deps, proof, rotation, response, packets, events, capture, save, id, compensation, head, original, complete,
    compensate, remount, intent, settled, get deadline() { return deadline; }, tick: (n: number) => { time += n; }, stop: () => { owner = false; }, disconnect: () => { connected = false; },
    fail: (restore = false) => { failure = true; failRestore = restore; }, proofGate: (gate: () => Promise<void>) => { proofGate = gate; },
    mountGate: (gate: () => Promise<void>) => { mountGate = gate; } };
}

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
