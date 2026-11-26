import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { RequestContextReadiness, type RequestContextReadinessSnapshot } from "../src/request-context-readiness.js";

const close: Array<() => void> = [];
const REQUIRED_PORTS = ["input", "turn", "calls", "policy", "drain", "transport", "contacts", "relay", "instructions"] as const;
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); });
function rig() {
  const home = mkdtempSync(join(tmpdir(), "request-readiness-")); close.push(() => rmSync(home, { recursive: true, force: true }));
  const box = new DeliveryOutbox(join(home, "outbox.db")); close.push(() => box.close());
  let owner: string | null = "fleet-fixture";
  const shadow = box.requestContextMigrationShadow({ owner: () => owner, policyEpoch: () => "policy-fixture",
    generation: id => `${id}-generation`, canManage: () => true });
  const raw: RequestContextReadinessSnapshot = { owner, lease: "exclusive-lease", revision: "owners-1", shadow: shadow.inspect(),
    requiredOwners: ["daemon:worker"], owners: [{ id: "daemon:worker", generation: "worker-generation", revision: "runtime-1",
      ports: Object.fromEntries(REQUIRED_PORTS.map(port => [port, true])) }],
    requiredPeers: ["runtime:fixture"], peers: [{ id: "runtime:fixture", generation: "peer-1", connected: true, requestContextVersion: 1 }] };
  let unavailable = false;
  const readiness = new RequestContextReadiness(() => {
    if (unavailable) throw Error("owner unavailable");
    return { ...structuredClone(raw), owner, shadow: shadow.inspect() };
  });
  return { box, raw, readiness, owner: (value: string | null) => { owner = value; }, unavailable: () => { unavailable = true; } };
}
it("a complete real migration shadow and every installed owner/peer produce a current read-only proof", () => {
  const r = rig();
  const before = r.box.requestContextMigrationShadow({ owner: () => "fleet-fixture", policyEpoch: () => "policy-fixture",
    generation: () => null, canManage: () => false }).inspect();
  const proof = r.readiness.prove(); expect(proof.current()).toBe(true);
  expect(r.readiness.inspect().blocked).toEqual([]);
  expect(r.box.requestContextMigrationShadow({ owner: () => "fleet-fixture", policyEpoch: () => "policy-fixture",
    generation: () => null, canManage: () => false }).inspect().sha256).toBe(before.sha256);
  // The legacy connection can still reopen: preflight has not installed a dispatch barrier.
  expect(() => r.box.recoverForBoot("fixture-next-boot")).not.toThrow();
});
it.each(REQUIRED_PORTS)("the whole cutover stays blocked when %s is not installed", port => {
  const r = rig(); r.raw.owners = [{ ...r.raw.owners[0]!, ports: { ...r.raw.owners[0]!.ports, [port]: false } }];
  expect(r.readiness.inspect()).toMatchObject({ ready: false, blocked: ["owners"] });
  expect(() => r.readiness.prove()).toThrow(/blocked/);
});
it.each(["missing", "extra", "duplicate"])("a %s owner cannot be treated as an empty participant", bad => {
  const r = rig();
  r.raw.owners = bad === "missing" ? [] : bad === "extra" ? [...r.raw.owners, { ...r.raw.owners[0]!, id: "daemon:unlisted" }] : [...r.raw.owners, r.raw.owners[0]!];
  expect(r.readiness.inspect().blocked).toContain("owners");
});
it.each(["offline", "old", "omitted", "duplicate"])("a %s configured peer prevents activation", bad => {
  const r = rig();
  if (bad === "omitted") r.raw.peers = [];
  else if (bad === "duplicate") r.raw.peers = [...r.raw.peers, r.raw.peers[0]!];
  else r.raw.peers = [{ ...r.raw.peers[0]!, connected: bad !== "offline", requestContextVersion: bad === "old" ? 0 : 1 }];
  expect(r.readiness.inspect().blocked).toContain("peers");
});
it("an unresolved legacy hold prevents activation without replay, expiry or normalization", () => {
  const r = rig();
  const ticket = r.box.contactAuthorizations.hold({ operationId: randomUUID(), source: "source", target: "target",
    sourceGeneration: "source-generation", targetGeneration: "target-generation", verb: "send_to_instance",
    origin: { kind: "unknown", people: [], receiptIds: [], chain: [] }, message: "Synthetic message",
    correlationId: randomUUID(), resultRecipient: "source", payload: { type: "fleet_inbound", content: "Synthetic message" } });
  expect(r.readiness.inspect()).toMatchObject({ ready: false, blocked: ["legacy"] });
  expect(r.box.contactAuthorizations.get(ticket.id)?.state).toBe("pending");
  expect(r.box.listPending()).toEqual([]);
});
it.each(["lease", "generation", "membership", "role-revision", "peer-generation", "owner-lost", "unavailable"])(
  "a %s change invalidates a previously ready proof", change => {
    const r = rig(), proof = r.readiness.prove();
    if (change === "lease") r.raw.lease = "new-exclusive-lease";
    if (change === "generation") r.raw.owners = [{ ...r.raw.owners[0]!, generation: "worker-replaced" }];
    if (change === "membership") r.raw.requiredOwners = [...r.raw.requiredOwners, "daemon:new-worker"];
    if (change === "role-revision") r.raw.revision = "roles-changed";
    if (change === "peer-generation") r.raw.peers = [{ ...r.raw.peers[0]!, generation: "new-peer" }];
    if (change === "owner-lost") r.owner(null);
    if (change === "unavailable") r.unavailable();
    expect(proof.current()).toBe(false);
  });
it("a partial or forged shadow cannot supply a readiness proof", () => {
  const r = rig();
  for (const patch of [{ complete: false }, { nextCursor: { tickets: "more" } }, { readOnly: false }, { owner: "someone-else" }, { sha256: "0".repeat(64) }]) {
    const bad = new RequestContextReadiness(() => ({ ...r.raw, shadow: { ...r.raw.shadow, ...patch } as any }));
    expect(bad.inspect().blocked).toContain("legacy");
  }
});
