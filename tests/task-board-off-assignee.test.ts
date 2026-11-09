/**
 * An instance with the task board switched off (`dashboard.task_board: false`) has no `task` tool: a card handed to it
 * would sit there unread, and its notices would ask it to use a tool it does not have. So the board takes it as no
 * card's new assignee — whoever writes, the person or an agent, through the board or the `task` tool's own tasks — and
 * the waker sends it nothing. What it had before keeps it; any other name (a person) is not one. The board's page
 * lists those instances so its pickers mark them.
 *
 * Isolation: temp databases; fake timers for the waker; a real FleetManager with no fleet (nothing spawns).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { TaskBoardError, type Actor, type TaskBoard, type Wake } from "../src/scheduler/task-board.js";
import { TaskBoardWaker } from "../src/task-board-waker.js";
import { taskBoardOffIn, taskBoardOffNames } from "../src/dashboard-permissions.js";
import { FleetManager } from "../src/fleet-manager.js";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const TOKEN = "c".repeat(48);

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0)) { try { c(); } catch { /* closed */ } }
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function board(off: (name: string) => boolean): { db: SchedulerDb; b: TaskBoard } {
  const dir = mkdtempSync(join(tmpdir(), "board-off-")); dirs.push(dir);
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  closers.push(() => db.close());
  db.board.setBoardOff(off);
  return { db, b: db.board };
}

/** The refusal's key and the name it gives, or null when `fn` passes. */
function refusal(fn: () => unknown): { key: string | undefined; args: unknown } | null {
  try { fn(); return null; } catch (err) {
    if (!(err instanceof TaskBoardError)) throw err;
    expect(err.code).toBe("forbidden");
    expect(err.message).toMatch(/task board switched off/);
    return { key: err.key, args: err.args };
  }
}
const OFF = { key: "assignee_board_off", args: ["quiet"] };

describe("the board takes no instance with the task board off as a new assignee", () => {
  const quiet = (n: string) => n === "quiet";

  it("opening a card for it is refused, by the person and by an agent; for anyone else it is not", () => {
    const { b } = board(quiet);
    expect(refusal(() => b.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "quiet" }] }))).toEqual(OFF);
    expect(refusal(() => b.createCards(LEAD, { cards: [{ title: "Leaderboard", assignee: "quiet" }] }))).toEqual(OFF);
    // A batch is one write: none of it is opened.
    expect(refusal(() => b.createCards(LEAD, { cards: [{ title: "API", assignee: "dev" }, { title: "Page", assignee: "quiet" }] }))).toEqual({ ...OFF, args: OFF.args });
    expect(b.listCards({}).total).toBe(0);
    expect(b.createCards(LEAD, { cards: [{ title: "API", assignee: "dev" }] }).cards[0]!.assignee).toBe("dev");
    expect(b.createCards(ANN, { cards: [{ title: "Unassigned" }] }).cards[0]!.assignee).toBeNull();
  });

  it("handing it a card is refused, and the card is left as it was", () => {
    const { b } = board(quiet);
    const card = b.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "dev" }] }).cards[0]!;
    expect(refusal(() => b.updateCard(ANN, card.code, { assignee: "quiet", comment: "yours now" }))).toEqual(OFF);
    const after = b.getCard(card.code);
    expect([after.assignee, after.version, b.entries(card.uuid, ["comment"]).length]).toEqual(["dev", card.version, 0]);
    expect(b.updateCard(ANN, card.code, { assignee: "rev" }).card.assignee).toBe("rev");
  });

  it("the `task` tool's own tasks too: opening one for it, and reassigning one to it", () => {
    const { b } = board(quiet);
    expect(refusal(() => b.legacyCreate(LEAD, { title: "Ping", assignee: "quiet" }))).toEqual(OFF);
    const task = b.legacyCreate(LEAD, { title: "Ping", assignee: "dev" });
    expect(refusal(() => b.legacyUpdate(LEAD, task.uuid, { assignee: "quiet" }))).toEqual(OFF);
    expect(b.findCard(task.code)?.assignee).toBe("dev");
  });

  it("what it had before keeps it: its cards stay its own, are edited, unassigned or handed to someone else", () => {
    let on = true;
    const { b } = board((n) => !on && n === "quiet");
    const card = b.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "quiet" }] }).cards[0]!;
    on = false;                                                          // switched off since
    expect(b.updateCard(ANN, card.code, { comment: "still there?", priority: "high" }).card.assignee).toBe("quiet");
    expect(b.updateCard(ANN, card.code, { assignee: null }).card.assignee).toBeNull();
    expect(refusal(() => b.updateCard(ANN, card.code, { assignee: "quiet" }))).toEqual(OFF);
    expect(b.updateCard(ANN, card.code, { assignee: "dev" }).card.assignee).toBe("dev");
  });

  it("control: with nobody's board off, the same writes pass", () => {
    const { b } = board(() => false);
    const card = b.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "quiet" }] }).cards[0]!;
    expect(b.updateCard(ANN, card.code, { assignee: "dev" }).card.assignee).toBe("dev");
    expect(b.legacyCreate(LEAD, { title: "Ping", assignee: "quiet" }).assignee).toBe("quiet");
  });
});

