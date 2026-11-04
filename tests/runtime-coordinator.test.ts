import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import type { WindowsCliTask } from "../src/windows-cli.js";

const homes: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], clients: WebSocket[] = [];
const taskInput = { requestId: "12345678-1234-4321-abcd-123456789012", cli: "codex", cwd: "C:\\test", prompt: "Read only", sandbox: "read-only" };
function home() { const value = mkdtempSync(join(tmpdir(), "agend-runtime-hub-")); homes.push(value); return value; }
function hub(options: ConstructorParameters<typeof RuntimeCoordinator>[1] = {}) { const value = new RuntimeCoordinator(home(), options); hubs.push(value); return value; }
function pair(h: RuntimeCoordinator, name = "Desk") { const p = h.createPairing(), pending = h.pair({ code: p.code, name, platform: "win32" }); h.approve(pending.machineId, h.machine(pending.machineId)?.pairingFingerprint); const claim = h.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (claim.status !== "approved") throw Error("Claim not approved"); return claim; }
async function listen(h: RuntimeCoordinator) {
  const server = createServer((req, res) => { if (!h.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
  servers.push(server); server.on("upgrade", (req, socket, head) => { if (!h.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No test port");
  return `http://127.0.0.1:${address.port}`;
}
async function connect(base: string, credential: string, bootId = "boot-1") {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/runtime/v1/connect", { headers: { Authorization: `Bearer ${credential}` } }); clients.push(ws);
  await once(ws, "open"); const welcome = once(ws, "message"); ws.send(JSON.stringify({ v: 1, type: "hello", bootId, inventory: { home: "C:\\Users\\test", clis: [] } })); await welcome; return ws;
}
function responseTask(payload: unknown): WindowsCliTask { const task = (payload as { task: typeof taskInput }).task; return { id: task.requestId, cli: "codex", cwd: task.cwd, sandbox: "read-only", status: "running", output: "", startedAt: 1 }; }
afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  for (const h of hubs.splice(0)) h.close();
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const path of homes.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test cleanup"); rmSync(path, { recursive: true, force: true }); }
});

describe("runtime pairing durable identity", () => {
  it("requires approval, single-uses codes and claims, and stores only credential hashes", () => {
    const h = hub(), p = h.createPairing();
    const pending = h.pair({ code: p.code, name: "Desk", platform: "win32" });
    expect(h.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret })).toEqual({ status: "pending" });
    expect(() => h.pair({ code: p.code, name: "Second", platform: "win32" })).toThrow(/invalid|used/);
    expect(h.machine(pending.machineId)?.status).toBe("pending"); h.approve(pending.machineId, h.machine(pending.machineId)?.pairingFingerprint);
    const claimed = h.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); expect(claimed.status).toBe("approved");
    expect(() => h.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret })).toThrow();
    const raw = readFileSync(join(homes[0], "runtime-machines.json"), "utf8");
    expect(raw).not.toContain(p.code.replaceAll("-", "")); expect(raw).not.toContain(pending.claimSecret);
    if (claimed.status === "approved") expect(raw).not.toContain(claimed.credential);
    expect(JSON.stringify(h.listMachines())).not.toMatch(/Hash|Secret|credential/);
  });
  it("expires pairing and pending approval without granting credentials", () => {
    let now = 100; const h = hub({ now: () => now }), p = h.createPairing(); now += 10 * 60_000;
    expect(() => h.pair({ code: p.code, name: "Desk", platform: "win32" })).toThrow();
    const next = h.createPairing(), pending = h.pair({ code: next.code, name: "Desk", platform: "win32" }); now += 10 * 60_000;
    expect(() => h.approve(pending.machineId, h.machine(pending.machineId)?.pairingFingerprint)).toThrow(); expect(() => h.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret })).toThrow();
  });
  it("fails closed on malformed persisted identity rather than overwriting it", () => {
    const path = home(), file = join(path, "runtime-machines.json"), raw = JSON.stringify({ version: 1, machines: [{ machine: { id: "forged", name: "Wrong", platform: "win32", status: "online", generation: 0 } }], pairings: [], commands: [] });
    writeFileSync(file, raw); expect(() => new RuntimeCoordinator(path)).toThrow(/Malformed/); expect(readFileSync(file, "utf8")).toBe(raw);
  });
  it("rejects revoked credentials and browser WebSocket origins", async () => {
    const h = hub(), identity = pair(h), base = await listen(h);
    // ws emits the original ClientRequest first, IncomingMessage second.
    const ws = new WebSocket(base.replace("http:", "ws:") + "/runtime/v1/connect", { headers: { Authorization: `Bearer ${identity.credential}`, Origin: "http://localhost" } }); clients.push(ws); ws.on("error", () => {});
    const denied = await once(ws, "unexpected-response"); expect(denied[1].statusCode).toBe(401); ws.terminate();
    h.revoke(identity.machineId);
    const revoked = new WebSocket(base.replace("http:", "ws:") + "/runtime/v1/connect", { headers: { Authorization: `Bearer ${identity.credential}` } }); clients.push(revoked); revoked.on("error", () => {});
    expect((await once(revoked, "unexpected-response"))[1].statusCode).toBe(401); revoked.terminate();
  });
});

