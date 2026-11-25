import { expect, it } from "vitest";
import { deliveryContentDigest as wireDigest } from "../src/delivery-outbox.js";
import { RequestContextLocalTurns, RequestContextInputDeferred, type PreparedRequestContextInput, type RequestContextRecoveryPointer,
  type RequestContextRuntimeOwner, type RequestContextTurnPorts } from "../src/request-context-turns.js";
import type { RequestContextV1 } from "../src/request-context-protocol.js";
const ROOT = "00000000-0000-4000-8000-000000000001", CHILD = "00000000-0000-4000-8000-000000000002", OTHER = "00000000-0000-4000-8000-000000000003";
const owner: RequestContextRuntimeOwner = { instance: "worker", incarnation: "worker-generation", workGeneration: "session-1",
  daemonBootId: "boot-1", spawnGeneration: 1, launchFenceEpoch: 0, deliveryEpoch: 0 };
const context = (): RequestContextV1 => ({ ref: { version: 1, contextId: ROOT, rootContextId: ROOT }, rootEvidenceRef: "accepted-fixture",
  initiatingActor: { kind: "person", platform: "discord", userId: "demo-person" }, ingress: "restricted-room",
  source: { instance: owner.instance, incarnation: owner.incarnation }, sourceAudience: { kind: "room", ref: OTHER } });
