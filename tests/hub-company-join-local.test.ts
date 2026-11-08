/** Local cancellation and strict profile/journal settlement must win independently of the short Settings transaction. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { CompanyJoinController } from "../src/hub/join/local.js";
import { readLocalJoin } from "../src/hub/join/local-journal.js";
import { currentBinding } from "../src/hub/member/pairing-api.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { companyIdentityDigest } from "../src/hub/join/protocol.js";
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of homes.splice(0)) rmSync(p, { force: true, recursive: true }); });
const home = () => { const p = mkdtempSync(join(tmpdir(), "agend-local-join-")); chmodSync(p, 0o700); homes.push(p); return p; };
async function world() {
  const directory = home(), hubHome = home(), identity = await provisionHubIdentity({ home: hubHome, memberOrigin: "https://hub.example.test:9443" });
  const { hubId, spkiSha256, issuerPublicKey } = identity;
  const hub = { hubId, spkiSha256, issuerPublicKey, memberOrigin: "https://hub.example.test:9443", webOrigin: "https://hub.example.test" };
  const metadata = { v: 1 as const, hub, identityDigest: companyIdentityDigest(hub), certificatePem: readFileSync(join(hubHome, "hub/keys/tls-cert.pem"), "utf8"), features: ["company-join-v1"] };
  let alive = true, confirmed = true, stamp = "initial", enabled = false, remote = "pending", now = Date.now(), settleFailure = false;
  const owner = { realm: "corp", objectId: randomUUID() }, credential = "a".repeat(64), calls: string[] = [];
  const session = { ownerKey: {}, sessionId: "b".repeat(64), authorityEpoch: 1, hostHere: true, current: () => alive };
  const authority = { session, confirmedCurrent: () => confirmed };
  const client = { discover: vi.fn(async () => metadata), command: vi.fn(async (binding: any, purpose: string) => {
    calls.push(purpose);
    const status = { state: remote, reason: null, issued: ["issued", "acknowledged"].includes(remote), fleetId: remote === "pending" ? null : binding.fleetId,
      generation: remote === "pending" ? null : 1, outerDeadline: now + 600_000, redeemDeadline: now + 60_000, deliveryDeadline: now + 120_000 };
    if (purpose === "push") return { requestId: binding.requestId, expiresAt: now + 600_000, browserAction: hub.webOrigin + "/hub/join/open" };
    if (purpose === "redeem") { remote = "issued"; return { ...status, state: "issued", issued: true, fleetId: binding.fleetId, generation: 1, owner, credential, hub, certificatePem: metadata.certificatePem }; }
    if (purpose === "ack") { remote = "acknowledged"; return { ...status, state: remote }; }
    if (purpose === "cancel") { remote = "undeliverable"; return { ...status, state: remote }; }
    return status;
  }) };
  const activate = vi.fn();
  const options = { home: directory, client, now: () => now, schedule: false as const, snapshot: () => stamp,
    link: () => "offline" as const, activate,
    enableMembership: (current: () => boolean, accept: () => void) => { if (!current()) throw Error("lost"); if (settleFailure) throw Error("disk"); enabled = true; stamp = "enabled"; accept(); } };
  const controller = new CompanyJoinController(options);
  const start = () => controller.start({ address: hub.webOrigin, label: "My Fleet", fleetOrigin: "http://127.0.0.1:4444" }, authority);
  return { directory, metadata, calls, client, session, authority, controller, options, activate, start,
    ready: () => { remote = "identity-approved"; }, lose: () => { alive = false; }, deny: () => { confirmed = false; }, replace: () => { stamp = "replacement"; },
    diskFailure: (value: boolean) => { settleFailure = value; }, advance: (ms: number) => { now += ms; }, enabled: () => enabled };
}
describe("Fleet local company join", () => {
  it("saves the exact profile and journal before proof ACK, then activates once without exposing any secret", async () => {
    const w = await world(), pending = await w.start(); w.ready();
    const view = await w.controller.status(pending.operationId, w.session);
    expect(view).toMatchObject({ state: "saved", link: "offline" }); expect(w.enabled()).toBe(true);
    expect(w.calls).toEqual(["push", "status", "redeem", "ack"]); expect(w.activate).toHaveBeenCalledOnce();
    expect(currentBinding(w.directory)).toEqual({ hubId: w.metadata.hub.hubId });
    const journal = readLocalJoin(w.directory, pending.operationId); expect(journal.stage).toBe("active");
    expect(JSON.stringify(view)).not.toMatch(/credential|privateKey|verifier|stateHash|BEGIN PRIVATE/);
    expect(await w.controller.status(pending.operationId, w.session)).toMatchObject({ state: "saved" }); expect(w.activate).toHaveBeenCalledOnce();
  });
  it.each(["requester", "confirmer", "binding"])("a changed %s fences the original operation before credential persistence", async kind => {
    const w = await world(), pending = await w.start(); w.ready();
    if (kind === "requester") w.lose(); else if (kind === "confirmer") w.deny(); else w.replace();
    await w.controller.status(pending.operationId, w.session).catch(() => null);
    expect(w.calls).not.toContain("redeem"); expect(w.calls).not.toContain("ack"); expect(currentBinding(w.directory)).toBeNull(); expect(w.activate).not.toHaveBeenCalled();
  });
  it("a different cookie session cannot read, bridge or cancel an owned operation", async () => {
    const w = await world(), pending = await w.start(), other = { ...w.session, ownerKey: {}, sessionId: "c".repeat(64) };
    await expect(w.controller.status(pending.operationId, other)).rejects.toThrow();
    expect(() => w.controller.bridge(pending.operationId, other)).toThrow();
    await expect(w.controller.cancel(pending.operationId, other)).rejects.toThrow(); expect(w.calls).not.toContain("cancel");
  });
  it("profile saved but membership/journal failure remains held and unconnectable; exact recovery never enrolls twice", async () => {
    const w = await world(), pending = await w.start(); w.ready(); w.diskFailure(true);
    expect(await w.controller.status(pending.operationId, w.session)).toMatchObject({ state: "held" });
    expect(currentBinding(w.directory)).toBeNull(); expect(w.calls).not.toContain("ack"); expect(w.activate).not.toHaveBeenCalled();
    w.diskFailure(false); await w.controller.resume(pending.operationId, w.authority);
    expect(await w.controller.status(pending.operationId, w.session)).toMatchObject({ state: "saved" });
    expect(w.calls.filter(x => x === "push")).toHaveLength(1); expect(w.calls.filter(x => x === "redeem")).toHaveLength(2);
  });
  it("cancel wins while an issued credential response is held and never ACKs or activates a late result", async () => {
    const w = await world(), pending = await w.start(); w.ready();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => { release = r; }), seen = new Promise<void>(r => { entered = r; });
    const original = w.client.command.getMockImplementation()!;
    w.client.command.mockImplementation(async (...args: any[]) => { const result = await (original as any)(...args); if (args[1] === "redeem") { entered(); await held; } return result; });
    const poll = w.controller.status(pending.operationId, w.session); await seen;
    await w.controller.cancel(pending.operationId, w.session); release(); await poll;
    expect(w.calls).not.toContain("ack"); expect(currentBinding(w.directory)).toBeNull(); expect(w.activate).not.toHaveBeenCalled();
  });
  it("a restarted controller reopens only the same host-owned operation and key; no fresh enrollment", async () => {
    const w = await world(), pending = await w.start(); w.ready(); w.controller.close();
    const next = new CompanyJoinController(w.options);
    expect(await next.status(pending.operationId, { ...w.session, ownerKey: {} })).toMatchObject({ state: "saved" });
    expect(w.calls.filter(x => x === "push")).toHaveLength(1);
  });
});
