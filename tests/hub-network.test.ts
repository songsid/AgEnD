import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hubRig } from "./helpers/hub-rig.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";
import { HubMemberClient } from "../src/hub/client.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
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