describe("runtime execution delivery and reconciliation", () => {
  it("journals before wire, deduplicates runs and rejects changed payloads", async () => {
    const h = hub(), identity = pair(h), base = await listen(h), ws = await connect(base, identity.credential);
    let launches = 0;
    ws.on("message", raw => { const m = JSON.parse(raw.toString()); if (m.type !== "request") return; launches++;
      const store = JSON.parse(readFileSync(join(homes[0], "runtime-machines.json"), "utf8")); expect(store.commands.some((c: { id: string }) => c.id === m.id)).toBe(true);
      ws.send(JSON.stringify({ v: 1, type: "response", id: m.id, ok: true, result: responseTask(m.payload) }));
    });
    const first = await h.call(identity.machineId, "run", { task: taskInput }); expect((first as WindowsCliTask).status).toBe("running");
    expect(await h.call(identity.machineId, "run", { task: taskInput })).toEqual(first); expect(launches).toBe(1);
    await expect(h.call(identity.machineId, "run", { task: { ...taskInput, prompt: "Changed" } })).rejects.toThrow(/different/);
    expect(h.hasActiveTask(identity.machineId)).toBe(true);
  });
  it("accepts monotonically sequenced snapshots and fences cross-machine task events", async () => {
    const h = hub(), one = pair(h), two = pair(h, "Laptop"), base = await listen(h), ws = await connect(base, one.credential), attacker = await connect(base, two.credential);
    ws.on("message", raw => { const m = JSON.parse(raw.toString()); if (m.type === "request") ws.send(JSON.stringify({ v: 1, type: "response", id: m.id, ok: true, result: responseTask(m.payload) })); });
    await h.call(one.machineId, "run", { task: taskInput });
    const finished = { ...responseTask({ task: taskInput }), status: "completed", output: "Done", finishedAt: 10, outcomeConfirmed: true };
    ws.send(JSON.stringify({ v: 1, type: "task", seq: 2, task: finished })); await vi.waitFor(() => expect(h.task(taskInput.requestId)?.output).toBe("Done"));
    ws.send(JSON.stringify({ v: 1, type: "task", seq: 1, task: responseTask({ task: taskInput }) })); await new Promise(done => setTimeout(done, 20)); expect(h.task(taskInput.requestId)?.status).toBe("completed");
    const closed = once(attacker, "close"); attacker.send(JSON.stringify({ v: 1, type: "task", seq: 3, task: { ...finished, output: "Forged" } })); expect((await closed)[0]).toBe(1008);
    expect(h.task(taskInput.requestId)?.output).toBe("Done"); expect(h.hasActiveTask(one.machineId)).toBe(false);
  });
  it("holds unacknowledged work after disconnect and never automatically redispatches on reconnect", async () => {
    const h = hub(), identity = pair(h), base = await listen(h), ws = await connect(base, identity.credential);
    ws.on("message", raw => { if (JSON.parse(raw.toString()).type === "request") ws.terminate(); });
    await expect(h.call(identity.machineId, "run", { task: taskInput })).rejects.toThrow(/disconnected/);
    expect(h.hasActiveTask(identity.machineId)).toBe(true);
    const next = await connect(base, identity.credential, "boot-2"); let commands = 0; next.on("message", raw => { if (JSON.parse(raw.toString()).type === "request") commands++; });
    await expect(h.call(identity.machineId, "run", { task: taskInput })).rejects.toThrow(/already recorded/); expect(commands).toBe(0);
    const completed = { ...responseTask({ task: taskInput }), status: "completed", finishedAt: 2, outcomeConfirmed: true };
    next.send(JSON.stringify({ v: 1, type: "task", seq: 1, task: completed })); await vi.waitFor(() => expect(h.hasActiveTask(identity.machineId)).toBe(false));
  });
  it("holds a timed out execution instead of retrying it or accepting another run", async () => {
    const h = hub({ requestTimeoutMs: 20 }), identity = pair(h), base = await listen(h), ws = await connect(base, identity.credential); let received = 0;
    ws.on("message", raw => { if (JSON.parse(raw.toString()).type === "request") received++; });
    await expect(h.call(identity.machineId, "run", { task: taskInput })).rejects.toThrow(/timed out/); expect(h.hasActiveTask(identity.machineId)).toBe(true);
    await expect(h.call(identity.machineId, "run", { task: { ...taskInput, requestId: "12345678-1234-4321-abcd-123456789013" } })).rejects.toThrow(/unconfirmed/); expect(received).toBe(1);
  });
  it("binds unknown-job recovery to its original machine and sends a no-execution tombstone request", async () => {
    const h = hub({ requestTimeoutMs: 20 }), one = pair(h), two = pair(h, "Laptop"), base = await listen(h), ws = await connect(base, one.credential); await connect(base, two.credential);
    let runs = 0;
    ws.on("message", raw => { const m = JSON.parse(raw.toString()); if (m.type !== "request") return;
      if (m.operation === "run") { runs++; return; }
      if (m.operation === "recover") {
        expect(m.payload.original).toEqual({ task: taskInput });
        const task = { ...responseTask(m.payload.original), status: "failed", finishedAt: 2, outcomeConfirmed: true, error: "Manually confirmed stopped; no execution replay" };
        ws.send(JSON.stringify({ v: 1, type: "task", seq: 1, task })); ws.send(JSON.stringify({ v: 1, type: "response", id: m.id, ok: true, result: task }));
      }
    });
    await expect(h.call(one.machineId, "run", { task: taskInput })).rejects.toThrow(/timed out/);
    await expect(h.call(two.machineId, "recover", { runId: taskInput.requestId, confirmedStopped: true })).rejects.toThrow(/belong/);
    await expect(h.call(one.machineId, "recover", { runId: taskInput.requestId, confirmedStopped: true, original: { task: { ...taskInput, prompt: "Injected" } } })).rejects.toThrow(/confirmation/);
    expect(await h.call(one.machineId, "recover", { runId: taskInput.requestId, confirmedStopped: true })).toMatchObject({ status: "failed", outcomeConfirmed: true }); expect(runs).toBe(1); expect(h.hasActiveTask(one.machineId)).toBe(false);
  });
  it("rejects binary frames before interpreting their JSON", async () => {
    const h = hub(), identity = pair(h), ws = await connect(await listen(h), identity.credential), closed = once(ws, "close");
    ws.send(Buffer.from(JSON.stringify({ v: 1, type: "inventory", inventory: { home: "C:\\test", clis: [] } }))); expect((await closed)[0]).toBe(1008);
  });
  it("rejects stale connection responses after a newer authenticated connection takes over", async () => {
    const h = hub(), identity = pair(h), base = await listen(h), first = await connect(base, identity.credential);
    let requestSeen!: () => void; const seen = new Promise<void>(done => requestSeen = done);
    first.on("message", raw => { if (JSON.parse(raw.toString()).type === "request") requestSeen(); });
    const call = h.call(identity.machineId, "run", { task: taskInput }); const rejected = expect(call).rejects.toThrow(/replaced/); await seen;
    await connect(base, identity.credential, "new-boot"); await rejected; expect(h.machine(identity.machineId)?.generation).toBe(2); expect(h.task(taskInput.requestId)).toBeNull();
  });
  it("forwards MCP only for a run scoped to that machine and revokes it on completion", async () => {
    const handleMcp = vi.fn().mockResolvedValue({ tools: [] }), h = hub({ handleMcp }), identity = pair(h), base = await listen(h), ws = await connect(base, identity.credential);
    ws.on("message", raw => { const m = JSON.parse(raw.toString()); if (m.type === "request") ws.send(JSON.stringify({ v: 1, type: "response", id: m.id, ok: true, result: responseTask(m.payload) })); });
    await h.call(identity.machineId, "run", { task: taskInput, mcp: { tools: ["task"] } });
    const result = once(ws, "message"); ws.send(JSON.stringify({ v: 1, type: "tool.call", id: "tool-1", runId: taskInput.requestId, body: { op: "native-mcp", method: "tools/list", params: {} } })); expect(JSON.parse((await result)[0].toString()).ok).toBe(true); expect(handleMcp).toHaveBeenCalledOnce();
    const outside = once(ws, "message"); ws.send(JSON.stringify({ v: 1, type: "tool.call", id: "tool-outside", runId: taskInput.requestId, body: { op: "native-mcp", method: "tools/call", callId: "outside", params: { name: "delegate_task", arguments: {} } } })); expect(JSON.parse((await outside)[0].toString()).ok).toBe(false); expect(handleMcp).toHaveBeenCalledOnce();
    ws.send(JSON.stringify({ v: 1, type: "task", seq: 1, task: { ...responseTask({ task: taskInput }), status: "completed", finishedAt: 2, outcomeConfirmed: true } })); await vi.waitFor(() => expect(h.task(taskInput.requestId)?.status).toBe("completed"));
    const denied = once(ws, "message"); ws.send(JSON.stringify({ v: 1, type: "tool.call", id: "tool-2", runId: taskInput.requestId, body: {} })); expect(JSON.parse((await denied)[0].toString()).ok).toBe(false); expect(handleMcp).toHaveBeenCalledOnce();
  });
});

