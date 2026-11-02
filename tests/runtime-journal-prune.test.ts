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
    const ids = new Set(stored(dir).tombstones.map((t: { id: string }) => t.id));
    expect(ids.size).toBe(65_541);                                     // 5 old ones evictable, 10 needed: only 5 go
    for (let i = 1; i <= 5; i++) expect(ids.has(uuid(i))).toBe(false);
    expect(ids.has(uuid(6))).toBe(true);
    for (let i = 0; i < 10; i++) expect(ids.has(uuid(100_000 + i))).toBe(true);
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
  });
});

describe("M-2239 P2-1: the client keeps its replay tombstones past 4096 and evicts only old ones", () => {
  const task = (n: number): WindowsCliTask => ({ id: `job-${String(n).padStart(12, "0")}`, cli: "codex", cwd: "C:\\t", sandbox: "read-only", status: "completed", startedAt: n, finishedAt: n + 1, output: "", outcomeConfirmed: true });
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
