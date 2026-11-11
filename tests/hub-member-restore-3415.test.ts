import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:https";
import { FleetManager } from "../src/fleet-manager.js";
import { hubRig } from "./helpers/hub-rig.js";
import { HubServer } from "../src/hub/server.js";
import { HubPairingService } from "../src/hub/pairing.js";
import { HubTransportStore } from "../src/hub/store.js";
import { createHubMemberFactory } from "../src/hub/compose/member.js";
import { createHubMemberPairingApi } from "../src/hub/member/pairing-api.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("a stopped old Hub backup rejects a later member, explains the hold and recovers through existing re-pairing", async () => {
  const r = await hubRig(); cleanup.push(r.close);
  await r.pair(); // A fleet that existed in the old Hub state.
  await r.server.close();
  const backup = join(r.root, "stopped-backup.sqlite"), savedFloor = r.store.read().revision;
  await r.db.backup(backup); chmodSync(backup, 0o600);
  const port = Number(new URL(r.memberOrigin).port);
  const serve = async (pairing: HubPairingService) => {
    const server = new HubServer({ home: r.root, hubId: r.identity.hubId, memberOrigin: r.memberOrigin,
      listen: { host: "127.0.0.1", port }, pairing, current: () => true, hold: () => {},
      receive: async (frame, link) => frame.type === "reconcile" ? { v: 1, type: "reconcile", requestId: frame.requestId,
        linkEpoch: link.linkEpoch, payload: { receipts: [], nextReceiptSequence: 0, more: false } } : undefined });
    await server.start(); cleanup.push(() => server.close()); return server;
  };
  const current = await serve(r.pairing);
  const home = join(r.root, "later-member"); mkdirSync(home, { mode: 0o700 });
  const later = await r.pair(home);
  writeFileSync(join(home, "hub-member/state.json"), JSON.stringify({ hubId: r.identity.hubId }), { mode: 0o600 });
  let state = "offline", linkBinding: string | null = null;
  const member = () => createHubMemberFactory({ home, components: MEMBER_COMPONENTS, boundHub: () => r.identity.hubId,
    agents: () => [], representative: { deliver: async () => false, agentToken: () => null, attachReports: () => {} },
    attachExposures: () => {}, attachAttention: () => {}, pokeAttention: () => {},
    linkState: (next, digest) => { state = next; linkBinding = digest ?? null; }, notice: () => {}, report: () => {}, log: () => {} });
  const before = await member()({ enabled: true }, () => true); cleanup.push(() => before.close());
  await before.start(); expect(state).toBe("online"); before.fence(); await before.close(); await current.close();

  // Restore only the Hub DB and its matching transport floor. Identity/TLS and the member's later profile stay intact.
  const restoredPath = join(r.root, "restored.sqlite"); copyFileSync(backup, restoredPath);
  const db = new Database(restoredPath); cleanup.push(async () => { db.close(); });
  let floor = savedFloor;
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } },
    appendAudit: (value, tx) => { tx.prepare("INSERT INTO audit VALUES(?)").run(JSON.stringify(value)); } });
  expect(store.read().fleets.some(f => f.id === later.fleetId)).toBe(false);
  let restored!: HubServer;
  const pairing = new HubPairingService({ store, directory: r.directory,
    identity: { ...r.identity, memberOrigin: r.memberOrigin, webOrigin: later.hub.webOrigin }, enabled: () => true,
    fenceFleet: (id, reason) => restored?.fenceFleet(id, reason) });
  restored = await serve(pairing);
  const rejected = await member()({ enabled: true }, () => true); cleanup.push(() => rejected.close());
  await expect(rejected.start()).rejects.toThrow();
  const api = createHubMemberPairingApi({ home, link: digest => digest === linkBinding && state === "online" ? "online" : "offline",
    hold: digest => digest !== linkBinding ? null : state === "revoked" ? "revoked" : state === "rejected" ? "rejected" : null,
    withdrawAll: () => {}, pollMs: 1 });
  expect(api.view()).toMatchObject({ state: "held", hold: "rejected", hubId: r.identity.hubId, binding: expect.any(String) });
  rejected.fence(); await rejected.close();
  // Ordinary runtime cleanup must not erase the reason before Settings reads it.
  expect(api.view()).toMatchObject({ state: "held", hold: "rejected" });
  const shown = api.view();
  expect(await api.disconnect({ hubId: "hubId" in shown ? shown.hubId : undefined, binding: "binding" in shown ? shown.binding : undefined })).toEqual({ ok: true, remote: "pending" });
  expect(api.cancel()).toEqual({ state: "unpaired" });
  const offer = await pairing.create(r.ctx, r.owner);
  const started = await api.connect({ address: r.memberOrigin, code: offer.code }, () => true);
  expect(started.ok).toBe(true);
  const pending = new HubMemberProfileStore(home, r.identity.hubId).readPending();
  await pairing.confirmOwner(r.ctx, pending.pairingId, pending.fingerprint);
  await pairing.approve(r.ctx, pending.pairingId, pending.fingerprint);
  expect((await api.confirmFingerprint(pending.fingerprint, () => true)).ok).toBe(true);
  await vi.waitFor(() => expect(api.view().state).toBe("paired"));
  expect(new HubMemberProfileStore(home, r.identity.hubId).readProfile().fleetId).not.toBe(later.fleetId);
  const repaired = await member()({ enabled: true }, () => true); cleanup.push(() => repaired.close());
  await repaired.start(); expect(api.view()).toMatchObject({ state: "paired", link: "online" });
});

