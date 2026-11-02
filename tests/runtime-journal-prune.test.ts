/**
 * M-2239 P2-1 (#2936 review): the coordinator's command journal and the client's execution-id ledger were capped at
 * 4096 entries and never pruned, so a long-lived paired machine eventually stopped. Settled records are compacted;
 * the replay tombstones (id + digest) stay, so a repeated id is still refused after its record is gone.
 */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import type { WindowsCliTask } from "../src/windows-cli.js";

const DAY = 24 * 3_600_000;
const homes: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], clients: WebSocket[] = [];
function home() { const value = mkdtempSync(join(tmpdir(), "agend-runtime-prune-")); homes.push(value); return value; }
afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  for (const h of hubs.splice(0)) h.close();
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const path of homes.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test cleanup"); rmSync(path, { recursive: true, force: true }); }
});
const MACHINE = "11111111-2222-4333-8444-555555555555";
const hex = (n: number) => n.toString(16).padStart(64, "0");
const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
function settled(n: number, createdAt: number) {
  return { id: uuid(n), machineId: MACHINE, operation: "run", digest: hex(n), payload: {}, createdAt, state: "accepted", seq: 2,
    task: { id: uuid(n), cli: "codex", cwd: "C:\\t", sandbox: "read-only", status: "completed", startedAt: createdAt, finishedAt: createdAt + 1, output: "", outcomeConfirmed: true } };
}
function seeded(commands: unknown[], tombstones?: unknown[]) {
  const dir = home();
  writeFileSync(join(dir, "runtime-machines.json"), JSON.stringify({ version: 1, pairings: [], commands, ...(tombstones ? { tombstones } : {}),
    machines: [{ machine: { id: MACHINE, name: "Desk", platform: "win32", status: "offline", createdAt: 1, approvedAt: 1, generation: 1 }, credentialHash: hex(1) }] }));
  return dir;
}
const stored = (dir: string) => JSON.parse(readFileSync(join(dir, "runtime-machines.json"), "utf8"));