describe("which instances have it off, as fleet.yaml says", () => {
  it("each instance's own switch, else the defaults'; a name with no instance entry is no one's", () => {
    const fleet = { defaults: { dashboard: { task_board: false } }, instances: { lead: { dashboard: { task_board: true } }, dev: {}, rev: { dashboard: { appearance: false } } } };
    expect(["lead", "dev", "rev", "Ann", "toString"].map((n) => taskBoardOffIn(fleet, n))).toEqual([false, true, true, false, false]);
    expect(taskBoardOffNames(fleet)).toEqual(["dev", "rev"]);
    expect(taskBoardOffNames({ defaults: {}, instances: { dev: { dashboard: { task_board: false } }, lead: {} } })).toEqual(["dev"]);
    expect(taskBoardOffNames({ defaults: {}, instances: { dev: {} } })).toEqual([]);
    expect(taskBoardOffNames(null)).toEqual([]);
  });
});

describe("the waker sends no notice to an instance with the task board off", () => {
  const wake = (instance: string, code: string): Wake => ({ instance, uuid: `u-${code}`, code, title: code, parent: null, reasons: ["assigned"], by: { assigned: "Ann" }, texts: {} });
  function waker(off: Set<string>) {
    vi.useFakeTimers();
    const sent: string[] = [];
    const w = new TaskBoardWaker({
      deliver: (instance) => { sent.push(instance); return true; },
      isInstance: () => true,
      boardOff: (n) => off.has(n),
      holds: (x) => x, card: () => undefined, log: () => {},
    });
    closers.push(() => w.stop());
    return { w, sent };
  }

  it("its news is not sent; another instance's is", async () => {
    const { w, sent } = waker(new Set(["quiet"]));
    w.note([wake("quiet", "M-1"), wake("dev", "M-2")]);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(sent).toEqual(["dev"]);
  });

  it("switched off while its news was gathering: not handed over", async () => {
    const off = new Set<string>();
    const { w, sent } = waker(off);
    w.note([wake("quiet", "M-1"), wake("dev", "M-2")]);
    off.add("quiet");
    await vi.advanceTimersByTimeAsync(11_000);
    expect(sent).toEqual(["dev"]);
  });
});

describe("in a real FleetManager: read from fleet.yaml at each write and each wake", () => {
  it("refused while off, taken once switched on; a notice gathered meanwhile is dropped when it is switched off", async () => {
    vi.useFakeTimers();
    const d = mkdtempSync(join(tmpdir(), "board-off-fm-")); dirs.push(d);
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    const config = (quietOff: boolean) => ({ defaults: {}, instances: { lead: {}, quiet: quietOff ? { dashboard: { task_board: false } } : {} } });
    fm.fleetConfig = config(true);
    fm.ensureDeliveryOutbox();
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    closers.push(() => fm.taskBoardWaker?.stop(), () => fm.deliveryOutbox?.close?.(), () => scheduler.db.close());
    fm.attachTaskBoard(scheduler.db);
    const b: TaskBoard = scheduler.db.board;
    const notices = () => (fm.deliveryOutbox.db.prepare("SELECT target_instance AS t FROM deliveries WHERE kind='system_notice'").all() as Array<{ t: string }>).map((r) => r.t);

    expect(refusal(() => b.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "quiet" }] }))).toEqual(OFF);
    fm.fleetConfig = config(false);
    const card = b.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "quiet" }] }).cards[0]!;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notices()).toEqual(["quiet"]);

    b.updateCard(ANN, card.code, { assignee: "lead" });
    b.updateCard(ANN, card.code, { assignee: "quiet" });
    fm.fleetConfig = config(true);                                       // switched off during the gather
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notices()).toEqual(["quiet"]);
  }, 30_000);
});

function getBoard(db: SchedulerDb, fleetConfig: unknown) {
  const sessions = new WebSessionStore(), origin = "http://127.0.0.1:19280";
  const s = sessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(TOKEN) } as never);
  const headers = { host: new URL(origin).host, cookie: `agend_session=${s.sessionId}`, origin, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId) };
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/tasks/board", headers, destroy: vi.fn() });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
      end: (t = "") => resolve({ status, body: JSON.parse(String(t)) }) });
    handleWebRequest(req as never, res as never, new URL("/ui/tasks/board", origin), { webToken: TOKEN, webSessions: sessions, scheduler: { db }, fleetConfig,
      logger: { debug() {}, info() {}, warn() {}, error() {} } } as never);
    req.emit("end");
  });
}

describe("GET /ui/tasks/board names them for the pickers", () => {
  it("the instances with it off; a fleet.yaml change shows at once, the board's revision unchanged", async () => {
    const { db } = board(() => false);
    const fleet = (devOff: boolean) => ({ defaults: {}, instances: { lead: {}, dev: devOff ? { dashboard: { task_board: false } } : {} } });
    const first = await getBoard(db, fleet(true));
    expect([first.status, first.body.boardOff]).toEqual([200, ["dev"]]);
    const again = await getBoard(db, fleet(false));
    expect([again.body.rev, again.body.boardOff]).toEqual([first.body.rev, []]);
  });
});