it("the fleet projection ignores a diagnostic belonging to a different saved pairing", async () => {
  const r = await hubRig(); cleanup.push(r.close); const profile = await r.pair();
  writeFileSync(join(r.memberHome, "hub-member/state.json"), JSON.stringify({ hubId: profile.hub.hubId }), { mode: 0o600 });
  const digest = new HubMemberProfileStore(r.memberHome, profile.hub.hubId).profileDigest();
  const host: any = { dataDir: r.memberHome, shuttingDown: false, hubEffectsReady: true, hubMemberPairingApi: null,
    rawFleetConfig: { hub_member: { enabled: true } }, hubMemberLink: "rejected", hubMemberLinkBinding: digest,
    attachHubMemberPairing(api: unknown) { this.hubMemberPairingApi = api; } };
  await (FleetManager.prototype as any).observeHubMemberPairing.call(host, true);
  expect(host.hubMemberPairingApi.view()).toMatchObject({ state: "held", hold: "rejected" });
  host.hubMemberLinkBinding = "another-binding";
  expect(host.hubMemberPairingApi.view()).toMatchObject({ state: "paired", link: "offline" });
  host.hubMemberLink = "online";
  expect(host.hubMemberPairingApi.view()).toMatchObject({ state: "paired", link: "offline" });
  host.hubMemberLinkBinding = digest;
  expect(host.hubMemberPairingApi.view()).toMatchObject({ state: "paired", link: "online" });
  host.hubMemberLink = "revoked";
  expect(host.hubMemberPairingApi.view()).toMatchObject({ state: "held", hold: "revoked" });
});

it("a live explicit revoke is distinct from an unknown credential and stops the old link", async () => {
  const r = await hubRig(); cleanup.push(r.close); const profile = await r.pair(), c = r.client();
  await c.value.start(); await r.pairing.revoke(r.ctx, profile.fleetId);
  await vi.waitFor(() => expect(c.state.holds).toContain("revoked"));
  expect(c.state.holds).not.toContain("rejected"); expect(c.state.link?.current()).toBe(false);
});

it("a temporary socket outage reconnects with the same credential, without a rejection", async () => {
  const r = await hubRig(); cleanup.push(r.close); const profile = await r.pair(), c = r.client();
  await c.value.start(); const before = readFileSync(join(r.memberHome, "hub-member", profile.hub.hubId, "pairing.json"));
  (r.server as any).connections.get(profile.fleetId).link.ws.terminate();
  await vi.waitFor(() => expect(c.state.syncs).toBe(2));
  expect(c.state.holds).toContain("unavailable"); expect(c.state.holds).not.toContain("rejected");
  expect(c.state.holds).not.toContain("revoked"); expect(r.store.read().fleets).toHaveLength(1);
  expect(readFileSync(join(r.memberHome, "hub-member", profile.hub.hubId, "pairing.json"))).toEqual(before);
});

it.each([401, 403, 429, 503])("only pinned authentication refusals become actionable (%s)", async status => {
  const r = await hubRig(); cleanup.push(r.close); await r.pair(); await r.server.close();
  const peer = createServer({ key: readFileSync(join(r.root, "hub/keys/tls-key.pem")), cert: readFileSync(join(r.root, "hub/keys/tls-cert.pem")) });
  peer.on("upgrade", (_req, socket) => socket.end(`HTTP/1.1 ${status} Test\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`));
  await new Promise<void>(resolve => peer.listen(Number(new URL(r.memberOrigin).port), "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => peer.close(() => resolve())));
  const c = r.client(); await expect(c.value.start()).rejects.toThrow(); await c.value.close();
  expect(c.state.holds).toEqual([status === 401 || status === 403 ? "rejected" : "unavailable"]);
});

it("an invalid restored-protocol exchange becomes an actionable generic hold, without claiming revocation", async () => {
  const r = await hubRig(); cleanup.push(r.close); const profile = await r.pair(); let state = "offline";
  const create = createHubMemberFactory({ home: r.memberHome, components: MEMBER_COMPONENTS, boundHub: () => profile.hub.hubId,
    agents: () => [], representative: { deliver: async () => false, agentToken: () => null, attachReports: () => {} },
    attachExposures: () => {}, attachAttention: () => {}, pokeAttention: () => {}, linkState: next => { state = next; },
    notice: () => {}, report: () => {}, log: () => {} });
  const service = await create({ enabled: true }, () => true); cleanup.push(() => service.close()); await service.start();
  expect(state).toBe("online");
  (r.server as any).connections.get(profile.fleetId).link.ws.send(Buffer.from("invalid frame"));
  await vi.waitFor(() => expect(state).toBe("rejected"));
  service.fence(); expect(state).toBe("rejected");
});

it("a cancelled opening cannot publish a late authentication refusal", async () => {
  const r = await hubRig(); cleanup.push(r.close); await r.pair(); await r.server.close();
  const peer = createServer({ key: readFileSync(join(r.root, "hub/keys/tls-key.pem")), cert: readFileSync(join(r.root, "hub/keys/tls-cert.pem")) });
  let arrived!: () => void; const pending = new Promise<void>(resolve => { arrived = resolve; });
  let socket: any;
  peer.on("upgrade", (_req, owned) => { socket = owned; arrived(); });
  await new Promise<void>(resolve => peer.listen(Number(new URL(r.memberOrigin).port), "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { socket?.destroy(); peer.close(() => resolve()); }));
  const c = r.client(), starting = c.value.start().catch(() => {}); await pending;
  r.disable(); const closed = new Promise<void>(resolve => socket.once("close", resolve));
  socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); await closed;
  await c.value.close(); await starting; expect(c.state.holds).toEqual([]);
});
