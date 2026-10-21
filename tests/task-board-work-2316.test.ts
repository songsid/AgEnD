/**
 * #2316 review: who works on what (GET /ui/tasks/work) costs a fixed few board reads, not a few per instance. The
 * board's workOf() answers every name in one read — the same answers as myWork(), what each agent's `task mine` reads
 * — and the route builds its answer once per board revision on the dashboard, shared by every open drawer.
 *
 * Isolation: temp databases; the web routes with a minimal context (web-task-board.test.ts's pattern).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";

const dirs: Array<{ dir: string; db: SchedulerDb }> = [];
afterEach(() => { for (const { dir, db } of dirs.splice(0)) { db.close(); rmSync(dir, { recursive: true, force: true }); } });
const ANN = { kind: "person" as const, name: "Ann" };
const TOKEN = "c".repeat(48);

function board(instances: number, perInstance: number) {
  const dir = mkdtempSync(join(tmpdir(), "task-board-work-"));
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  dirs.push({ dir, db });
  const b = db.board;
  const names = Array.from({ length: instances }, (_, i) => `dev-${i}`);
  for (const [i, name] of names.entries()) {
    // A main task it coordinates: a sub task in progress, one waiting for it, one nobody has, one done, one cancelled.
    const main = b.createCards(ANN, { cards: [{ title: `Feature ${i}`, assignee: name, priority: i % 2 ? "high" : "normal" }] }).cards[0]!;
    const [a, page, , done, gone] = b.createCards(ANN, { parent: main.code, cards: [
      { title: "API", assignee: name }, { title: "Page", assignee: names[(i + 1) % names.length] }, { title: "Review" },
      { title: "Spec", assignee: name }, { title: "Dropped", assignee: name },
    ] }).cards;
    b.updateCard(ANN, page!.code, { dependsOn: [a!.code] });
    b.moveCard(ANN, a!.code, "claimed");
    b.moveCard(ANN, done!.code, "claimed"); b.moveCard(ANN, done!.code, "done", { result: "ok" });
    b.moveCard(ANN, gone!.code, "cancelled");
    // Its own cards: in progress, blocked, waiting for the person, open (one waiting for another card), sent back.
    for (let k = 0; k < perInstance; k++) {
      const c = b.createCards(ANN, { cards: [{ title: `Task ${i}.${k}`, assignee: name, priority: (["urgent", "high", "normal", "low"] as const)[k % 4] }] }).cards[0]!;
      const step = k % 6;
      if (step === 1) b.moveCard(ANN, c.code, "claimed");
      if (step === 2) { b.moveCard(ANN, c.code, "claimed"); b.moveCard(ANN, c.code, "blocked", { reason: "which one?" }); }
      if (step === 3) { b.moveCard(ANN, c.code, "claimed"); b.moveCard(ANN, c.code, "review", { result: "done" }); }
      if (step === 4) b.updateCard(ANN, c.code, { dependsOn: [main.code] });
      if (step === 5) { b.moveCard(ANN, c.code, "claimed"); b.moveCard(ANN, c.code, "review", { result: "x" }); b.moveCard(ANN, c.code, "claimed", { reason: "redo it" }); }
      if (k % 3 === 0) b.updateCard(ANN, c.code, { comment: "a thought" });
    }
  }
  b.createCards(ANN, { cards: [{ title: "Someone else's", assignee: "Ann" }] });
  return { db, b, names: [...names, "Ann", "nobody-at-all"] };
}

/** Statements prepared while `fn` runs (the board prepares each statement it runs). */
function statements<T>(db: SchedulerDb, fn: () => T): { result: T; n: number } {
  const raw = (db.board as unknown as { db: { prepare: (sql: string) => unknown } }).db;
  const spy = vi.spyOn(raw, "prepare");
  try { const result = fn(); return { result, n: spy.mock.calls.length }; } finally { spy.mockRestore(); }
}

describe("workOf(): every name's myWork in one read", () => {
  it("the same answers as myWork() name by name", () => {
    const { b, names } = board(6, 12);
    const all = b.workOf(names);
    for (const name of names) expect(all.get(name), name).toEqual(b.myWork(name));
    expect(all.get("dev-0")!.mains.map((m) => m.progress)).toEqual([{ total: 4, open: 2, claimed: 1, blocked: 0, review: 0, done: 1 }]);
    expect(all.get("dev-0")!.sentBack.map((x) => x.entry.text)).toEqual(["redo it", "redo it"]);
  });

  it("three statements, however many names and cards; myWork() name by name grows with them", () => {
    const small = board(3, 6), big = board(30, 18);
    const s = statements(small.db, () => small.b.workOf(small.names)).n;
    const l = statements(big.db, () => big.b.workOf(big.names)).n;
    expect([s, l]).toEqual([3, 3]);
    expect(statements(big.db, () => big.names.map((n) => big.b.myWork(n))).n).toBeGreaterThan(100);
  });
});

function viaRoute(db: SchedulerDb, path: string, fleetConfig: unknown) {
  const sessions = new WebSessionStore(), origin = "http://127.0.0.1:19280";
  const s = sessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(TOKEN) } as never);
  const headers = { host: new URL(origin).host, cookie: `agend_session=${s.sessionId}`, origin, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" };
  return new Promise<{ status: number; text: string }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers, destroy: vi.fn() });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
      end: (t = "") => resolve({ status, text: String(t) }) });
    handleWebRequest(req as never, res as never, new URL(path, origin), { webToken: TOKEN, webSessions: sessions, scheduler: { db }, fleetConfig,
      logger: { debug() {}, info() {}, warn() {}, error() {} } } as never);
    req.emit("end");
  });
}

describe("GET /ui/tasks/work on the dashboard: built once per board revision, shared by every drawer", () => {
  it("a second read at the same revision reads no one's work again; a change does", async () => {
    const { db, b, names } = board(8, 6);
    const fleetConfig = { defaults: {}, instances: Object.fromEntries(names.slice(0, 8).map((n) => [n, {}])) };
    const workOf = vi.spyOn(b, "workOf");
    const first = await viaRoute(db, "/ui/tasks/work", fleetConfig);
    expect(first.status).toBe(200);
    const again = statements(db, () => viaRoute(db, "/ui/tasks/work", fleetConfig));
    expect((await again.result).text).toBe(first.text);
    expect(again.n).toBeLessThanOrEqual(2);                             // the revision and the names, nothing else
    expect(workOf).toHaveBeenCalledTimes(1);
    expect((await viaRoute(db, "/ui/tasks/work?instance=dev-1", fleetConfig)).text).not.toBe(first.text);   // another question
    b.moveCard(ANN, b.myWork("dev-0").ready[0]!.code, "claimed");
    const after = await viaRoute(db, "/ui/tasks/work", fleetConfig);
    expect(after.text).not.toBe(first.text);
    expect(workOf).toHaveBeenCalledTimes(3);
    expect(JSON.parse(after.text).instances.find((i: any) => i.name === "dev-0").doing.length).toBe(JSON.parse(first.text).instances.find((i: any) => i.name === "dev-0").doing.length + 1);
  });
});
