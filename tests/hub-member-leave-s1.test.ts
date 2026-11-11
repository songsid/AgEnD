/** Authenticated narrowing on actual pinned WSS; no directory or backend services. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hubRig } from "./helpers/hub-rig.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";
import { sha256 } from "../src/hub/identity.js";
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); vi.restoreAllMocks(); });
const world = async (capabilities?: readonly string[]) => { const r = await hubRig({ serverCapabilities: capabilities }); rigs.push(r); await r.pair(); return r; };
function closed(client: any): Promise<void> { return new Promise(resolve => client.link.ws.once("close", resolve)); }
describe("member.leave", () => {
  it("revokes exactly its authenticated row and reconnects the other Fleet at the committed version", async () => {
    const r = await world(), homeB = join(r.root, "b"); mkdirSync(homeB, { mode: 0o700 }); const profileB = await r.pair(homeB);
    let ready!: () => void; const reconnected = new Promise<void>(resolve => { ready = resolve; });
    const a = r.client(), b = r.client(async () => {}, async () => { if (b.state.syncs === 2) ready(); }, undefined, homeB);
    await a.value.start(); await b.value.start(); const old = a.state.link!, done = closed(a.value);
    const digest = new HubMemberProfileStore(r.memberHome, r.identity.hubId).profileDigest()!;
    await expect(a.value.leave({ hubId: r.identity.hubId, binding: sha256(JSON.stringify(["agend-hub-binding-v1", r.identity.hubId, digest])) })).resolves.toBe(true);
    await done; await reconnected;
    expect(r.store.read()).toMatchObject({ revocationVersion: 1, fleets: [
      { id: old.profile.fleetId, status: "revoked", credentialHash: null, generation: 2 }, { id: profileB.fleetId, status: "active", generation: 1 }] });
    expect(() => r.pairing.authenticate(old.profile.credential)).toThrow("denied");
    expect(b.state.link!.revocationVersion).toBe(1);
    const audit = (r.db.prepare("SELECT value FROM audit").all() as { value: string }[]).map(row => JSON.parse(row.value)).filter(e => e.action === "member.left");
    expect(audit).toEqual([expect.objectContaining({ actor: { kind: "member", fleetId: old.profile.fleetId }, fleetId: old.profile.fleetId })]);
    expect(r.received.some(f => (f as any).type === "member.leave")).toBe(false); // never a generic member action
  });
  it("an unnegotiated leave frame cannot revoke a Fleet", async () => {
    const r = await world([]), a = r.client(); await a.value.start(); const old = a.state.link!, done = closed(a.value);
    await old.send({ v: 1, type: "member.leave", requestId: randomUUID(), linkEpoch: old.linkEpoch, payload: {} } as never); await done;
    expect(r.store.read().fleets[0]).toMatchObject({ id: old.profile.fleetId, status: "active", generation: 1 });
  });
  it("the client refuses a mismatched local binding and an unsupported peer without sending", async () => {
    const r = await world(), a = r.client(); await a.value.start();
    const before = r.store.read(), send = vi.spyOn(a.state.link!, "send");
    expect(await a.value.leave({ hubId: r.identity.hubId, binding: "f".repeat(64) })).toBe(false);
    expect(await a.value.leave({ hubId: randomUUID(), binding: "f".repeat(64) })).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(r.store.read()).toEqual(before);
    await a.value.close(); expect(await a.value.leave({ hubId: r.identity.hubId, binding: "f".repeat(64) })).toBe(false);
  });
  it("does not send leave to a legacy peer that did not negotiate it", async () => {
    const r = await world([]), a = r.client(); await a.value.start();
    const store = new HubMemberProfileStore(r.memberHome, r.identity.hubId), send = vi.spyOn(a.state.link!, "send");
    const expected = { hubId: r.identity.hubId, binding: sha256(JSON.stringify(["agend-hub-binding-v1", r.identity.hubId, store.profileDigest()])) };
    expect(await a.value.leave(expected)).toBe(false); expect(send).not.toHaveBeenCalled();
    expect(r.store.read().fleets[0]!.status).toBe("active");
  });
  it("a replaced on-disk profile cannot revoke the older live socket's Fleet", async () => {
    const r = await world(), a = r.client(); await a.value.start();
    const store = new HubMemberProfileStore(r.memberHome, r.identity.hubId), prior = store.profileDigest()!, profile = store.readProfile();
    store.saveProfile({ ...profile, credential: "f".repeat(64) }, prior, () => true);
    const send = vi.spyOn(a.state.link!, "send").mockResolvedValue();
    expect(await a.value.leave({ hubId: r.identity.hubId, binding: sha256(JSON.stringify(["agend-hub-binding-v1", r.identity.hubId, store.profileDigest()])) })).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(r.store.read().fleets[0]!.status).toBe("active");
  });
  it("rejects stale or foreign ownership without a state write or socket effects", async () => {
    const r = await world(), a = r.client(); await a.value.start(); const id = a.state.link!.profile.fleetId;
    const context = (r.server as any).connections.get(id).context;
    const fence = vi.spyOn(r.server, "fenceFleet"), refresh = vi.spyOn(r.server, "refreshAuthorization"), before = r.store.read();
    expect(() => r.pairing.leave({ ...context, current: () => false }, randomUUID())).toThrow("stale");
    expect(() => r.pairing.leave({ ...context, owner: { ...r.owner, objectId: randomUUID() } }, randomUUID())).toThrow("denied");
    expect(r.store.read()).toEqual(before); expect(fence).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });
  it("does not publish a revoke or retire sockets if the link retires during its required audit", async () => {
    const r = await world(), a = r.client(); await a.value.start(); const id = a.state.link!.profile.fleetId;
    const context = (r.server as any).connections.get(id).context; let alive = true;
    const injected = { ...context, current: () => alive && context.current() };
    const options = (r.store as any).options, original = options.appendAudit;
    vi.spyOn(options, "appendAudit").mockImplementation((...args: any[]) => { original(...args); if (args[0].action === "member.left") alive = false; });
    const fence = vi.spyOn(r.server, "fenceFleet"), refresh = vi.spyOn(r.server, "refreshAuthorization");
    expect(() => r.pairing.leave(injected, randomUUID())).toThrow("stale");
    const raw = r.db.prepare("SELECT state FROM hub_transport_state").get() as { state: string };
    expect(JSON.parse(raw.state).fleets[0]).toMatchObject({ id, status: "active", generation: 1 });
    expect(fence).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });
});
