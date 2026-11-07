/** Real local TLS/WSS with fake directory, no running fleet or external service. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { hubRig } from "./helpers/hub-rig.js";
import { HubServer } from "../src/hub/server.js";
import { verifyLease } from "../src/hub/identity.js";
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