describe("alpha.2 polish: a runner that connects with no CLI inventory is asked for its own report", () => {
  async function bare(base: string, credential: string, inventory?: unknown) {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/runtime/v1/connect", { headers: { Authorization: `Bearer ${credential}` } }); clients.push(ws);
    const frames: any[] = []; ws.on("message", (b) => frames.push(JSON.parse(b.toString())));
    await once(ws, "open");
    ws.send(JSON.stringify({ v: 1, type: "hello", bootId: "boot-1", ...(inventory ? { inventory } : {}) }));
    await vi.waitFor(() => expect(frames.some(f => f.type === "welcome")).toBe(true));
    return { ws, frames };
  }
  it("just paired (no inventory in its hello): one probe request after the welcome; its answer is the machine's inventory", async () => {
    const h = hub(), base = await listen(h), claim = pair(h);
    const { ws, frames } = await bare(base, claim.credential);
    await vi.waitFor(() => expect(frames.filter(f => f.type === "request" && f.operation === "probe")).toHaveLength(1));
    const probe = frames.find(f => f.type === "request" && f.operation === "probe");
    expect(probe.payload).toEqual({ force: true });                                // detection, never the runner's cached answer
    expect(h.machine(claim.machineId)?.inventory).toBeUndefined();
    ws.send(JSON.stringify({ v: 1, type: "response", id: probe.id, ok: true, result: { home: "C:\\Users\\pc", clis: [] } }));
    await vi.waitFor(() => expect(h.machine(claim.machineId)?.inventory?.home).toBe("C:\\Users\\pc"));
  });
  it("a probe interrupted (the runner gone before it answered) settles as failed — compacted like any settled command, never left uncertain", async () => {
    const h = hub(), base = await listen(h), claim = pair(h), dir = homes.at(-1)!;
    const { ws, frames } = await bare(base, claim.credential);
    await vi.waitFor(() => expect(frames.some(f => f.type === "request" && f.operation === "probe")).toBe(true));
    ws.terminate();
    await vi.waitFor(() => {
      const cmds = JSON.parse(readFileSync(join(dir, "runtime-machines.json"), "utf8")).commands.filter((c: any) => c.operation === "probe");
      expect(cmds.map((c: any) => c.state)).toEqual(["failed"]);
    });
  });
  it("#3004 rig: a just-paired runner's hello carries a PLACEHOLDER ({clis: [], home: \"\", probedAt: null}) — no report either: probed", async () => {
    const h = hub(), base = await listen(h), claim = pair(h);
    const { frames } = await bare(base, claim.credential, { clis: [], home: "", probedAt: null });
    await vi.waitFor(() => expect(frames.filter(f => f.type === "request" && f.operation === "probe")).toHaveLength(1));
  });
  it("a report with CLIs but no probedAt (an older runner's) is a report: no probe", async () => {
    const h = hub(), base = await listen(h), claim = pair(h);
    const row = { id: "codex", version: "0.166.0", path: "C:\\codex.exe", runnable: true, authenticated: true, supports: { resume: true }, readOnlySupport: true, permissionNote: "", models: [] };
    const { frames } = await bare(base, claim.credential, { clis: [row], home: "C:\\Users\\pc", probedAt: null });
    await new Promise(r => setTimeout(r, 150));
    expect(frames.filter(f => f.type === "request")).toEqual([]);
  });
  it("a runner that brings a real report (probed): no probe (nothing runs that its report already says)", async () => {
    const h = hub(), base = await listen(h), claim = pair(h);
    const { frames } = await bare(base, claim.credential, { home: "C:\\Users\\test", clis: [], probedAt: 1_793_000_000_000 });
    await new Promise(r => setTimeout(r, 150));
    expect(frames.filter(f => f.type === "request")).toEqual([]);
    expect(h.machine(claim.machineId)?.inventory?.home).toBe("C:\\Users\\test");
  });
});

