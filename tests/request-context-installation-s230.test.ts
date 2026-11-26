import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { RequestContextPublication, readRequestContextInstallation } from "../src/request-context-installation.js";
import { requestContextGoBackAllowed } from "../src/request-context-activation.js";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function rig() {
  const home = mkdtempSync(join(tmpdir(), "installation-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "outbox.db"), box = new DeliveryOutbox(path, "fixture-boot", { requestContextDispatchVersion: 1 });
  cleanup.push(() => box.close()); const store = box.requestContextInstallation(); let current = true;
  const owner = { owner: "fleet-fixture", current: () => current };
  const record = { epoch: "epoch-1", owner: owner.owner, activatedAt: 2000, invalidates: ["20261126T010203Z-0a1b2c3d"], offeredLatestDeadline: 9000 };
  const lease = { current: () => current, release() {} };
  return { path, box, store, owner, record, lease, revoke: () => { current = false; },
    activate: () => store.activate(record, owner, lease, () => true, 0) };
}
it("default Off reads install no persistent artifacts and do not change legacy recovery", () => {
  const r = rig(); expect(r.store.read()).toBeNull(); expect(r.store.read()).toBeNull();
  const db = new Database(r.path, { readonly: true }); try {
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'request_context_%'").get()).toEqual({ n: 0 });
  } finally { db.close(); }
  expect(r.box.recoverForBoot("another-boot")).toEqual({ queued: 0, reconciliationPending: 0 });
});
it("one owning outbox transaction commits floor, activation history, mode and current epoch", () => {
  const r = rig(), state = r.activate();
  expect(state).toEqual({ owner: r.owner.owner, epoch: "epoch-1", revision: 1, mode: "active" });
  const db = new Database(r.path, { readonly: true }); try {
    expect(readRequestContextInstallation(db)).toEqual(state);
    expect(requestContextGoBackAllowed(db, r.record.invalidates[0]!, 99999)).toBe(false);
  } finally { db.close(); }
  expect(() => new DeliveryOutbox(r.path)).toThrow(/dispatch v1 required/);
});
it("failure after inserting mode rolls back mode, version floor and Go back invalidation together", () => {
  const r = rig(); let checks = 0;
  expect(() => r.store.activate(r.record, r.owner, r.lease, () => ++checks < 3, 0)).toThrow(/changed/);
  expect(r.store.read()).toBeNull();
  const db = new Database(r.path, { readonly: true }); try { expect(requestContextGoBackAllowed(db, r.record.invalidates[0]!, 0)).toBe(true); }
  finally { db.close(); }
});
it("a different owner or stale revision cannot drain or re-enable", () => {
  const r = rig(); r.activate();
  expect(() => r.store.beginOff(0, r.owner)).toThrow(/stale/);
  expect(() => r.store.beginOff(1, { owner: "another-fleet", current: () => true })).toThrow(/owner/);
  expect(() => r.store.activate({ ...r.record, epoch: "new" }, r.owner, r.lease, () => true, 1)).toThrow(/stale/);
  r.revoke(); expect(() => r.store.beginOff(1, r.owner)).toThrow(/owner/);
  expect(r.store.read()?.mode).toBe("active");
});
it("Off persists draining across restart and needs a current exact epoch/revision proof", () => {
  const r = rig(); r.activate(); const draining = r.store.beginOff(1, r.owner);
  expect(draining).toMatchObject({ mode: "draining", revision: 2 });
  const restarted = r.box.requestContextInstallation(); expect(restarted.read()).toEqual(draining);
  const proof = { epoch: draining.epoch, revision: 2, current: () => true };
  expect(() => restarted.finishOff(2, r.owner, { ...proof, epoch: "wrong" })).toThrow(/stale/);
  expect(() => restarted.finishOff(2, r.owner, { ...proof, current: () => false })).toThrow(/work/);
  expect(restarted.finishOff(2, r.owner, proof)).toMatchObject({ mode: "off", revision: 3 });
  expect(() => restarted.finishOff(2, r.owner, proof)).toThrow(/stale/);
  expect(() => new DeliveryOutbox(r.path)).toThrow(/dispatch v1 required/);
});
it("a drain participant changing at the final transaction check leaves durable draining", () => {
  const r = rig(); r.activate(); r.store.beginOff(1, r.owner); let checks = 0;
  expect(() => r.store.finishOff(2, r.owner, { epoch: "epoch-1", revision: 2, current: () => ++checks === 1 })).toThrow(/work/);
  expect(r.store.read()).toMatchObject({ mode: "draining", revision: 2 });
});
it("failed installation then a new boot can complete Off using independent durable assessment", () => {
  const r = rig(); r.activate(); // No runtime publication or call/launch registry was ever installed.
  const restarted = r.box.requestContextInstallation(); restarted.beginOff(1, r.owner);
  expect(restarted.finishOff(2, r.owner, { epoch: "epoch-1", revision: 2, current: () => true }).mode).toBe("off");
});
it("a capable bridge re-enables only from drained Off with a fresh atomic epoch", () => {
  const r = rig(); r.activate(); r.store.beginOff(1, r.owner);
  r.store.finishOff(2, r.owner, { epoch: "epoch-1", revision: 2, current: () => true });
  expect(() => r.store.activate({ ...r.record, epoch: "epoch-other", owner: "another-fleet" }, { owner: "another-fleet", current: () => true }, r.lease, () => true, 3)).toThrow(/owner/);
  expect(r.store.activate({ ...r.record, epoch: "epoch-2" }, r.owner, r.lease, () => true, 3)).toMatchObject({ epoch: "epoch-2", mode: "active", revision: 4 });
});
it("producer arrival and role/capability loss invalidate preparation; durable activation never falls back to legacy", () => {
  const r = rig(), publication = new RequestContextPublication(r.owner, false); expect(publication.capture()).toBeNull();
  const old = publication.fence(); expect(publication.ingressAvailable()).toBe(false); const state = r.activate();
  expect(() => publication.publish(state, {}, old, () => true, () => r.store.read())).toThrow(/changed/);
  expect(() => publication.abandon(old, () => r.store.read())).toThrow(); expect(() => publication.capture()).toThrow(/fenced/);
  const next = publication.fence(); let ready = true;
  publication.publish(state, {}, next, () => ready, () => r.store.read()); expect(publication.capture()?.current()).toBe(true);
  ready = false; expect(publication.ingressAvailable()).toBe(false); expect(() => publication.capture()).toThrow(/fenced/);
});
it("draining stops new input but preserves exact execution; completed Off retires the old execution reference", () => {
  const r = rig(), state = r.activate(), ports = {}, publication = new RequestContextPublication(r.owner, true);
  expect(() => publication.capture()).toThrow(/fenced/); expect(publication.installed()).toBe(false);
  publication.publish(state, ports, publication.fence(), () => true, () => r.store.read());
  const active = publication.capture()!; expect(publication.installed()).toBe(true); expect(Object.isFrozen(active.ports)).toBe(true); const fence = publication.fence();
  expect(active.current()).toBe(false); expect(publication.installed()).toBe(false); expect(active.executionCurrent()).toBe(true);
  const draining = r.store.beginOff(1, r.owner); publication.publish(draining, ports, fence, () => true, () => r.store.read());
  expect(active.current()).toBe(false); expect(active.executionCurrent()).toBe(true);
  const offFence = publication.fence(), off = r.store.finishOff(2, r.owner, { epoch: "epoch-1", revision: 2, current: () => true });
  publication.publish(off, ports, offFence, () => true, () => r.store.read());
  expect(active.executionCurrent()).toBe(false); expect(publication.capture()?.state.mode).toBe("off");
  r.revoke(); expect(() => publication.capture()).toThrow(/fenced/);
});
it("only a never-activated preparation may resume legacy, and a stale proof cannot publish", () => {
  const r = rig(), publication = new RequestContextPublication(r.owner, false), first = publication.fence(), next = publication.fence();
  expect(first.current()).toBe(false); publication.abandon(next, () => r.store.read()); expect(publication.capture()).toBeNull();
});

it("an activated outbox validates its durable state and owned fence before opening or recovering", () => {
  const r = rig(); r.activate();
  expect(() => new DeliveryOutbox(r.path, "new-boot", { requestContextDispatchVersion: 1 })).toThrow(/owned admission fence/);
  let held = true; const fresh = new DeliveryOutbox(r.path, "new-boot", { requestContextDispatchVersion: 1, requestContextRecoveryFence: () => held });
  cleanup.push(() => fresh.close());
  expect(fresh.recoverForBoot("new-boot")).toEqual({ queued: 0, reconciliationPending: 0 });
  held = false; expect(() => fresh.recoverForBoot("newer-boot")).toThrow(/owned admission fence/);
});
it("partial activation metadata is rejected before a capable constructor can initialize it", () => {
  const r = rig(); r.activate(); const db = new Database(r.path);
  try { db.exec("DROP TABLE request_context_installation_v1"); } finally { db.close(); }
  expect(() => new DeliveryOutbox(r.path, "new-boot", { requestContextDispatchVersion: 1, requestContextRecoveryFence: () => true })).toThrow(/unavailable/);
});

it("losing the recovery fence at COMMIT does not reset any durable delivery", () => {
  const r = rig(); const delivery = r.box.admit({ operationId: "fixture-recovery", sourceKey: "fixture-recovery", sourceInstance: "source",
    sourceDaemonBootId: "source-boot", targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "fixture" } }).delivery;
  r.box.claimNext("old-boot", () => "worker-boot", new Set()); r.activate();
  let checks = 0, fail = false;
  const fresh = new DeliveryOutbox(r.path, "new-boot", { requestContextDispatchVersion: 1, requestContextRecoveryFence: () => !fail || ++checks === 1 });
  cleanup.push(() => fresh.close()); fail = true;
  expect(() => fresh.recoverForBoot("new-boot")).toThrow(/owned admission fence/);
  expect(fresh.get(delivery.deliveryId)).toMatchObject({ state: "delivering", managerBootId: "old-boot" });
});
