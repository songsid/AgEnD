/** Real local TLS/WSS with fake directory, no running fleet or external service. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hubRig } from "./helpers/hub-rig.js";
import { HubServer } from "../src/hub/server.js";
import { sha256, signAsker, verifyLease } from "../src/hub/identity.js";
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); vi.restoreAllMocks(); });
const start = async () => { const r = await hubRig(); rigs.push(r); await r.pair(); return r; };
function held() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
const request = () => ({ messageId: randomUUID(), operationId: randomUUID(), exposureRevision: 1, phase: "begin" as const });
function bump(r: Awaited<ReturnType<typeof hubRig>>) {
  r.store.mutate({ at: Date.now(), requestId: randomUUID(), actor: { kind: "person", person: r.owner }, action: "test.policy-changed", result: "completed" }, state => { state.revocationVersion++; });
}

describe("non-retiring Hub authorization refresh", () => {
  it("fences the committed old version before socket refresh and reconnects without replay or stopping the listener", async () => {
    const r = await start(), reconnected = held();
    const c = r.client(async () => {}, async () => { if (c.state.syncs === 2) reconnected.release(); });
    await c.value.start();
    const old = c.state.link!, address = r.server.address(), leaseRequest = request(), lease = await c.value.authorize(leaseRequest);
    const gate = held(), entered = held(); r.setServerGate(async () => { entered.release(); await gate.promise; });
    const operation = request(), pending = c.value.authorize(operation), refused = expect(pending).rejects.toThrow();
    await entered.promise;
    try {
      bump(r);
      const conn = (r.server as any).connections.get(old.profile.fleetId);
      expect(conn.context.current()).toBe(false);
      await expect(r.server.send(old.profile.fleetId, { v: 1, type: "error", requestId: randomUUID(), linkEpoch: old.linkEpoch, payload: { code: "unavailable", retryable: true } })).rejects.toThrow("unavailable");
      expect(() => verifyLease(lease, leaseRequest, { linkEpoch: old.linkEpoch, revocationVersion: 1, now: Date.now() })).toThrow();
      r.server.refreshAuthorization(); expect(r.server.address()).toEqual(address);
      await refused; r.setServerGate(); gate.release();
      await reconnected.promise;
      // Reconciliation's continuation drains before the next event-loop turn; no elapsed-time polling assertion.
      await new Promise<void>(resolve => setImmediate(resolve)); expect(c.state.syncs).toBe(2);
      expect(old.current()).toBe(false); expect(c.state.holds).toContain("unavailable");
      expect(c.state.holds).not.toContain("revoked"); expect(c.state.holds).not.toContain("replaced");
      expect(c.state.link!.linkEpoch).toBeGreaterThan(old.linkEpoch);
      expect(await c.value.authorize(request())).toMatchObject({ revocationVersion: 1, linkEpoch: c.state.link!.linkEpoch });
      expect(r.received.filter(f => f.type === "authorize.request" && f.payload.operationId === operation.operationId)).toHaveLength(1);
    } finally { r.setServerGate(); gate.release(); await refused; }
  });
  it("revokes only A and immediately reconnects B at the committed global version before a fresh question", async () => {
    const r = await start(), homeB = join(r.root, "member-b"); mkdirSync(homeB, { mode: 0o700 });
    const profileB = await r.pair(homeB), reconnected = held(), delivered = held(), questions: string[] = [];
    const a = r.client();
    const b = r.client(async frame => {
      if (frame.type !== "question") return;
      const lease = await b.value.authorize({ messageId: frame.payload.identity.messageId, operationId: randomUUID(), exposureRevision: 1, phase: "admit" });
      expect(lease.revocationVersion).toBe(1); questions.push(frame.payload.text); delivered.release();
    }, async () => { if (b.state.syncs === 2) reconnected.release(); }, undefined, homeB);
    await a.value.start(); await b.value.start();
    const oldA = a.state.link!, oldB = b.state.link!, address = r.server.address();
    const fleetB = r.store.read().fleets.find(f => f.id === profileB.fleetId);
    const serverB = (r.server as any).connections.get(profileB.fleetId), endedB = vi.spyOn(serverB.link, "end");
    const retiredA = new Promise<{ code: number; reason: string }>(resolve => (a.value as any).link.ws.once("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })));
    await r.pairing.revoke(r.ctx, oldA.profile.fleetId);
    // This must happen in revoke(), without waiting for a heartbeat or a manual refresh in the test.
    expect(endedB).toHaveBeenCalledExactlyOnceWith("unavailable");
    expect(r.store.read().revocationVersion).toBe(1); expect(r.server.address()).toEqual(address);
    expect(await retiredA).toEqual({ code: 1008, reason: "revoked" });
    await reconnected.promise; await new Promise<void>(resolve => setImmediate(resolve));
    expect(oldA.current()).toBe(false); expect(oldB.current()).toBe(false);
    expect(a.state.holds).toContain("revoked"); expect(a.state.syncs).toBe(1);
    expect(() => r.pairing.authenticate(oldA.profile.credential)).toThrow("denied");
    await expect(a.value.authorize(request())).rejects.toThrow("unavailable");
    expect(r.store.read().fleets.find(f => f.id === profileB.fleetId)).toEqual(fleetB);
    expect(b.state.holds).toContain("unavailable"); expect(b.state.holds).not.toContain("revoked"); expect(b.state.holds).not.toContain("replaced");
    expect(b.state.link!.revocationVersion).toBe(1); expect(b.state.link!.linkEpoch).toBeGreaterThan(oldB.linkEpoch);
    const text = "A separate fleet remains available", now = Date.now();
    const identity = signAsker({ v: 1, issuer: r.identity.hubId, issuerKeyId: r.identity.issuerKeyId, messageId: randomUUID(), asker: r.owner, owner: r.owner,
      destinationFleetId: profileB.fleetId, exposureId: randomUUID(), roomId: randomUUID(), grantId: randomUUID(), grantRevision: 1,
      exposureRevision: 1, revocationVersion: 1, contentDigest: sha256(text), issuedAt: now, expiresAt: now + 60_000, nonce: "c".repeat(64)
    }, createPrivateKey(readFileSync(join(r.root, "hub/keys/issuer-key.pem"))));
    await r.server.send(profileB.fleetId, { v: 1, type: "question", requestId: randomUUID(), linkEpoch: b.state.link!.linkEpoch, payload: { text, identity } });
    await delivered.promise; expect(questions).toEqual([text]); expect(b.state.link!.current()).toBe(true);
  });
  it("refuses a handshake whose already-authenticated binding waited across the committed version change", async () => {
    const r = await start(), gate = held(), entered = held(), connect = r.pairing.connect.bind(r.pairing);
    const spy = vi.spyOn(r.pairing, "connect").mockImplementationOnce(async credential => {
      const binding = await connect(credential); entered.release(); await gate.promise; return binding;
    });
    const c = r.client(), pending = c.value.start(), refused = expect(pending).rejects.toThrow();
    await entered.promise;
    try {
      bump(r); r.server.refreshAuthorization();
      const fresh = r.client(); await fresh.value.start();
      const current = (r.server as any).connections.get(fresh.state.link!.profile.fleetId);
      gate.release(); await refused; await c.value.close();
      expect(c.state.syncs).toBe(0); expect(current.context.current()).toBe(true);
      expect((r.server as any).connections.get(fresh.state.link!.profile.fleetId)).toBe(current);
      expect(fresh.state.link).toMatchObject({ revocationVersion: 1 }); expect(fresh.state.syncs).toBe(1);
      expect(fresh.state.holds).not.toContain("replaced");
    } finally { gate.release(); await refused; spy.mockRestore(); }
  });
  it("rechecks the version at upgrade completion before publishing a connection", async () => {
    const r = await start(), wss = (r.server as any).wss;
    const handle = wss.handleUpgrade.bind(wss); let installed = false;
    vi.spyOn(wss, "handleUpgrade").mockImplementationOnce((req: any, socket: any, head: any, done: any) => handle(req, socket, head, (ws: any) => {
      bump(r); r.server.refreshAuthorization(); done(ws); installed = (r.server as any).connections.size !== 0;
    }));
    const c = r.client(); await expect(c.value.start()).rejects.toThrow(); await c.value.close();
    expect(installed).toBe(false); expect(c.state.syncs).toBe(0);
  });
  it("closes the captured connections synchronously without closing their reentrant replacements", () => {
    const server = new HubServer({} as never), replacement = { link: { end: vi.fn(), retire: vi.fn() } };
    const connections = (server as any).connections as Map<string, unknown>;
    const second = { link: { end: vi.fn(), retire: vi.fn() } }, first = { link: { end: vi.fn(() => { connections.set("second", replacement); }), retire: vi.fn() } };
    connections.set("first", first); connections.set("second", second);
    server.refreshAuthorization();
    expect(first.link.end).toHaveBeenCalledExactlyOnceWith("unavailable"); expect(second.link.end).toHaveBeenCalledExactlyOnceWith("unavailable");
    expect(replacement.link.end).not.toHaveBeenCalled(); expect(connections.get("second")).toBe(replacement);
  });
});
