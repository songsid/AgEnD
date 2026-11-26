import { expect, it } from "vitest";
import { RequestContextInputs } from "../src/request-context-inputs.js";
import { RequestContextLocalTurns, type RequestContextRuntimeOwner } from "../src/request-context-turns.js";
import type { RequestContextV1 } from "../src/request-context-protocol.js";
import { requestContextDigest } from "../src/request-context-store.js";

const ROOT = "00000000-0000-4000-8000-000000000001";
const owner: RequestContextRuntimeOwner = { instance: "worker", incarnation: "incarnation", workGeneration: "work",
  daemonBootId: "boot", spawnGeneration: 1, launchFenceEpoch: 0, deliveryEpoch: 0 };
const context = (): RequestContextV1 => ({ ref: { version: 1, contextId: ROOT, rootContextId: ROOT },
  source: { instance: "worker", incarnation: "incarnation" }, rootEvidenceRef: "fixture-receipt",
  initiatingActor: { kind: "person", platform: "discord", userId: "demo-person" }, ingress: "restricted-room",
  sourceAudience: { kind: "room", ref: ROOT } });
function rig(capacity = 2) {
  let current = true, fenced = false;
  const registration = { assertRegistration() { if (fenced) throw Error("root fenced"); } };
  const inputs = new RequestContextInputs(registration, capacity);
  const contexts = new Map<string, RequestContextV1>();
  const turns = new RequestContextLocalTurns({ registration,
    input: (id, wireSha256, runtimeOwner) => inputs.prepare(id, wireSha256, runtimeOwner),
    context: id => contexts.get(id) ?? null, retain: value => { contexts.set(value.ref.contextId, value); },
    canManage: () => false, recovery: () => null, saveRecovery: () => {} });
  const register = (id: string, value = context()) => inputs.register(id, { context: value, proof: { kind: "independent" },
    current: captured => current && captured.daemonBootId === owner.daemonBootId });
  return { inputs, turns, register, current: (v: boolean) => { current = v; }, fence: () => { fenced = true; } };
}
it("prepares the exact final formatted input inside C and never substitutes the raw body digest", () => {
  const r = rig(); r.register("human:fixture");
  const final = requestContextDigest("[escaped verified presentation]\nSynthetic question");
  const snapshot = r.turns.beforeWrite("human:fixture", final, owner);
  expect(snapshot.wireSha256).toBe(final);
  expect(snapshot.context.initiatingActor).toEqual(context().initiatingActor);
  expect(r.turns.beforeWrite("human:fixture", final, owner)).toBe(snapshot);
  expect(() => r.turns.beforeWrite("human:fixture", requestContextDigest("Synthetic question"), owner)).toThrow(/changed during retry/);
  expect(r.turns.isCurrent(snapshot, owner)).toBe(true);
});
it("an admitted input is immutable and is checked again before every retry", () => {
  const r = rig(), value = context(); r.register("human:fixture", value);
  (value as any).initiatingActor.userId = "forged";
  const wire = requestContextDigest("final");
  const prepared = r.inputs.prepare("human:fixture", wire, owner)!;
  expect(prepared.context?.initiatingActor).toEqual(context().initiatingActor);
  expect(Object.isFrozen(prepared.owner)).toBe(true);
  r.current(false);
  expect(() => r.turns.beforeWrite("human:fixture", wire, owner)).toThrow(/no longer current/);
});
it.each(["incarnation", "workGeneration", "daemonBootId", "spawnGeneration", "launchFenceEpoch", "deliveryEpoch"] as const)(
  "a prepared retry cannot acquire a later %s", key => {
    const r = rig(); r.register("human:fixture"); const wire = requestContextDigest("final");
    r.inputs.prepare("human:fixture", wire, owner);
    const changed = { ...owner, [key]: typeof owner[key] === "number" ? Number(owner[key]) + 1 : `${owner[key]}-new` };
    expect(() => r.inputs.prepare("human:fixture", wire, changed)).toThrow(/no longer current|changed during retry/);
  });
it("unregistered body/history/correlation keys cannot prepare input", () => {
  const r = rig();
  expect(() => r.turns.beforeWrite("quoted-history", requestContextDigest("body"), owner)).toThrow(/admitted input unavailable/);
  expect(r.turns.current(owner)).toBeNull();
});
it("the receipt owner can verify its persisted final wire digest before C binds anything", () => {
  const r = rig(), wire = requestContextDigest("persisted formatted receipt");
  r.inputs.register("human:bound", { context: context(), proof: { kind: "independent" },
    current: (_owner, actualWire) => actualWire === wire });
  expect(() => r.turns.beforeWrite("human:bound", requestContextDigest("substituted text"), owner)).toThrow(/no longer current/);
  expect(r.turns.current(owner)).toBeNull();
  expect(r.turns.beforeWrite("human:bound", wire, owner).wireSha256).toBe(wire);
});
it("pending inputs are real drain references until their owning admission retires them", () => {
  const r = rig(), before = r.inputs.drainRevision, release = r.register("human:fixture");
  expect(r.inputs.drainView(ROOT).references).toEqual(["input:human:fixture"]);
  const registered = r.inputs.drainRevision;
  expect(registered).not.toBe(before);
  r.inputs.prepare("human:fixture", requestContextDigest("final"), owner);
  expect(r.inputs.drainRevision).not.toBe(registered);
  release();
  expect(r.inputs.drainView(ROOT).references).toEqual([]);
  expect(r.inputs.prepare("human:fixture", requestContextDigest("final"), owner)).toBeNull();
});
it("a fenced root cannot register or acquire a prepared input", () => {
  const r = rig(); r.register("first"); r.fence();
  expect(() => r.register("second")).toThrow(/fenced/);
  expect(() => r.inputs.prepare("first", requestContextDigest("final"), owner)).toThrow(/fenced/);
  expect(r.inputs.drainView(ROOT).references).toEqual(["input:first"]);
});
it("the bound rejects replacement and recovers capacity only when the owning registration retires", () => {
  const r = rig(1), release = r.register("first");
  expect(() => r.register("first")).toThrow(/already registered/);
  expect(() => r.register("second")).toThrow(/backlog/);
  release(); r.register("first"); release();
  expect(r.inputs.drainView(ROOT).references).toEqual(["input:first"]);
});
