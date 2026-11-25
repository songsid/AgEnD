import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { RequestContextLocalTurns, type PreparedRequestContextInput, type RequestContextRuntimeOwner } from "../src/request-context-turns.js";
import { deliveryContentDigest as wireDigest } from "../src/delivery-outbox.js";
import type { RequestContextV1 } from "../src/request-context-protocol.js";
const ROOT = "00000000-0000-4000-8000-000000000001", AUDIENCE = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [], boxes: DeliveryOutbox[] = [];
afterEach(() => { for (const box of boxes.splice(0)) box.close(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function file() { const path = mkdtempSync(join(tmpdir(), "request-recovery-")); roots.push(path); return join(path, "outbox.db"); }
function open(path: string, active = true) { const box = new DeliveryOutbox(path, "manager", { requestContextDispatchVersion: active ? 1 : 0 }); boxes.push(box); if (active) box.activateRequestContextBarrier(); return box; }
const owner: RequestContextRuntimeOwner = { instance: "worker", incarnation: "worker-generation", workGeneration: "session-1", daemonBootId: "boot-1", spawnGeneration: 1, launchFenceEpoch: 0, deliveryEpoch: 0 };
const context: RequestContextV1 = { ref: { version: 1, contextId: ROOT, rootContextId: ROOT }, rootEvidenceRef: "accepted-fixture",
  initiatingActor: { kind: "person", platform: "discord", userId: "demo-person" }, ingress: "restricted-room", source: { instance: "worker", incarnation: "worker-generation" }, sourceAudience: { kind: "room", ref: AUDIENCE } };
it("a fresh coordinator reads only the durable scope pointer, never a restored active turn or D1 parent", () => {
  const path = file(), first = open(path);
  const inputs = new Map<string, PreparedRequestContextInput>([["human:fixture", { inputId: "human:fixture", owner, wireSha256: wireDigest("synthetic"), context, proof: { kind: "independent" } }]]);
  const tracker = new RequestContextLocalTurns(first.requestContextRecovery.ports("worker", id => inputs.get(id) ?? null, () => true));
  tracker.beforeWrite("human:fixture", wireDigest("synthetic"), owner);
  const restartedStore = open(path).requestContextRecovery;
  const restarted = new RequestContextLocalTurns(restartedStore.ports("worker", () => null, () => true));
  const nextOwner = { ...owner, daemonBootId: "new-boot" };
  expect(restarted.current(nextOwner)).toBeNull();
  const next = restarted.beforeWrite(null, wireDigest("unmapped resume"), nextOwner);
  expect(next.context.ref.rootContextId).not.toBe(ROOT); expect(next.context.ref.parentContextId).toBeUndefined(); expect(next.context.initiatingActor.kind).toBe("unknown");
  expect(restartedStore.pointer("worker")?.contextId).toBe(next.context.ref.contextId);
  expect(first.requestContext(ROOT)).toEqual(context);
});
it("OFF cannot create root or recovery persistence", () => {
  const box = open(file(), false); expect(box.requestContextRecovery.pointer("worker")).toBeNull();
  expect(() => box.requestContextRecovery.retain(context)).toThrow(/not ready/);
  expect(() => box.requestContextRecovery.save("worker", null)).toThrow(/not ready/);
  expect(box.requestContext(ROOT)).toBeNull();
});
it("a pointer cannot name another instance, owner work, or a missing context", () => {
  const box = open(file()), store = box.requestContextRecovery; store.retain(context);
  for (const pointer of [{ instance: "other", incarnation: owner.incarnation, workGeneration: owner.workGeneration, contextId: ROOT },
    { instance: "worker", incarnation: "replacement", workGeneration: owner.workGeneration, contextId: ROOT },
    { instance: "worker", incarnation: owner.incarnation, workGeneration: owner.workGeneration, contextId: AUDIENCE }]) {
    expect(() => store.save("worker", pointer)).toThrow(/mismatch/);
  }
  expect(store.pointer("worker")).toBeNull();
});
