/** Shared production Core/store entry points, real SQL and explicitly held directory work. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createHubDirectoryAdmission } from "../src/hub/directory/admission.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration, HubGroupReadOverload } from "../src/hub/group-policy/store.js";
import { HubCore } from "../src/hub/http/core.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";

const owned: Awaited<ReturnType<typeof s3bRig>>[] = [];
afterEach(async () => { for (const r of owned.splice(0)) await r.close(); });
async function fixture() {
  const r = await s3bRig(); owned.push(r);
  const reads = createHubDirectoryAdmission(() => true);
  Object.assign(r.httpDeps, { directoryReads: reads });
  HUB_AUDIT_MIGRATION.up(r.db); groupPolicyMigration(r.hubId, "corp", "g1").up(r.db);
  const audit = createHubAudit({ db: r.db, contentKey: randomBytes(32) });
  const store = createHubGroupPolicyStore({ db: r.db, hubId: r.hubId, realm: "corp", generation: "g1",
    directory: r.directory, audit, current: () => true, reads } as Parameters<typeof createHubGroupPolicyStore>[0]);
  const core = new HubCore(r.httpDeps, r.sql);
  return { ...r, reads, policy: store, core };
}
describe("S129 shared physical directory admission", () => {
  it("shares a person's four slots between policy reads and HTTP eligibility", async () => {
    const r = await fixture(), release: (() => void)[] = [], check = vi.spyOn(r.directory, "checkEligibility");
    const pending = Array.from({ length: 4 }, () => r.policy.withDirectoryRead(r.admin, () => new Promise<void>(resolve => release.push(resolve))));
    try {
      await expect(r.core.current(r.admin)).rejects.toMatchObject({ code: "backpressure" });
      expect(check).not.toHaveBeenCalled();
    } finally { release.forEach(resolve => resolve()); await Promise.allSettled(pending); }
    expect(await r.core.current(r.admin)).not.toBeNull();
  });
  it("shares all 32 slots between person reads and an unsigned-in owner lookup", async () => {
    const r = await fixture(), release: (() => void)[] = [];
    const lookup = vi.fn(async () => ({ ok: false as const, reason: "unavailable" as const })); r.directory.lookupForPairing = lookup;
    const pending = Array.from({ length: 32 }, (_, i) => r.policy.withDirectoryRead({ realm: "corp", objectId: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111` }, () => new Promise<void>(resolve => release.push(resolve))));
    try {
      await expect(r.core.lookupPairingOwner("unsigned" )).rejects.toMatchObject({ code: "backpressure" });
      expect(lookup).not.toHaveBeenCalled();
    } finally { release.forEach(resolve => resolve()); await Promise.allSettled(pending); }
    await expect(r.core.lookupPairingOwner("unsigned")).rejects.toMatchObject({ code: "unavailable" });
    expect(lookup).toHaveBeenCalledOnce();
  });
  it("keeps admission until physical-close settlement and drains a fenced owner only afterwards", async () => {
    const reads = createHubDirectoryAdmission(() => true), release: (() => void)[] = [];
    let ready!: () => void, close!: () => void;
    const started = new Promise<void>(resolve => ready = resolve), physical = new Promise<void>(resolve => close = resolve);
    const first = reads.withDirectoryRead({ realm: "corp", objectId: "11111111-1111-4111-8111-111111111111" }, async () => { ready(); await physical; });
    const settled = first.catch(error => error); await started;
    const other = Array.from({ length: 3 }, () => reads.withDirectoryRead({ realm: "corp", objectId: "11111111-1111-4111-8111-111111111111" }, () => new Promise<void>(resolve => release.push(resolve))));
    let draining: Promise<void> | undefined;
    try {
      await expect(reads.withDirectoryRead({ realm: "corp", objectId: "11111111-1111-4111-8111-111111111111" }, async () => {})).rejects.toBeInstanceOf(HubGroupReadOverload);
      reads.fence();
      await expect(reads.withLoginRead("new", async () => {})).rejects.toThrow("unavailable");
      let drained = false; draining = reads.drain().then(() => { drained = true; });
      release.forEach(resolve => resolve()); await Promise.allSettled(other); expect(drained).toBe(false);
      close(); await draining; expect(drained).toBe(true); expect(await settled).toBeUndefined();
    } finally { close(); release.forEach(resolve => resolve()); await Promise.allSettled([settled, ...other, ...(draining ? [draining] : [])]); }
  });
  it("normalizes login case, keeps namespaces distinct and frees rejected work", async () => {
    const reads = createHubDirectoryAdmission(() => true), release: (() => void)[] = [];
    const pending = Array.from({ length: 4 }, () => reads.withLoginRead("ALICE", () => new Promise<void>(resolve => release.push(resolve))));
    try {
      await expect(reads.withLoginRead("alice", async () => {})).rejects.toBeInstanceOf(HubGroupReadOverload);
      await expect(reads.withDirectoryRead({ realm: "corp", objectId: "11111111-1111-4111-8111-111111111111" }, async () => 1)).resolves.toBe(1);
    } finally { release.forEach(resolve => resolve()); await Promise.allSettled(pending); }
    await expect(reads.withLoginRead("alice", async () => { throw Error("fixture physical failure"); })).rejects.toThrow("fixture physical failure");
    await expect(reads.withLoginRead("alice", async () => "released")).resolves.toBe("released");
    await reads.drain();
  });
});
