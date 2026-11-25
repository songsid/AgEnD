/** First-hop and prepared-ledger controls, all synthetic; no native CLI or host. */
import { createServer, request } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { NativePaneManager } from "../src/native-pane-manager.js";
import { paneMcpHttp } from "../src/windows-pane-mcp.js";
import { PaneMcpRelay } from "../src/runtime-pane-mcp-relay.js";
import { PaneMcpAuthorityLease, type PaneMcpAuthority } from "../src/runtime-pane-mcp.js";
import { RequestContextPaneProofs } from "../src/request-context-pane.js";
import { validateRequestContextCallStamp } from "../src/request-context-call-protocol.js";
import type { RequestContextTurnSnapshot } from "../src/request-context-turns.js";
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
function rig(registration?:import("../src/request-context-fence.js").RequestContextRegistrationGate) {
  const root = mkdtempSync(join(tmpdir(), "agend-s224-pane-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const owner = { hostBootId: randomUUID(), paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), instance: "worker" };
  const contextId = randomUUID();
  const a: RequestContextTurnSnapshot = { token: randomUUID(), inputId: "input-a", wireSha256: "a".repeat(64),
    owner: { instance: owner.instance, incarnation: "incarnation", workGeneration: "work", daemonBootId: "boot", spawnGeneration: 1, launchFenceEpoch: 0, deliveryEpoch: 0 },
    context: { ref: { version: 1, contextId, rootContextId: contextId }, ingress: "guest", rootEvidenceRef: "fixture",
      initiatingActor: { kind: "person", platform: "discord", userId: "PRIVATE_PERSON_ID" }, source: { instance: owner.instance, incarnation: "incarnation" },
      sourceAudience: { kind: "web", ref: randomUUID() } } };
  let active = a; const proofs = new RequestContextPaneProofs("synthetic-key-".repeat(4),registration);
  const stamp = proofs.mint(owner, a, captured => captured.token === active.token);
  const invoke = vi.fn(async (_input: Parameters<PaneMcpAuthority["invoke"]>[0], current: () => boolean) => ({ result: { ok: current() } }));
  const written = vi.fn(), file = join(root, "launch.mcp.json");
  const authority: PaneMcpAuthority = { registration, owner, machineId: randomUUID(), toolCeiling: ["reply"], current: () => true,
    allowed: () => true, menu: () => [{ name: "reply" }], invoke, responseWritten: written, requestContexts: proofs };
  const lease = new PaneMcpAuthorityLease(file, authority);
  const body = { op: "pane-mcp" as const, method: "tools/call" as const, owner, helperId: randomUUID(), callId: "a".repeat(64), params: { name: "reply", arguments: { text: "PRIVATE_PROMPT" } } };
  const replace = () => { active = { ...a, token: randomUUID(), inputId: "input-b" }; return proofs.mint(owner, active, captured => captured.token === active.token); };
  return { root, owner, a, stamp, proofs, invoke, written, file, authority, lease, body, replace };
}
it("writes only ids/digests on the SAME prepared row before invoke; stamped replay conflicts before cached return", async () => {
  const f = rig();
  f.invoke.mockImplementationOnce(async (input, current) => {
    const raw = readFileSync(f.file, "utf8"), row = Object.values(JSON.parse(raw).calls)[0] as any;
    expect(row).toMatchObject({ state: "prepared", operationId: input.operationId, requestContext: { coverage: "covered", contextId: f.a.context.ref.contextId } });
    expect(raw).not.toContain(f.stamp.coverage === "covered" ? f.stamp.proof : "unused");
    expect(raw).not.toMatch(/PRIVATE_|initiatingActor|daemonBootId/); expect(current()).toBe(true);
    expect(input.requestContext?.coverage).toBe("covered"); return { result: { ok: true } };
  });
  const result = await f.lease.handle(f.authority.machineId, f.body, () => true, f.stamp);
  expect(await f.lease.handle(f.authority.machineId, f.body, () => true, f.stamp)).toEqual(result);
  const next = f.replace();
  await expect(f.lease.handle(f.authority.machineId, f.body, () => true, next)).rejects.toThrow(/different originating context/);
  expect(f.invoke).toHaveBeenCalledOnce();
  await expect(f.lease.handle(f.authority.machineId, { ...f.body, callId: "b".repeat(64) }, () => true, f.stamp)).rejects.toThrow(/stale/);
});
it("an unstamped ON call refuses, a foreign stamp cannot resolve, and legacy rows never acquire a context", async () => {
  const f = rig(); await expect(f.lease.handle(f.authority.machineId, f.body, () => true)).rejects.toThrow(/stamp/);
  expect(() => f.proofs.resolve({ ...f.owner, launchId: randomUUID() }, f.stamp)).toThrow(/stale/);
  const legacy = new PaneMcpAuthorityLease(join(f.root, "legacy.json"), { ...f.authority, requestContexts: undefined });
  await expect(legacy.handle(f.authority.machineId, f.body, () => true, f.stamp)).rejects.toThrow(/not negotiated/);
  await legacy.handle(f.authority.machineId, f.body, () => true);
  const upgraded = new PaneMcpAuthorityLease(join(f.root, "legacy.json"), f.authority);
  await expect(upgraded.handle(f.authority.machineId, f.body, () => true, f.stamp)).rejects.toThrow(/different originating context/);
  expect(f.invoke).toHaveBeenCalledOnce();
});
it("not-covered carries one stable operation to admission, not a transport revocation or an owner context", async () => {
  const f = rig(), stamp = { version: 1, coverage: "not-covered", reason: "interrupted-launch" } as const;
  await f.lease.handle(f.authority.machineId, f.body, () => true, stamp);
  await f.lease.handle(f.authority.machineId, f.body, () => true, stamp);
  expect(f.invoke).toHaveBeenCalledOnce(); expect(f.invoke.mock.calls[0][0].requestContext).toEqual({ coverage: "not-covered", reason: "interrupted-launch" });
  expect(f.invoke.mock.calls[0][1]()).toBe(true);
  expect(Object.values(JSON.parse(readFileSync(f.file, "utf8")).calls)).toHaveLength(1);
});
it("captures A before a held HTTP body, without helper-wire changes; abort quarantine cannot be replaced by B", async () => {
  const f = rig(); let entered!: () => void; const entry = new Promise<void>(done => { entered = done; });
  const forward = vi.fn(async (_body: unknown, _current: () => boolean, _stamp?: unknown) => ({ result: {} }));
  forward.mockImplementationOnce(async (_body, _current, stamp) => { expect(stamp).toEqual(f.stamp); expect(() => f.proofs.resolve(f.owner, stamp)).toThrow(/stale/); return { result: {} }; });
  const relay = new PaneMcpRelay({ secret: "b".repeat(64), endpoint: () => "", owned: () => true, requestContextProtocol: 1, forward });
  const connection = relay.connection(f.owner, ["reply"]); relay.installRequestContext(f.owner, f.stamp);
  const server = createServer((req, res) => { void relay.handle(req, res); entered(); });
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const body = JSON.stringify(f.body);
  const response = new Promise<number>((done, reject) => {
    const client = request({ hostname: "127.0.0.1", port: (server.address() as any).port, path: "/agent", method: "POST", headers: { "x-agend-native-token": connection.token, "content-length": Buffer.byteLength(body) } }, res => { res.resume(); res.once("end", () => done(res.statusCode!)); });
    client.on("error", reject); client.flushHeaders();
    void entry.then(() => {
      const b = f.replace(); relay.installRequestContext(f.owner, b);
      relay.installRequestContext(f.owner, { version: 1, coverage: "not-covered", reason: "interrupted-launch" });
      expect(() => relay.installRequestContext(f.owner, b)).not.toThrow();
      client.end(body);
    }).catch(reject);
  });
  expect(await response).toBe(200); expect(forward).toHaveBeenCalledOnce();
  const connected = { ...connection, endpoint: `http://127.0.0.1:${(server.address() as any).port}/agent` };
  // New independent input is allowed; its next call remains uncovered, with no borrowed B/admin identity.
  await paneMcpHttp(connected, { ...f.body, callId: "b".repeat(64) });
  expect(forward.mock.calls[1][2]).toEqual({ version: 1, coverage: "not-covered", reason: "interrupted-launch" });
  // The receipt for the original call still names A even though the installed stamp changed.
  await paneMcpHttp(connected, { op: "pane-mcp", owner: f.owner, helperId: f.body.helperId, method: "response-written", callId: f.body.callId, responseId: "c".repeat(64) });
  expect(forward.mock.calls[2][2]).toEqual(f.stamp);
  expect((relay as any).callStamps.size).toBe(1); // Only B remains; A was removed after its forwarded ACK.
  expect([...(relay as any).callStamps.values()]).not.toContainEqual(f.stamp);
  expect(JSON.stringify(connection)).not.toContain(f.a.token);
});
it("stamp validation is strict and OFF rejects publication", () => {
  const f = rig(); expect(() => validateRequestContextCallStamp({ ...f.stamp, context: f.a.context })).toThrow(/stamp/);
  const relay = new PaneMcpRelay({ secret: "b".repeat(64), endpoint: () => "", owned: () => true, forward: vi.fn() });
  relay.connection(f.owner, ["reply"]); expect(() => relay.installRequestContext(f.owner, f.stamp)).toThrow(/not negotiated/);
});
it("an awaited A invocation cannot mutate or return under B, and its prepared operation remains inspectable", async () => {
  const f = rig(); let resume!: () => void, entered!: () => void; const entry = new Promise<void>(done => { entered = done; });
  const held = new Promise<void>(done => { resume = done; }); const commit = vi.fn();
  f.invoke.mockImplementationOnce(async (input, current) => {
    expect(input.requestContext?.coverage).toBe("covered"); entered(); await held;
    if (current()) commit(); return { result: { ok: current() } };
  });
  const pending = f.lease.handle(f.authority.machineId, f.body, () => true, f.stamp);
  const rejected = expect(pending).rejects.toThrow(/expired/);
  await entry; f.replace(); resume(); await rejected; expect(commit).not.toHaveBeenCalled();
  const row = Object.values(JSON.parse(readFileSync(f.file, "utf8")).calls)[0] as any;
  expect(row.state).toBe("done"); expect(row.requestContext.contextId).toBe(f.a.context.ref.contextId); expect(f.invoke).toHaveBeenCalledOnce();
});

it("S-224 the native manager gives an old unnegotiated transport only unknown per-operation scope",async()=>{
 const f=rig(),manager=new NativePaneManager({requestContexts:f.proofs}as any);
 (manager as any).bindings.set(f.owner.agentId,{lease:f.lease});
 await manager.handle(f.authority.machineId,f.body,()=>true);
 expect(f.invoke.mock.calls[0][0].requestContext).toEqual({coverage:"not-covered",reason:"unbound-input"});
 await expect(manager.handle(f.authority.machineId,f.body,()=>true,f.stamp)).rejects.toThrow(/different originating/);
 await manager.handle(f.authority.machineId,{...f.body,callId:"b".repeat(64)},()=>true,f.stamp);
 expect(f.invoke.mock.calls[1][0].requestContext?.coverage).toBe("covered");
 await expect(manager.handle(f.authority.machineId,{...f.body,callId:"b".repeat(64)},()=>true)).rejects.toThrow(/different originating/);
 expect(f.invoke).toHaveBeenCalledTimes(2);
});

it("a late stdout ACK matches its durable original stamp after the turn and proof retire, never dispatching again", async () => {
  const f = rig();
  const result = await f.lease.handle(f.authority.machineId, f.body, () => true, f.stamp) as {responseId:string};
  const b = f.replace(); f.proofs.retire(f.owner);
  const ack = {op:"pane-mcp",method:"response-written",owner:f.owner,helperId:f.body.helperId,callId:f.body.callId,responseId:result.responseId};
  await expect(f.lease.handle(f.authority.machineId, ack, () => true, b)).rejects.toThrow(/different originating/);
  await expect(f.lease.handle(f.authority.machineId, ack, () => false, f.stamp)).rejects.toThrow(/no longer current/);
  await expect(f.lease.handle(f.authority.machineId, ack, () => true, f.stamp)).resolves.toEqual({result:{ok:true}});
  await f.lease.handle(f.authority.machineId, ack, () => true, f.stamp);
  expect(f.written).toHaveBeenCalledOnce(); expect(f.invoke).toHaveBeenCalledOnce();
  expect(Object.values(JSON.parse(readFileSync(f.file,"utf8")).calls)[0]).toMatchObject({state:"written"});
});
it("a positive launch exit retires only that launch's retained proofs through the manager", () => {
 const f=rig(),other={...f.owner,launchId:randomUUID()},otherStamp=f.proofs.mint(other,f.a,()=>true);
 const store={get:()=>({threadId:randomUUID()}),setPaneRecovery:vi.fn()};
 const manager=new NativePaneManager({requestContexts:f.proofs,store} as any);
 (manager as any).save=vi.fn();
 (manager as any).recordExit("fixture",{launch:{cli:"claude-code"}}, {...f.owner,state:"exited",sessionId:randomUUID()});
 expect(()=>f.proofs.resolve(f.owner,f.stamp)).toThrow(/unavailable/);
 expect(()=>f.proofs.resolve(other,otherStamp)).not.toThrow();
});

it("S-226 written and detached ledger rows retain their root until a matching positive launch exit",async()=>{
 const registration={assertRegistration:vi.fn()},f=rig(registration),root=f.a.context.ref.rootContextId;
 const result=await f.lease.handle(f.authority.machineId,f.body,()=>true,f.stamp)as {responseId:string};
 await f.lease.handle(f.authority.machineId,{op:"pane-mcp",method:"response-written",owner:f.owner,helperId:f.body.helperId,callId:f.body.callId,responseId:result.responseId},()=>true,f.stamp);
 expect(f.lease.drainView(root).references).toHaveLength(1);f.lease.close();expect(f.lease.drainView(root).references).toHaveLength(1);
 const exit={...f.owner,state:"exited" as const,columns:80,rows:24,seq:1,commandSequence:1,outputAt:0};
 expect(()=>f.lease.retire({...exit,launchId:randomUUID()})).toThrow(/owned exit/);expect(f.lease.drainView(root).references).toHaveLength(1);
 f.lease.retire(exit);expect(f.lease.drainView(root).references).toEqual([]);
});
it("S-226 new pane call preparation checks the drain fence before invoking or persisting a row",async()=>{
 const registration={assertRegistration:vi.fn()},f=rig(registration);registration.assertRegistration.mockImplementation(()=>{throw Error("root draining");});
 await expect(f.lease.handle(f.authority.machineId,f.body,()=>true,f.stamp)).rejects.toThrow(/draining/);expect(f.invoke).not.toHaveBeenCalled();expect(f.lease.drainView(f.a.context.ref.rootContextId).references).toEqual([]);
});
