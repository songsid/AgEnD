import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey, randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hubRig } from "./helpers/hub-rig.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";
import { HubMemberClient } from "../src/hub/client.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { signAsker, sha256 } from "../src/hub/identity.js";
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
async function rig() { const r = await hubRig(); rigs.push(r); return r; }
describe("Hub real local TLS/WSS transport with inert directory and execution", () => {
  it("pairs and pins atomically, reconciles, then obtains an exact current-operation lease", async () => {
    const r = await rig(), profile = await r.pair(), c = r.client(); await c.value.start();
    expect(profile.hub.hubId).toBe(r.identity.hubId); expect(c.state.syncs).toBe(1);
    const request = { messageId: randomUUID(), operationId: randomUUID(), exposureRevision: 1, phase: "begin" as const };
    const lease = await c.value.authorize(request); expect(lease.operationId).toBe(request.operationId); expect(lease.linkEpoch).toBe(c.state.link!.linkEpoch);
    expect(r.received.map(f => f.type)).toEqual(["reconcile", "authorize.request"]);
  });
  it("a replacement fences the old connection and stops its automatic reconnect", async () => {
    const r = await rig(); await r.pair(); const a = r.client(); await a.value.start(); const old = a.state.link!;
    const b = r.client(); await b.value.start(); await vi.waitFor(() => expect(a.state.holds).toContain("replaced"));
    expect(old.current()).toBe(false); expect(b.state.link!.linkEpoch).toBeGreaterThan(old.linkEpoch);
    await expect(a.value.authorize({ messageId: randomUUID(), operationId: randomUUID(), exposureRevision: 1, phase: "begin" })).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 350)); expect(a.state.syncs).toBe(1);
  });
  it("unpair closes immediately and the old credential cannot reconnect", async () => {
    const r = await rig(), p = await r.pair(), a = r.client(); await a.value.start();
    await r.pairing.revoke(r.ctx, p.fleetId); await vi.waitFor(() => expect(a.state.holds).toContain("revoked"));
    expect(a.state.link!.current()).toBe(false);
    const next = r.client(); await expect(next.value.start()).rejects.toThrow();
  });
  it("a new TLS key is refused before any HTTP upgrade credential can be sent", async () => {
    const r = await rig(); await r.pair(); await r.server.close();
    const other = join(r.root, "other"); mkdirSync(other, { mode: 0o700 }); await provisionHubIdentity({ home: other, memberOrigin: r.memberOrigin });
    let credentials = 0;
    const spoof = createServer({ key: readFileSync(join(other, "hub/keys/tls-key.pem")), cert: readFileSync(join(other, "hub/keys/tls-cert.pem")) }, req => { if (req.headers.authorization) credentials++; });
    spoof.on("upgrade", req => { if (req.headers.authorization) credentials++; });
    const port = Number(new URL(r.memberOrigin).port); await new Promise<void>(resolve => spoof.listen(port, "127.0.0.1", resolve));
    try { const c = r.client(); await expect(c.value.start()).rejects.toThrow(); expect(c.state.holds).toContain("key-changed"); expect(credentials).toBe(0); }
    finally { await new Promise<void>(resolve => spoof.close(() => resolve())); }
  });
  it("refuses a body/policy continuation after owner eligibility changed", async () => {
    const r = await rig(); await r.pair(); r.disableOwner(); const c = r.client(); await expect(c.value.start()).rejects.toThrow();
    expect(r.received).toEqual([]);
  });
});

it("admits a received question with an online authorization reply on the same link without blocking its receive queue", async () => {
  const r = await rig(), profile = await r.pair(); let admitted = 0;
  const c = r.client(async frame => {
    if (frame.type !== "question") return;
    await c.value.authorize({ messageId: frame.payload.identity.messageId, operationId: randomUUID(), exposureRevision: 1, phase: "admit" });
    admitted++;
  });
  await c.value.start();
  const text = "inert external question", now = Date.now();
  const identity = signAsker({ v: 1, issuer: r.identity.hubId, issuerKeyId: r.identity.issuerKeyId, messageId: randomUUID(), asker: r.owner, owner: r.owner,
    destinationFleetId: profile.fleetId, exposureId: randomUUID(), roomId: randomUUID(), grantId: randomUUID(), grantRevision: 1,
    exposureRevision: 1, revocationVersion: 0, contentDigest: sha256(text), issuedAt: now, expiresAt: now + 60_000,
    nonce: "a".repeat(64) }, createPrivateKey(readFileSync(join(r.root, "hub/keys/issuer-key.pem"))));
  await r.server.send(profile.fleetId, { v: 1, type: "question", requestId: randomUUID(), linkEpoch: c.state.link!.linkEpoch, payload: { text, identity } });
  await vi.waitFor(() => expect(admitted).toBe(1), { timeout: 1_000 });
  expect(r.received.filter(f => f.type === "authorize.request")).toHaveLength(1);
});

it("does not resend an authorization operation when its reply is lost across a reconnect", async () => {
  const r = await rig(), profile = await r.pair(), c = r.client(); await c.value.start();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); r.setServerGate(() => gate);
  const request = { messageId: randomUUID(), operationId: randomUUID(), exposureRevision: 1, phase: "begin" as const };
  const pending = c.value.authorize(request), refusal = expect(pending).rejects.toThrow();
  try {
    await vi.waitFor(() => expect(r.received.filter(f => f.type === "authorize.request")).toHaveLength(1));
    const old = c.state.link!;
    (r.server as any).connections.get(profile.fleetId).link.ws.terminate(); await refusal;
    r.setServerGate(); release();
    await vi.waitFor(() => expect(c.state.syncs).toBe(2)); expect(old.current()).toBe(false);
    expect(r.received.filter(f => f.type === "authorize.request")).toHaveLength(1);
    expect(await c.value.authorize({ ...request, operationId: randomUUID() })).toHaveProperty("phase", "begin");
    expect(r.received.filter(f => f.type === "authorize.request")).toHaveLength(2);
  } finally { r.setServerGate(); release(); }
});
it("bounds queued external work and discards retired-link work without replaying it after reconnect", async () => {
  const r = await rig(), profile = await r.pair(); let started = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const c = r.client(async frame => { if (frame.type === "question") { started++; await gate; } }); await c.value.start();
  const now = Date.now(), text = "bounded inert question";
  const identity = signAsker({ v: 1, issuer: r.identity.hubId, issuerKeyId: r.identity.issuerKeyId, messageId: randomUUID(), asker: r.owner, owner: r.owner,
    destinationFleetId: profile.fleetId, exposureId: randomUUID(), roomId: randomUUID(), grantId: randomUUID(), grantRevision: 1,
    exposureRevision: 1, revocationVersion: 0, contentDigest: sha256(text), issuedAt: now, expiresAt: now + 60_000,
    nonce: "b".repeat(64) }, createPrivateKey(readFileSync(join(r.root, "hub/keys/issuer-key.pem"))));
  try {
    for (let i = 0; i < 33; i++) await r.server.send(profile.fleetId, { v: 1, type: "question", requestId: randomUUID(), linkEpoch: c.state.link!.linkEpoch, payload: { text, identity } });
    await vi.waitFor(() => expect(c.state.holds).toContain("backpressure")); expect(started).toBe(1);
    release(); await vi.waitFor(() => expect(c.state.syncs).toBe(2)); expect(started).toBe(1);
  } finally { release(); }
});