function rig() {
  const inputs = new Map<string, PreparedRequestContextInput>(), contexts = new Map<string, RequestContextV1>(); let recovery: RequestContextRecoveryPointer | null = null, admin = true;
  const ports: RequestContextTurnPorts = { input: id => inputs.get(id) ?? null, context: id => contexts.get(id) ?? null,
    retain: c => { contexts.set(c.ref.contextId, structuredClone(c)); }, canManage: () => admin,
    recovery: () => recovery, saveRecovery: p => { recovery = p; } };
  const prepare = (id: string, c = context(), proof: PreparedRequestContextInput["proof"] = { kind: "independent" }, text = "synthetic input") => {
    inputs.set(id, { inputId: id, wireSha256: wireDigest(text), owner: { ...owner }, context: c, proof }); return wireDigest(text);
  };
  return { turns: new RequestContextLocalTurns(ports), ports, inputs, contexts, prepare, recovery: () => recovery, admin: (value: boolean) => { admin = value; } };
}
it("binds at the actual write, preserves immutable snapshots, and retries do not create another turn", () => {
  const r = rig(), digest = r.prepare("input"); expect(r.turns.current(owner)).toBeNull();
  const s = r.turns.beforeWrite("input", digest, owner);
  expect(r.turns.beforeWrite("input", digest, owner)).toBe(s); expect(Object.isFrozen(s.context.initiatingActor)).toBe(true);
  expect(r.turns.isCurrent(s, owner)).toBe(true); expect(r.recovery()?.contextId).toBe(ROOT);
});
it("neither typed history, a correlation-like key nor changed wire bytes selects a context", () => {
  const r = rig(), digest = r.prepare("owned-input");
  expect(() => r.turns.beforeWrite("quoted-history", digest, owner)).toThrow(/admitted input unavailable/);
  expect(() => r.turns.beforeWrite("owned-input", wireDigest("changed"), owner)).toThrow(/admitted input unavailable/);
  expect(r.turns.current(owner)).toBeNull();
});
it("an unrelated administrator or outside input queues while outside work owns the turn", () => {
  const r = rig(); r.turns.beforeWrite("outside", r.prepare("outside"), owner);
  const c = { ...context(), ref: { version: 1 as const, contextId: OTHER, rootContextId: OTHER }, ingress: "owner" as const };
  expect(() => r.turns.beforeWrite("admin", r.prepare("admin", c), owner)).toThrow(RequestContextInputDeferred);
  expect(() => r.turns.beforeWrite("outsider", r.prepare("outsider", c), owner)).toThrow(RequestContextInputDeferred);
  expect(r.turns.current(owner)?.context.ref.contextId).toBe(ROOT);
});
it("only a current permitted administrator steer joins; its identity never replaces the requester", () => {
  const r = rig(), s = r.turns.beforeWrite("outside", r.prepare("outside"), owner);
  const actor = { kind: "person" as const, platform: "discord" as const, userId: "demo-admin" };
  const digest = r.prepare("steer", context(), { kind: "admin-steer", activeToken: s.token, actor });
  r.admin(false); expect(() => r.turns.beforeWrite("steer", digest, owner)).toThrow(/permitted work/);
  r.admin(true); expect(r.turns.beforeWrite("steer", digest, owner)).toBe(s); expect(s.context.initiatingActor).toEqual(context().initiatingActor);
  r.turns.ended(s, owner); expect(() => r.turns.beforeWrite("steer", digest, owner)).toThrow(/permitted work/);
});
it("a Hub identity never becomes a managing administrator for steering", () => {
  const r = rig(), s = r.turns.beforeWrite("outside", r.prepare("outside"), owner);
  const digest = r.prepare("steer", context(), { kind: "admin-steer", activeToken: s.token,
    actor: { kind: "person", platform: "hub", hubId: "demo-hub", id: "demo-admin" } });
  expect(() => r.turns.beforeWrite("steer", digest, owner)).toThrow(/permitted work/);
});
it("a late exact return starts its own continuation; an ordinary history reply cannot borrow it", () => {
  const r = rig(), s = r.turns.beforeWrite("first", r.prepare("first"), owner); r.turns.ended(s, owner);
  const child: RequestContextV1 = { ...context(), ref: { version: 1, contextId: CHILD, rootContextId: ROOT, parentContextId: ROOT } };
  const sender = { kind: "peer" as const, instance: "peer", incarnation: "peer-generation" };
  const proof = { kind: "expected-return" as const, parentContextId: ROOT, expectedSender: sender, actualSender: sender };
  const digest = r.prepare("return", child, proof); const resumed = r.turns.beforeWrite("return", digest, owner);
  expect(resumed.context.ref.rootContextId).toBe(ROOT); expect(resumed.token).not.toBe(s.token); r.turns.ended(resumed, owner);
  expect(() => r.turns.beforeWrite("history-reply", r.prepare("history-reply", child), owner)).toThrow(/new root/);
});
it.each(["sender", "parent", "actor", "audience"])("a mapped return rechecks its %s proof", bad => {
  const r = rig(); r.contexts.set(ROOT, context());
  const child = { ...context(), ref: { version: 1 as const, contextId: CHILD, rootContextId: ROOT, parentContextId: ROOT } } as any;
  const sender = { kind: "peer" as const, instance: "peer", incarnation: "peer-generation" };
  const proof = { kind: "expected-return" as const, parentContextId: bad === "parent" ? OTHER : ROOT, expectedSender: sender,
    actualSender: bad === "sender" ? { ...sender, incarnation: "replacement" } : sender };
  if (bad === "actor") child.initiatingActor = { kind: "unknown", reason: "unidentified" };
  if (bad === "audience") child.sourceAudience.ref = CHILD;
  expect(() => r.turns.beforeWrite("return", r.prepare("return", child, proof), owner)).toThrow(); expect(r.turns.current(owner)).toBeNull();
});
it("mapped recovery preserves the exact root, without reviving the earlier active turn", () => {
  const r = rig(), s = r.turns.beforeWrite("first", r.prepare("first"), owner); r.turns.ended(s, owner);
  const digest = r.prepare("recovery-job", context(), { kind: "recovery", parentContextId: ROOT });
  const next = r.turns.beforeWrite("recovery-job", digest, owner); expect(next.context.ref.rootContextId).toBe(ROOT); expect(next.token).not.toBe(s.token);
});
it("restart fallback keeps restrictions but creates an unknown distinct root with no causal release parent", () => {
  const r = rig(); r.turns.beforeWrite("outside", r.prepare("outside"), owner);
  const restarted = new RequestContextLocalTurns(r.ports), nextOwner = { ...owner, daemonBootId: "boot-2" };
  expect(restarted.current(nextOwner)).toBeNull();
  const next = restarted.beforeWrite(null, wireDigest("system recovery"), nextOwner);
  expect(next.context.ingress).toBe("restricted-room"); expect(next.context.initiatingActor).toEqual({ kind: "unknown", reason: "unproved-recovery" });
  expect(next.context.ref.rootContextId).not.toBe(ROOT); expect(next.context.ref.parentContextId).toBeUndefined(); expect(next.unprovedRecoveryFrom).toBe(ROOT);
});
it("an independent owner root ends fallback eligibility without rewriting earlier work", () => {
  const r = rig(), first = r.turns.beforeWrite("outside", r.prepare("outside"), owner); r.turns.ended(first, owner);
  const c = { ...context(), ref: { version: 1 as const, contextId: OTHER, rootContextId: OTHER }, ingress: "owner" as const };
  const next = r.turns.beforeWrite("owner", r.prepare("owner", c), owner); r.turns.ended(next, owner);
  expect(r.recovery()).toBeNull(); expect(r.contexts.get(ROOT)).toEqual(context());
  expect(() => r.turns.beforeWrite(null, wireDigest("unmapped resume"), owner)).toThrow(/no trustworthy parent/);
});
it.each(["daemonBootId", "incarnation", "workGeneration", "spawnGeneration", "launchFenceEpoch", "deliveryEpoch"] as const)("a changed %s retires active ownership and cannot validate an old snapshot", key => {
  const r = rig(), s = r.turns.beforeWrite("input", r.prepare("input"), owner);
  const changed = { ...owner, [key]: typeof owner[key] === "number" ? Number(owner[key]) + 1 : "replacement" };
  expect(r.turns.isCurrent(s, changed)).toBe(false); expect(r.turns.current(changed)).toBeNull();
  expect(r.turns.ended(s, changed)).toBe(false);
});
it("unproved recovery cannot cross a work generation or incarnation, or borrow an active approval", () => {
  const r = rig(); r.turns.beforeWrite("outside", r.prepare("outside"), owner);
  expect(() => r.turns.beforeWrite(null, wireDigest("unknown"), owner)).toThrow(RequestContextInputDeferred);
  r.turns.fence(); expect(() => r.turns.beforeWrite(null, wireDigest("unknown"), { ...owner, workGeneration: "new-session" })).toThrow(/no trustworthy parent/);
});
it("an already prepared input cannot move into another daemon boot before its first paste", () => {
  const r = rig(), digest = r.prepare("prepared");
  expect(() => r.turns.beforeWrite("prepared", digest, { ...owner, daemonBootId: "replacement" })).toThrow(/prepared input owner changed/);
  expect(r.turns.current(owner)).toBeNull();
});
it("an owned recovery job keeps its captured parent even after an unrelated administrator request", () => {
  const r = rig(), original = r.turns.beforeWrite("outside", r.prepare("outside"), owner); r.turns.ended(original, owner);
  const c = { ...context(), ref: { version: 1 as const, contextId: OTHER, rootContextId: OTHER }, ingress: "owner" as const };
  const independent = r.turns.beforeWrite("admin", r.prepare("admin", c), owner); r.turns.ended(independent, owner);
  expect(r.recovery()).toBeNull();
  const resumed = r.turns.beforeRecoveryWrite("owned-job", wireDigest("recovery prompt"), owner, original);
  expect(resumed.context.ref.rootContextId).toBe(ROOT); expect(resumed.token).not.toBe(original.token);
});
it("only an initiating person's registered expected answer joins, independent of display-name changes", () => {
  const r = rig(); r.contexts.set(ROOT, context());
  const child = { ...context(), ref: { version: 1 as const, contextId: CHILD, rootContextId: ROOT, parentContextId: ROOT } };
  const expected = { kind: "person" as const, platform: "discord" as const, userId: "demo-person", displayName: "Earlier name" };
  const actual = { ...expected, displayName: "Current name" };
  const digest = r.prepare("answer", child, { kind: "expected-return", parentContextId: ROOT, expectedSender: expected, actualSender: actual });
  const bound = r.turns.beforeWrite("answer", digest, owner); expect(bound.context.initiatingActor).toEqual(context().initiatingActor); r.turns.ended(bound, owner);
  const other = { ...actual, userId: "another-person" };
  expect(() => r.turns.beforeWrite("other", r.prepare("other", child, { kind: "expected-return", parentContextId: ROOT,
    expectedSender: other, actualSender: other }), owner)).toThrow(/not from the initiating actor/);
});
it.each([{ kind: "future-proof" }, { kind: "recovery", parentContextIds: [ROOT, OTHER] }, { kind: "independent", authority: "owner" }])("unknown or multi-parent input proof refuses before retention %#", proof => {
  const r = rig(), digest = r.prepare("bad"); (r.inputs.get("bad") as any).proof = proof;
  expect(() => r.turns.beforeWrite("bad", digest, owner)).toThrow(); expect(r.contexts.size).toBe(0); expect(r.turns.current(owner)).toBeNull();
});
it("an idle administrator steer needs explicit mapped work and rechecks the role without replacing its origin", () => {
  const r = rig(), original = r.turns.beforeWrite("outside", r.prepare("outside"), owner); r.turns.ended(original, owner);
  const actor = { kind: "person" as const, platform: "discord" as const, userId: "demo-admin" };
  const digest = r.prepare("mapped-steer", context(), { kind: "admin-steer", parentContextId: ROOT, actor });
  r.admin(false); expect(() => r.turns.beforeWrite("mapped-steer", digest, owner)).toThrow(/permitted work/);
  r.admin(true); const bound = r.turns.beforeWrite("mapped-steer", digest, owner);
  expect(bound.context.ref.rootContextId).toBe(ROOT); expect(bound.context.initiatingActor).toEqual(context().initiatingActor);
});
it("a stale completion with its captured old owner cannot retire a newer binding", () => {
  const r = rig(), old = r.turns.beforeWrite("first", r.prepare("first"), owner);
  const newerOwner = { ...owner, spawnGeneration: owner.spawnGeneration + 1 };
  const c = { ...context(), ref: { version: 1 as const, contextId: OTHER, rootContextId: OTHER } };
  const digest = r.prepare("next", c); r.inputs.get("next")!.owner = newerOwner;
  const current = r.turns.beforeWrite("next", digest, newerOwner);
  expect(r.turns.ended(old, owner)).toBe(false); expect(r.turns.current(newerOwner)).toBe(current);
});