describe("M-2239 P2-1: the coordinator compacts settled commands into replay tombstones", () => {
  it("settled commands older than a week become tombstones; uncertain and unconfirmed ones are never compacted", () => {
    const now = 100 * DAY;
    const old = Array.from({ length: 3000 }, (_, i) => settled(i + 1, now - 8 * DAY));
    const uncertain = { ...settled(9001, now - 30 * DAY), state: "uncertain" };
    const unconfirmed = { ...settled(9002, now - 30 * DAY), task: { ...settled(9002, 0).task, outcomeConfirmed: false } };
    const recent = settled(9003, now - DAY);
    const dir = seeded([...old, uncertain, unconfirmed, recent]);
    const h = new RuntimeCoordinator(dir, { now: () => now }); hubs.push(h);
    (h as unknown as { compact(): void }).compact();
    const state = stored(dir);
    expect(state.commands.map((c: { id: string }) => c.id).sort()).toEqual([uuid(9001), uuid(9002), uuid(9003)].sort());
    expect(state.tombstones).toHaveLength(3000);
    expect(state.tombstones[0]).toEqual({ id: uuid(1), machineId: MACHINE, digest: hex(1), at: now });
  });

  it("beyond the soft cap, the oldest settled commands go first even when they are recent", () => {
    const now = 100 * DAY;
    const dir = seeded(Array.from({ length: 3000 }, (_, i) => settled(i + 1, now - DAY + i)));
    const h = new RuntimeCoordinator(dir, { now: () => now }); hubs.push(h);
    (h as unknown as { compact(): void }).compact();
    const state = stored(dir);
    expect(state.commands).toHaveLength(2048);
    expect(state.tombstones.map((t: { id: string }) => t.id)).toEqual(Array.from({ length: 952 }, (_, i) => uuid(i + 1)));
  });

  it("tombstones give way beyond their cap only when older than 30 days — a younger one never does", () => {
    const now = 100 * DAY;
    const tombstones = Array.from({ length: 65_536 }, (_, i) => ({ id: uuid(i + 1), machineId: MACHINE, digest: hex(i + 1), at: i < 5 ? now - 31 * DAY : now - DAY }));
    const dir = seeded(Array.from({ length: 10 }, (_, i) => settled(100_000 + i, now - 8 * DAY)), tombstones);
    const h = new RuntimeCoordinator(dir, { now: () => now }); hubs.push(h);
    (h as unknown as { compact(): void }).compact();
    const state = stored(dir), ids = new Set(state.tombstones.map((t: { id: string }) => t.id));
    // #2945 review: never past the cap the constructor reads back — 5 old ones give way, so only 5 of the 10 move;
    // the other 5 stay journaled (still refused by id) until room frees up.
    expect(ids.size).toBe(65_536);
    for (let i = 1; i <= 5; i++) expect(ids.has(uuid(i))).toBe(false);
    expect(ids.has(uuid(6))).toBe(true);
    for (let i = 0; i < 5; i++) expect(ids.has(uuid(100_000 + i))).toBe(true);
    expect(state.commands.map((c: { id: string }) => c.id)).toEqual(Array.from({ length: 5 }, (_, i) => uuid(100_005 + i)));
    h.close();
    expect(() => { const reopened = new RuntimeCoordinator(dir, { now: () => now }); hubs.push(reopened); }).not.toThrow();   // write → reload
  });

  it("a run that settled and was compacted is refused, never sent again", async () => {
    let now = 100 * DAY;
    const h = new RuntimeCoordinator(home(), { now: () => now }); hubs.push(h);
    const p = h.createPairing(), pending = h.pair({ code: p.code, name: "Desk", platform: "win32" }); h.approve(pending.machineId);
    const claim = h.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (claim.status !== "approved") throw Error("not approved");
    const server = createServer((req, res) => { if (!h.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
    servers.push(server); server.on("upgrade", (req, socket, head) => { if (!h.handleUpgrade(req, socket, head)) socket.destroy(); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/runtime/v1/connect`, { headers: { Authorization: `Bearer ${claim.credential}` } }); clients.push(ws);
    await once(ws, "open"); const welcome = once(ws, "message"); ws.send(JSON.stringify({ v: 1, type: "hello", bootId: "b1", inventory: { home: "C:\\U", clis: [] } })); await welcome;
    let launches = 0;
    ws.on("message", raw => {
      const m = JSON.parse(raw.toString()); if (m.type !== "request") return; launches++;
      const result = m.operation === "run"
        ? { id: m.payload.task.requestId, cli: "codex", cwd: m.payload.task.cwd, sandbox: "read-only", status: "completed", startedAt: now, finishedAt: now, output: "done", outcomeConfirmed: true } satisfies WindowsCliTask
        : { home: "C:\\U", clis: [] };
      ws.send(JSON.stringify({ v: 1, type: "response", id: m.id, ok: true, result }));
    });
    const run = { task: { requestId: "12345678-1234-4321-abcd-123456789012", cli: "codex", cwd: "C:\\t", prompt: "Read only", sandbox: "read-only" } };
    await h.call(claim.machineId, "run", run);
    now += 8 * DAY;
    await h.call(claim.machineId, "probe", { force: true });           // a later command compacts the settled run
    expect(h.task(run.task.requestId)).toBeNull();
    await expect(h.call(claim.machineId, "run", run)).rejects.toThrow(/already ran and its record was compacted/);
    await expect(h.call(claim.machineId, "run", { task: { ...run.task, prompt: "Changed" } })).rejects.toThrow(/different request/);
    expect(launches).toBe(2);                                          // the run once, the probe once — never the run again
    // #2945 review: a late response or a republished snapshot for the compacted run is acknowledged by its tombstone …
    ws.send(JSON.stringify({ v: 1, type: "response", id: run.task.requestId, ok: true, result: { home: "C:\\U", clis: [] } }));
    ws.send(JSON.stringify({ v: 1, type: "task", seq: 9, task: { id: run.task.requestId, cli: "codex", cwd: "C:\\t", sandbox: "read-only", status: "completed", startedAt: now, finishedAt: now, output: "done", outcomeConfirmed: true } }));
    await h.call(claim.machineId, "probe", { force: true });           // the socket is still serving
    expect(ws.readyState).toBe(WebSocket.OPEN);
    // Another machine that names this machine's compacted run is still closed: a tombstone belongs to one machine.
    const p2 = h.createPairing(), pending2 = h.pair({ code: p2.code, name: "Other", platform: "win32" }); h.approve(pending2.machineId);
    const { machineId: id2, claimSecret: s2 } = pending2, claim2 = h.claim({ machineId: id2, claimSecret: s2 }); if (claim2.status !== "approved") throw Error("not approved");
    const other = new WebSocket(`ws://127.0.0.1:${port}/runtime/v1/connect`, { headers: { Authorization: `Bearer ${claim2.credential}` } }); clients.push(other);
    await once(other, "open"); const welcome2 = once(other, "message"); other.send(JSON.stringify({ v: 1, type: "hello", bootId: "b2", inventory: { home: "C:\\U", clis: [] } })); await welcome2;
    const otherClosed = once(other, "close");
    other.send(JSON.stringify({ v: 1, type: "response", id: run.task.requestId, ok: true, result: {} }));
    expect((await otherClosed)[0]).toBe(1008);
    // … while an id this machine never had still closes the connection.
    const closed = once(ws, "close");
    ws.send(JSON.stringify({ v: 1, type: "response", id: "ffffffff-ffff-4fff-bfff-ffffffffffff", ok: true, result: {} }));
    expect((await closed)[0]).toBe(1008);
  });
});

describe("M-2239 P2-1: the client keeps its replay tombstones past 4096 and evicts only old ones", () => {
  const task = (n: number): WindowsCliTask => ({ id: `job-${String(n).padStart(12, "0")}`, cli: "codex", cwd: "C:\\t", sandbox: "read-only", status: "completed", startedAt: n, finishedAt: n + 1, output: "", outcomeConfirmed: true });
  it("#2945 review: below the id cap, byte pressure frees settled snapshots and old ids — and refuses only when nothing may go", () => {
    const MAX = 12 * 1024 * 1024, BUDGET = MAX - 512 * 1024;
    const dir = home(), now = 200 * DAY, used: Record<string, string> = {}, usedAt: Record<string, number> = {}, jobs: Record<string, unknown> = {};
    for (let n = 1; n <= 100; n++) { const t = task(n); used[t.id] = hex(n); usedAt[t.id] = now - 100 * DAY; jobs[t.id] = { digest: hex(n), seq: 2, uncertain: false, task: { ...t, output: "x".repeat(65_536) } }; }
    // Old replay ids (no snapshot) until the ledger sits between the budget and the hard cap, far below the id cap.
    let n = 1_000; while (JSON.stringify({ version: 1, jobs, used, usedAt }).length < BUDGET + 128 * 1024) {
      for (let k = 0; k < 500; k++, n++) { used[task(n).id] = hex(n); usedAt[task(n).id] = now - 100 * DAY; }
    }
    const ids = Object.keys(used).length;
    expect(ids).toBeLessThan(65_536);
    writeFileSync(join(dir, "jobs.json"), JSON.stringify({ version: 1, jobs, used, usedAt }));
    expect(readFileSync(join(dir, "jobs.json")).length).toBeLessThan(MAX);
    const store = new RuntimeClientStore(dir, () => now);
    expect(store.accept({ ...task(900_000), output: "y".repeat(65_536) }, hex(900_000)).duplicate).toBe(false);
    const after = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
    expect(readFileSync(join(dir, "jobs.json")).length).toBeLessThanOrEqual(BUDGET);
    expect(after.jobs[task(900_000).id]).toBeDefined();
    expect(after.jobs[task(1).id]).toBeUndefined();                  // the oldest settled snapshot gave way first
    expect(after.jobs[task(100).id]).toBeDefined();                  // … and only as many as needed
    expect(after.used[task(1).id]).toBe(hex(1));                     // its replay id is kept while bytes allow
    expect(Object.keys(after.used)).toHaveLength(ids + 1);
    expect(() => store.accept(task(1), hex(1))).toThrow();           // still refused as a replay

    // Nothing may go — no settled snapshot left and every replay id young (long ids reach the bytes below the id cap):
    // the client refuses and keeps its ledger as it was. (An unsettled job already blocks a new one; see blocked().)
    const dir2 = home(), used2: Record<string, string> = {}, at2: Record<string, number> = {}, jobs2: Record<string, unknown> = {};
    const long = (k: number) => `id-${String(k).padStart(77, "0")}`;
    let m = 1; while (JSON.stringify({ version: 1, jobs: jobs2, used: used2, usedAt: at2 }).length < BUDGET + 128 * 1024) {
      for (let k = 0; k < 500; k++, m++) { used2[long(m)] = hex(m); at2[long(m)] = now - DAY; }
    }
    expect(Object.keys(used2).length).toBeLessThan(65_536);
    const before = JSON.stringify({ version: 1, jobs: jobs2, used: used2, usedAt: at2 });
    writeFileSync(join(dir2, "jobs.json"), before);
    const full = new RuntimeClientStore(dir2, () => now);
    expect(() => full.accept(task(900_001), hex(900_001))).toThrow(/Runtime state limit reached: every retained execution is unsettled or younger than 30 days/);
    expect(readFileSync(join(dir2, "jobs.json"), "utf8")).toBe(before);
    expect(() => full.accept(task(900_001), hex(900_001))).toThrow(/Runtime state limit reached/);   // the refusal did not record the id
    // The same ledger with ids past 30 days: the oldest ids give way, only as many as needed, and the new job is saved.
    const old2: Record<string, number> = {}; let t = 0; for (const id of Object.keys(used2)) old2[id] = now - 40 * DAY + t++;
    writeFileSync(join(dir2, "jobs.json"), JSON.stringify({ version: 1, jobs: {}, used: used2, usedAt: old2 }));
    const aged = new RuntimeClientStore(dir2, () => now);
    expect(aged.accept(task(900_001), hex(900_001)).duplicate).toBe(false);
    const pruned = JSON.parse(readFileSync(join(dir2, "jobs.json"), "utf8"));
    expect(readFileSync(join(dir2, "jobs.json")).length).toBeLessThanOrEqual(BUDGET);
    expect(pruned.used[long(1)]).toBeUndefined();
    expect(pruned.used[long(m - 1)]).toBe(hex(m - 1));
    expect(Object.keys(pruned.used).length).toBeGreaterThan(Object.keys(used2).length - 2_000);
  });

  it("accepts past 4096 remembered executions (the old cap), and still refuses a remembered id", () => {
    const dir = home(), now = 100 * DAY, used: Record<string, string> = {};
    for (let n = 1; n <= 4096; n++) used[task(n).id] = hex(n);           // an older ledger: no times at all
    writeFileSync(join(dir, "jobs.json"), JSON.stringify({ version: 1, jobs: {}, used }));
    const store = new RuntimeClientStore(dir, () => now);
    expect(store.accept(task(5000), hex(5000)).duplicate).toBe(false);
    expect(() => store.accept(task(1), hex(999_999))).toThrow(/different arguments/);
    expect(JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8")).used[task(1).id]).toBe(hex(1));
  });
  it("at the cap, only tombstones older than 30 days (and with no job snapshot) give way", () => {
    const dir = home(), now = 100 * DAY;
    const used: Record<string, string> = {}, usedAt: Record<string, number> = {};
    for (let n = 1; n <= 65_536; n++) { const id = task(n).id; used[id] = hex(n); usedAt[id] = n <= 3 ? now - 31 * DAY : now - DAY; }
    writeFileSync(join(dir, "jobs.json"), JSON.stringify({ version: 1, jobs: {}, used, usedAt }));
    const store = new RuntimeClientStore(dir, () => now);
    store.accept(task(70_000), hex(70_000));
    const ledger = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
    expect(ledger.used[task(1).id]).toBeUndefined();                   // one old tombstone made room
    expect(ledger.used[task(2).id]).toBe(hex(2));
    expect(ledger.usedAt[task(70_000).id]).toBe(now);
    // With no old tombstone left to give way, the client refuses rather than forgetting a recent execution.
    const full: Record<string, number> = {}; for (const id of Object.keys(ledger.used)) full[id] = now - DAY;
    writeFileSync(join(dir, "jobs.json"), JSON.stringify({ ...ledger, usedAt: full, jobs: {} }));
    expect(() => new RuntimeClientStore(dir, () => now).accept(task(80_000), hex(80_000))).toThrow(/younger than 30 days/);
  });
});
