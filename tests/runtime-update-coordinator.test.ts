/** Authenticated loopback peers; no Windows process, CLI, account or installed root. */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import type { RuntimeUpdateClientPhase } from "../src/runtime-update-protocol.js";

const roots: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], sockets: WebSocket[] = [];
const info = { version: "2.3.5", buildId: "a".repeat(64), protocolVersions: [1], capabilities: ["exec", "managed-update-v1"] };
async function fixture(options: ConstructorParameters<typeof RuntimeCoordinator>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-update-coordinator-")); roots.push(root);
  const hub = new RuntimeCoordinator(root, options); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Fixture", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)!.pairingFingerprint);
  const identity = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret });
  if (identity.status !== "approved") throw Error("Fixture approval failed");
  const server = createServer(); servers.push(server);
  server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  const endpoint = `ws://127.0.0.1:${address.port}/runtime/v1/connect`, credential = identity.credential;
  async function peer(extra: Record<string, unknown> = {}) {
    const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${credential}` } }); sockets.push(ws);
    const frames: any[] = [], bootId = randomUUID();
    ws.on("message", data => frames.push(JSON.parse(data.toString())));
    await once(ws, "open");
    ws.send(JSON.stringify({ v: 1, type: "hello", bootId, runtimeInfo: info, paneProtocol: 1, inventory: { home: "C:\\fixture", clis: [], probedAt: 1 }, ...extra }));
    await vi.waitFor(() => expect(frames.some(f => f.type === "welcome")).toBe(true));
    const welcome = frames.find(f => f.type === "welcome");
    const send = (value: unknown) => ws.send(JSON.stringify(value));
    async function control(phase: RuntimeUpdateClientPhase, id = randomUUID(), binding: Record<string, unknown> = {}) {
      const after = frames.length;
      send({ v: 1, type: "update.control", id, bootId, generation: welcome.generation, phase, ...binding });
      await vi.waitFor(() => expect(frames.slice(after).some(f => f.type === "update.control" && f.id === id)).toBe(true));
      return frames.slice(after).find(f => f.type === "update.control" && f.id === id);
    }
    return { ws, frames, bootId, welcome, send, control };
  }
  return { hub, peer, machineId: identity.machineId };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("fences new ordinary and pane work until the exact prepared attempt cancels", async () => {
  const f = await fixture(), p = await f.peer(), id = randomUUID();
  expect(p.welcome.updateProtocol).toBe(1); expect(f.hub.paneTransportEpoch(f.machineId)).not.toBeNull();
  expect((await p.control("prepare", id)).phase).toBe("prepared");
  // Even a broken admission gate must settle promptly, so a mutant fails an assertion rather than the test deadline.
  p.ws.on("message", bytes => {
    const frame = JSON.parse(bytes.toString());
    if (frame.type === "request" || frame.type === "pane.request") p.send({ v: 1, type: frame.type === "request" ? "response" : "pane.response", id: frame.id, ok: false });
  });
  await expect(f.hub.call(f.machineId, "probe", {})).rejects.toThrow(/updat|offline/);
  await expect(f.hub.callPane(f.machineId, { action: "list" })).rejects.toThrow(/updat|offline/);
  expect(f.hub.paneTransportEpoch(f.machineId)).toBeNull();
  expect((await p.control("cancel", randomUUID())).phase).toBe("cancelled");
  expect(f.hub.paneTransportEpoch(f.machineId)).toBeNull();
  expect((await p.control("cancel", id)).phase).toBe("cancelled");
  expect(f.hub.paneTransportEpoch(f.machineId)).not.toBeNull();
  expect(p.frames.filter(f => f.type === "request" || f.type === "pane.request")).toEqual([]);
});
it("does not spend a preparation on a wrong boot, generation or attempt", async () => {
  const f = await fixture(), p = await f.peer(), id = randomUUID();
  for (const binding of [{ bootId: randomUUID() }, { generation: p.welcome.generation + 1 }]) {
    expect((await p.control("prepare", id, binding)).phase).toBe("cancelled");
    expect(f.hub.paneTransportEpoch(f.machineId)).not.toBeNull();
  }
  expect((await p.control("prepare", id)).phase).toBe("prepared");
  expect((await p.control("ready", randomUUID())).phase).toBe("cancelled");
  expect((await p.control("prepare", randomUUID())).phase).toBe("busy");
  expect((await p.control("ready", id)).phase).toBe("commit");
  expect((await p.control("cancel", id)).phase).toBe("commit");
  expect(f.hub.paneTransportEpoch(f.machineId)).toBeNull();
  const next = await f.peer();
  expect((await next.control("prepare")).phase).toBe("prepared");
});
it.each(["ordinary", "pane"])("defers while a %s request is awaiting its response", async kind => {
  const f = await fixture(), p = await f.peer();
  const result = kind === "ordinary" ? f.hub.call(f.machineId, "reconcile", {}) : f.hub.callPane(f.machineId, { action: "list" });
  await vi.waitFor(() => expect(p.frames.some(frame => frame.type === (kind === "ordinary" ? "request" : "pane.request"))).toBe(true));
  expect((await p.control("prepare")).phase).toBe("busy");
  const request = p.frames.find(frame => frame.type === (kind === "ordinary" ? "request" : "pane.request"));
  p.send({ v: 1, type: kind === "ordinary" ? "response" : "pane.response", id: request.id, ok: true, result: [] }); await result;
  expect((await p.control("prepare")).phase).toBe("prepared");
});
it("keeps an uncertain accepted run busy even after the original connection is gone", async () => {
  const f = await fixture({ requestTimeoutMs: 20 }), p = await f.peer();
  const task = { requestId: randomUUID(), cli: "codex", cwd: "C:\\fixture", prompt: "fixture", sandbox: "read-only" };
  await expect(f.hub.call(f.machineId, "run", { task })).rejects.toThrow(/timed out/);
  const next = await f.peer();
  expect((await next.control("prepare")).phase).toBe("busy");
  expect(next.frames.some(frame => frame.type === "request")).toBe(false);
  expect(p.frames.filter(frame => frame.type === "request")).toHaveLength(1);
});
it("stages a candidate offline without probes until its exact activation, then admits work", async () => {
  const f = await fixture(), first = await f.peer(), id = randomUUID();
  expect((await first.control("prepare", id)).phase).toBe("prepared");
  expect((await first.control("ready", id)).phase).toBe("commit");
  const nextInfo = { ...info, buildId: "b".repeat(64) };
  const candidate = await f.peer({ updateTrialId: id, runtimeInfo: nextInfo, inventory: { home: "C:\\trial", clis: [], probedAt: null } });
  expect(f.hub.machine(f.machineId)).toMatchObject({ status: "offline", runtimeInfo: info });
  expect(candidate.frames.map(frame => frame.type)).toEqual(["welcome"]);
  await expect(f.hub.call(f.machineId, "probe", {})).rejects.toThrow(/offline/);
  expect(f.hub.paneTransportEpoch(f.machineId)).toBeNull();
  expect((await candidate.control("activate", randomUUID())).phase).toBe("busy");
  expect(f.hub.machine(f.machineId)?.status).toBe("offline");
  expect((await candidate.control("activate", id)).phase).toBe("activated");
  expect(f.hub.machine(f.machineId)).toMatchObject({ status: "online", bootId: candidate.bootId, runtimeInfo: nextInfo });
  await vi.waitFor(() => expect(candidate.frames.some(frame => frame.type === "request")).toBe(true));
  const activation = candidate.frames.findIndex(frame => frame.phase === "activated"), probe = candidate.frames.findIndex(frame => frame.type === "request");
  expect(activation).toBeLessThan(probe);
});
it("closes a trial that publishes ordinary state before activation", async () => {
  const f = await fixture(), candidate = await f.peer({ updateTrialId: randomUUID() }), closed = once(candidate.ws, "close");
  candidate.send({ v: 1, type: "inventory", inventory: { home: "C:\\trial", clis: [], probedAt: 1 } });
  expect((await closed)[0]).toBe(1008); expect(f.hub.machine(f.machineId)?.status).toBe("offline");
});
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it("retains a one-shot MCP handler across terminal evidence and connection replacement", async () => {
  const work = held<unknown>(), handleMcp = vi.fn(() => work.promise), f = await fixture({ handleMcp }), p = await f.peer();
  const task = { requestId: randomUUID(), cli: "codex", cwd: "C:\\fixture", prompt: "fixture", sandbox: "read-only" };
  const run = f.hub.call(f.machineId, "run", { task, mcp: { tools: ["task"] } });
  await vi.waitFor(() => expect(p.frames.some(frame => frame.type === "request")).toBe(true));
  p.send({ v: 1, type: "response", id: task.requestId, ok: true, result: { id: task.requestId, cli: task.cli, cwd: task.cwd, sandbox: task.sandbox, status: "running", output: "", startedAt: 1 } }); await run;
  p.send({ v: 1, type: "tool.call", id: "tool-1", runId: task.requestId, body: { op: "native-mcp", method: "tools/list", params: {} } });
  await vi.waitFor(() => expect(handleMcp).toHaveBeenCalledOnce());
  p.send({ v: 1, type: "task", seq: 1, task: { id: task.requestId, cli: task.cli, cwd: task.cwd, sandbox: task.sandbox, status: "completed", output: "", startedAt: 1, finishedAt: 2, outcomeConfirmed: true } });
  await vi.waitFor(() => expect(f.hub.hasActiveTask(f.machineId)).toBe(false));
  const next = await f.peer(); expect((await next.control("prepare")).phase).toBe("busy");
  work.resolve({ tools: [] });
  await vi.waitFor(async () => expect((await next.control("prepare")).phase).toBe("prepared"));
  expect(next.frames.some(frame => frame.type === "tool.result")).toBe(false);
});
it("retains physical pane MCP after the response deadline and across a new connection", async () => {
  const work = held<unknown>(), handlePaneMcp = vi.fn(() => work.promise), f = await fixture({ handlePaneMcp }), p = await f.peer();
  const setTimeoutReal = global.setTimeout; let expire!: () => void;
  vi.spyOn(global, "setTimeout").mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 80_000) expire = callback;
    return setTimeoutReal(callback, ms, ...args);
  }) as typeof setTimeout);
  p.send({ v: 1, type: "pane.tool.request", id: randomUUID(), body: { op: "pane-mcp", method: "tools/list", helperId: randomUUID(), owner: { hostBootId: randomUUID(), paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), instance: "fixture" }, params: {} } });
  await vi.waitFor(() => expect(handlePaneMcp).toHaveBeenCalledOnce()); expire();
  const next = await f.peer(); expect((await next.control("prepare")).phase).toBe("busy");
  work.resolve({ tools: [] });
  await vi.waitFor(async () => expect((await next.control("prepare")).phase).toBe("prepared"));
  expect(next.frames.some(frame => frame.type === "pane.tool.result")).toBe(false);
});
