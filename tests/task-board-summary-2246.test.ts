/**
 * #2246 step 3: the task board's daily summary (src/task-board-summary.ts) — taskhall's: once a day at
 * defaults.task_board.summary_at in the fleet's zone, what waits for the person, what is blocked, what got done and
 * what is new since the last one, and each project's progress; a quiet day sends nothing, a missed one goes out when
 * the fleet is back. In a real FleetManager: each chat world's General gets its own instances' cards, and the web chat
 * the same text.
 *
 * Isolation: temp directories and databases; fake adapters; the clock's time is given, never the machine's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskBoardSummaryClock, buildSummary, isQuiet, renderSummary, summaryMarkFile, summaryTime, wallClock, type SummaryMark } from "../src/task-board-summary.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale, t } from "../src/locale.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { EventEmitter } from "node:events";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { WEB_CHAT_CARDS_MAX, WEB_CHAT_CARDS_OVERFLOW, WebChatHistory, type StoredWebChatMessage } from "../src/web-chat-history.js";

const dirs: string[] = [];
afterEach(() => { setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "board-summary-")); dirs.push(d); return d; };
const schedulerIn = (d: string, now?: () => Date) => {
  const s = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
  if (now) (s.db.board as unknown as { now: () => Date }).now = now;
  return s;
};

describe("defaults.task_board.summary_at", () => {
  // #2425: off unless set (2.3.0-beta.25); a fleet that names a time keeps it.
  it("off when not set; a time named is kept; off turns it off; anything else is refused by the validator", () => {
    expect([summaryTime(undefined), summaryTime(null)]).toEqual([null, null]);
    expect(summaryTime("18:30")).toBe("18:30");
    expect(summaryTime(" OFF ")).toBeNull();
    for (const bad of ["9am", "24:00", "9:00", 900, true]) expect(summaryTime(bad)).toBeUndefined();
    const errors = (defaults: unknown) => validateFleetConfig({ defaults, instances: {} }).errors.filter((e) => e.path.includes("task_board")).map((e) => `${e.path}: ${e.message}`);
    expect(errors({ task_board: { summary_at: "07:45" } })).toEqual([]);
    expect(errors({ task_board: { summary_at: "off" } })).toEqual([]);
    expect(errors({ task_board: { summary_at: "9am" } }).join()).toMatch(/summary_at.*"09:00".*"off"/);
    expect(errors({ task_board: "09:00" }).join()).toMatch(/task_board.*mapping/);
  });
});

describe("the clock: once a calendar day, after its time, in the fleet's zone", () => {
  function clock(opts: { at?: string | null; zone?: string; mark?: SummaryMark | null } = {}) {
    let now = new Date("2026-10-20T00:30:00Z");                       // 08:30 in Taipei
    let mark: SummaryMark | null = opts.mark ?? null;
    const sent: Array<[string, string]> = [];
    const make = () => new TaskBoardSummaryClock({
      at: () => (opts.at === undefined ? "09:00" : opts.at), zone: () => opts.zone ?? "Asia/Taipei", now: () => now,
      mark: { read: () => mark, write: (m) => { mark = m; } },
      send: (since, until) => sent.push([since.toISOString(), until.toISOString()]),
    });
    return { make, sent, set: (iso: string) => { now = new Date(iso); }, mark: () => mark };
  }

  it("the first day only marks (nothing to look back on); the next morning covers from then; not twice a day, not after a restart", () => {
    const c = clock();
    const a = c.make();
    expect(a.tick()).toBe(false);                                       // 08:30: not yet
    c.set("2026-10-20T01:01:00Z");                                      // 09:01
    expect(a.tick()).toBe(false);
    expect(c.mark()).toEqual({ date: "2026-10-20", until: "2026-10-20T01:01:00.000Z" });
    expect(c.sent).toEqual([]);
    c.set("2026-10-21T01:00:00Z");                                      // the next day, 09:00
    expect(a.tick()).toBe(true);
    expect(c.sent).toEqual([["2026-10-20T01:01:00.000Z", "2026-10-21T01:00:00.000Z"]]);
    c.set("2026-10-21T05:00:00Z");
    expect(a.tick()).toBe(false);                                       // once a day
    expect(c.make().tick()).toBe(false);                                // a restart reads the same mark
    expect(c.sent).toHaveLength(1);
  });

  it("missed while the fleet was down: it goes out when it is back that day, covering since the last one — at most a week", () => {
    const c = clock({ mark: { date: "2026-10-10", until: "2026-10-10T01:00:00.000Z" } });
    c.set("2026-10-20T07:00:00Z");                                      // 15:00, ten days later
    expect(c.make().tick()).toBe(true);
    expect(c.sent).toEqual([["2026-10-13T07:00:00.000Z", "2026-10-20T07:00:00.000Z"]]);
  });

  it("the day turns in the fleet's zone, not UTC; off sends nothing", () => {
    const c = clock({ zone: "Asia/Taipei", mark: { date: "2026-10-20", until: "2026-10-20T01:00:00.000Z" } });
    c.set("2026-10-20T16:30:00Z");                                      // 00:30 on the 21st in Taipei: before 09:00
    expect(c.make().tick()).toBe(false);
    c.set("2026-10-21T01:00:00Z");
    expect(c.make().tick()).toBe(true);
    expect(wallClock(new Date("2026-10-20T16:30:00Z"), "Asia/Taipei")).toEqual({ date: "2026-10-21", time: "00:30" });
    expect(wallClock(new Date("2026-10-20T16:30:00Z"), "Not/AZone")).toEqual({ date: "2026-10-20", time: "16:30" });
    const off = clock({ at: null, mark: { date: "2026-10-01", until: "2026-10-01T01:00:00.000Z" } });
    off.set("2026-10-21T05:00:00Z");
    expect(off.make().tick()).toBe(false);
    expect(off.mark()).toEqual({ date: "2026-10-01", until: "2026-10-01T01:00:00.000Z" });
  });

  it("a look that throws is logged, and the clock keeps looking", () => {
    vi.useFakeTimers();
    try {
      const failed: unknown[] = [];
      let looks = 0;
      const c = new TaskBoardSummaryClock({
        at: () => "09:00", zone: () => "UTC", now: () => new Date("2026-10-21T10:00:00Z"), send: () => {},
        mark: { read: () => { looks++; throw new Error("gone"); }, write: () => {} }, failed: (err) => failed.push(err),
      });
      c.start();
      vi.advanceTimersByTime(65_000);
      c.stop();
      vi.advanceTimersByTime(120_000);
      expect(looks).toBe(2);                                            // 5 s, then 60 s; none after stop
      expect(failed.map((e) => (e as Error).message)).toEqual(["gone", "gone"]);
    } finally { vi.useRealTimers(); }
  });

  it("the mark lives in a file: a missing or broken one is no mark", () => {
    const d = tempDir();
    const file = summaryMarkFile(join(d, "task-board-summary.json"));
    expect(file.read()).toBeNull();
    file.write({ date: "2026-10-20", until: "2026-10-20T01:00:00.000Z" });
    expect(file.read()).toEqual({ date: "2026-10-20", until: "2026-10-20T01:00:00.000Z" });
    writeFileSync(join(d, "task-board-summary.json"), "{not json");
    expect(file.read()).toBeNull();
  });
});

/** A board: a project with a main task waiting, one blocked, one done in the window with a done sub task, one new. */
function seeded(d: string) {
  let clock = new Date("2026-10-19T02:00:00Z");
  const scheduler = schedulerIn(d, () => clock);
  const board = scheduler.db.board;
  const ann = { kind: "person" as const, name: "Ann" };
  board.createProject(ann, { name: "Fishing", description: "" });
  const make = (title: string, extra: Record<string, unknown> = {}) => board.createCards(ann, { project: "Fishing", cards: [{ title, ...extra }] }).cards[0]!;
  const old = make("Old work", { assignee: "dev-a" });
  board.moveCard(ann, old.code, "claimed"); board.moveCard(ann, old.code, "done", { result: "ok" });
  clock = new Date("2026-10-20T02:00:00Z");                           // the window: 10/20 01:00 – 10/21 01:00
  const review = make("Rewards API", { assignee: "dev-a" });
  board.moveCard(ann, review.code, "claimed"); board.moveCard(ann, review.code, "review", { result: "POST /rewards" });
  const blocked = make("Event page", { assignee: "dev-b" });
  board.moveCard(ann, blocked.code, "claimed"); board.moveCard(ann, blocked.code, "blocked", { reason: "keep the page after the event?" });
  const done = make("Login fix", { assignee: "dev-a" });
  const sub = board.createCards(ann, { cards: [{ parent: done.code, title: "Token expiry", assignee: "dev-a" }] }).cards[0]!;
  board.moveCard(ann, sub.code, "claimed"); board.moveCard(ann, sub.code, "done", { result: "fixed" });
  board.moveCard(ann, done.code, "done");
  const fresh = make("Weekly leaderboard");
  return { scheduler, board, review, blocked, done, sub, fresh, old };
}

describe("what it says", () => {
  it("waiting, blocked (with the question), done and new — a main task a line, sub tasks folded — and the project's progress", () => {
    setLocale("en");
    const d = tempDir();
    const { scheduler, board, review, blocked, done, sub, fresh } = seeded(d);
    const since = new Date("2026-10-20T01:00:00Z"), until = new Date("2026-10-21T01:00:00Z");
    const read = board.summaryRead(since.toISOString(), until.toISOString());
    const projects = board.listProjects(true);
    const s = buildSummary(read, since, until, { inChat: () => true, projects, stats: board.projectStats() });
    expect(isQuiet(s)).toBe(false);
    const text = renderSummary(s, { zone: "Asia/Taipei", t, projectOf: (c) => projects.find((p) => p.id === c.projectId)?.name ?? null });
    expect(text).toBe([
      "📋 Task board — daily summary, 10/20 09:00 – 10/21 09:00",
      `Waiting for your confirmation (1)\n• ${review.code} "Rewards API" · Fishing`,
      `Blocked (1)\n• ${blocked.code} "Event page" · Fishing @dev-b: keep the page after the event?`,
      `Done (2)\n• ${done.code} "Login fix" · Fishing\n• 1 sub task(s): ${sub.code}`,
      `New (5)\n• ${review.code} "Rewards API" · Fishing\n• ${blocked.code} "Event page" · Fishing\n• ${done.code} "Login fix" · Fishing\n• ${fresh.code} "Weekly leaderboard" · Fishing\n• 1 sub task(s): ${sub.code}`,
      "Projects\n• Fishing 40% (2/5), 1 waiting for you, 1 blocked",
      "The board: Fleet › Tasks on the dashboard.",
    ].join("\n\n"));
    setLocale("zh-TW");
    expect(renderSummary(s, { zone: "Asia/Taipei", t, projectOf: () => "捕魚機" }).split("\n\n").slice(0, 3)).toEqual([
      "📋 任務看板每日摘要 10/20 09:00 – 10/21 09:00",
      `等你確認（1）\n• ${review.code}「Rewards API」 · 捕魚機`,
      `卡住（1）\n• ${blocked.code}「Event page」 · 捕魚機 @dev-b：keep the page after the event?`,
    ]);
    scheduler.db.close();
  });

  it("a chat lists only its instances' cards and their projects; a day when nothing waits and nothing moved is quiet", () => {
    const d = tempDir();
    const { scheduler, board } = seeded(d);
    const since = new Date("2026-10-20T01:00:00Z"), until = new Date("2026-10-21T01:00:00Z");
    const read = board.summaryRead(since.toISOString(), until.toISOString());
    const only = (who: string) => buildSummary(read, since, until, { inChat: (a) => a === who, projects: board.listProjects(true), stats: board.projectStats() });
    const b = only("dev-b");
    expect([b.review, b.blocked, b.done, b.created].map((l) => l.map((c) => c.title))).toEqual([[], ["Event page"], [], ["Event page"]]);
    expect(b.projects.map((p) => p.name)).toEqual(["Fishing"]);
    expect(isQuiet(only("someone-else"))).toBe(true);
    expect(only("someone-else").projects).toEqual([]);
    const later = board.summaryRead("2026-10-22T00:00:00.000Z", "2026-10-23T00:00:00.000Z");
    expect(later.done).toEqual([]);
    expect(later.created).toEqual([]);
    scheduler.db.close();
  });
});

describe("in the fleet: each chat world's General gets its own instances' cards; the web chat the same text", () => {
  it("two worlds: dev-a's cards in Telegram, dev-b's in Discord, nobody's in the primary one; a quiet world gets nothing", () => {
    setLocale("en");
    const d = tempDir();
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    const { scheduler } = seeded(d);
    fm.scheduler = scheduler;
    fm.fleetConfig = {
      defaults: { scheduler: { default_timezone: "Asia/Taipei" } },
      channels: [{ id: "tg", type: "telegram", group_id: -100 }, { id: "dc", type: "discord", group_id: "guild" }],
      instances: {
        "general-tg": { general_topic: true, topic_id: 1, channel_id: "tg" }, "general-dc": { general_topic: true, topic_id: "c9", channel_id: "dc" },
        "dev-a": { channel_id: "tg" }, "dev-b": { channel_id: "dc" },
      },
    };
    const sent: Record<string, Array<[string, string, unknown]>> = { tg: [], dc: [] };
    for (const id of ["tg", "dc"]) fm.worlds.set(id, { id, adapter: { sendText: vi.fn(async (chat: string, text: string, opts: unknown) => { sent[id]!.push([chat, text, opts]); return { messageId: "1" }; }) } });
    const web: Array<{ instance: string; role: string; text: string }> = [];
    fm.emitSseEvent = (event: string, data: any) => { if (event === "message") web.push({ instance: data.instance, role: data.role, text: data.text }); };
    fm.postTaskBoardSummary(new Date("2026-10-20T01:00:00Z"), new Date("2026-10-21T01:00:00Z"));
    expect(sent.tg!.map(([chat, , opts]) => [chat, opts])).toEqual([["-100", { threadId: "1" }]]);
    expect(sent.dc!.map(([chat, , opts]) => [chat, opts])).toEqual([["guild", { threadId: "c9" }]]);
    const tg = sent.tg![0]![1], dc = sent.dc![0]![1];
    expect(tg).toContain('"Rewards API"');
    expect(tg).toContain('"Weekly leaderboard"');                       // nobody's: the primary world's
    expect(tg).not.toContain("Event page");
    expect(dc).toContain('"Event page"');
    expect(dc).not.toContain("Rewards API");
    expect(dc).not.toContain("Weekly leaderboard");
    expect(web).toEqual([{ instance: "general-tg", role: "status", text: tg }, { instance: "general-dc", role: "status", text: dc }]);
    // A world whose instances did nothing and wait for nothing hears nothing.
    fm.fleetConfig.instances["dev-b"] = { channel_id: "tg" };
    for (const k of ["tg", "dc"] as const) sent[k]!.length = 0;
    web.length = 0;
    fm.postTaskBoardSummary(new Date("2026-10-20T01:00:00Z"), new Date("2026-10-21T01:00:00Z"));
    expect([sent.tg!.length, sent.dc!.length]).toEqual([1, 0]);
    expect(web.map((m) => m.instance)).toEqual(["general-tg"]);
    scheduler.db.close();
  });

  it("a web-only fleet: everything, in the General's web chat", () => {
    setLocale("en");
    const d = tempDir();
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    const { scheduler } = seeded(d);
    fm.scheduler = scheduler;
    fm.fleetConfig = { defaults: {}, instances: { general: { general_topic: true }, "dev-a": {}, "dev-b": {} } };
    const web: Array<{ instance: string; text: string }> = [];
    fm.emitSseEvent = (event: string, data: any) => { if (event === "message") web.push({ instance: data.instance, text: data.text }); };
    fm.postTaskBoardSummary(new Date("2026-10-20T01:00:00Z"), new Date("2026-10-21T01:00:00Z"));
    expect(web.map((m) => m.instance)).toEqual(["general"]);
    expect(web[0]!.text).toMatch(/Rewards API[\s\S]*Event page/);
    scheduler.db.close();
  });
});

/** One read through the real web routes as the public link's page (a gateway admin session) or the local page. */
function read(fm: Record<string, any>, path: string, local = false) {
  const TOKEN = "c".repeat(48);
  const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com", origin = local ? "http://127.0.0.1:19280" : pub;
  const s = sessions.create({ tier: "admin", surface: local ? "local" : "gateway", exposureId: local ? undefined : exposureId, label: "t", tokenEpoch: tokenEpoch(TOKEN) } as never);
  const headers = { host: new URL(origin).host, cookie: `${local ? "" : "__Host-"}agend_session=${s.sessionId}`, origin, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId) };
  return new Promise<any>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers, destroy: vi.fn() });
    if (!local) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead() {}, end: (t = "") => resolve(t ? JSON.parse(String(t)) : null) });
    handleWebRequest(req as never, res as never, new URL(path, origin), { webToken: TOKEN, webSessions: sessions, scheduler: fm.scheduler, fleetConfig: fm.fleetConfig,
      webChatHistory: fm.webChatHistory, logger: { debug() {}, info() {}, warn() {}, error() {} }, getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [], needsYouItems: () => [] } as never);
    req.emit("end");
  });
}

describe("over the public link, the summary is withheld while it names a card hidden there (#2341 review)", () => {
  function fleetWithHidden() {
    setLocale("en");
    const d = tempDir();
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    let clock = new Date("2026-10-20T02:00:00Z");
    const scheduler = schedulerIn(d, () => clock);
    fm.scheduler = scheduler;
    fm.fleetConfig = { defaults: {}, instances: { general: { general_topic: true }, "dev-a": {}, secret: { cross_instance_visibility: "hidden" } } };
    const b = scheduler.db.board;
    const make = (actor: { kind: "person" | "instance"; name: string }, title: string, assignee: string) => b.createCards(actor, { cards: [{ title, assignee }] }).cards[0]!;
    const hidden = make({ kind: "instance", name: "secret" }, "HIDDEN_CARD_TITLE_2341", "dev-a");          // handed out by the hidden one
    b.moveCard(ANN_, hidden.code, "claimed"); b.moveCard(ANN_, hidden.code, "blocked", { reason: "PRIVATE_BLOCKED_REASON_2341" });
    const open = make(ANN_, "Visible work", "dev-a");
    void clock; clock = new Date("2026-10-21T02:00:00Z");
    return { fm, scheduler, b, hidden, open };
  }
  const ANN_ = { kind: "person" as const, name: "Ann" };
  const summaries = (body: any) => (body.messages as any[]).filter((m) => m.role === "status").map((m) => m.text as string);

  it("a card hidden from the start: the link's poll and history leave the summary out; the local page has it, with the cards it names", async () => {
    const { fm, scheduler, hidden } = fleetWithHidden();
    fm.postTaskBoardSummary(new Date("2026-10-20T01:00:00Z"), new Date("2026-10-21T01:00:00Z"));
    const local = await read(fm, "/ui/history?instance=general", true);
    expect(summaries(local)).toHaveLength(1);
    expect(summaries(local)[0]).toContain("HIDDEN_CARD_TITLE_2341");
    expect(local.messages[0].cards).toContain(hidden.code);
    for (const path of ["/ui/history?instance=general", "/ui/poll"]) {
      const link = await read(fm, path);
      expect(summaries(link), path).toEqual([]);
      expect(JSON.stringify(link), path).not.toMatch(/HIDDEN_CARD_TITLE_2341|PRIVATE_BLOCKED_REASON_2341/);
    }
    // Shown again (the instance no longer hidden): the summary is the link's to read.
    fm.fleetConfig.instances.secret = {};
    expect(summaries(await read(fm, "/ui/poll"))).toHaveLength(1);
    scheduler.db.close();
  });

  it("a card hidden after the summary was written: withheld from then on; a summary naming only visible cards stays readable", async () => {
    const { fm, scheduler, b, hidden } = fleetWithHidden();
    fm.fleetConfig.instances.secret = {};                                // visible when the summary is written
    fm.postTaskBoardSummary(new Date("2026-10-20T01:00:00Z"), new Date("2026-10-21T01:00:00Z"));
    b.moveCard(ANN_, hidden.code, "claimed"); b.moveCard(ANN_, hidden.code, "cancelled");
    b.createCards(ANN_, { cards: [{ title: "New visible work", assignee: "dev-a" }] });                // new in the next window
    fm.postTaskBoardSummary(new Date("2026-10-21T01:00:00Z"), new Date("2026-10-22T01:00:00Z"));   // names only the visible one
    expect(summaries(await read(fm, "/ui/poll"))).toHaveLength(2);
    fm.fleetConfig.instances.secret = { cross_instance_visibility: "hidden" };
    const link = summaries(await read(fm, "/ui/poll"));
    expect(link).toHaveLength(1);
    expect(link[0]).not.toContain("HIDDEN_CARD_TITLE_2341");
    expect(summaries(await read(fm, "/ui/history?instance=general", true))).toHaveLength(2);    // the local page: both
    // A card the board no longer has (pruned) cannot be told visible: the line that names it is withheld too.
    fm.fleetConfig.instances.secret = {};
    (scheduler.db.board as any).db.prepare("DELETE FROM tasks WHERE title = ?").run("New visible work");
    expect(summaries(await read(fm, "/ui/poll"))).toHaveLength(1);
    scheduler.db.close();
  });

  it("#2341 review r2: past the cap of cards a line keeps, the line is withheld whole on the link — never a truncated list that lost a hidden card", async () => {
    const run = async (visible: number, withHidden: boolean) => {
      const { fm, scheduler, b, hidden } = fleetWithHidden();
      if (!withHidden) { b.moveCard(ANN_, hidden.code, "claimed"); b.moveCard(ANN_, hidden.code, "cancelled"); }
      // `visible` cards waiting for confirmation: the summary lists those before the blocked one.
      for (let i = 0; i < visible; i += 30) {
        const made = b.createCards(ANN_, { cards: Array.from({ length: Math.min(30, visible - i) }, (_, k) => ({ title: `Visible ${i + k}`, assignee: "dev-a" })) }).cards;
        for (const c of made) { b.moveCard(ANN_, c.code, "claimed"); b.moveCard(ANN_, c.code, "review", { result: "ok" }); }
      }
      fm.postTaskBoardSummary(new Date("2026-10-20T01:00:00Z"), new Date("2026-10-21T01:00:00Z"));
      const local = summaries(await read(fm, "/ui/history?instance=general", true));
      const link = { history: summaries(await read(fm, "/ui/history?instance=general")), poll: summaries(await read(fm, "/ui/poll")) };
      scheduler.db.close();
      return { local: local.length, history: link.history.length, poll: link.poll.length, leaked: JSON.stringify(link).includes("HIDDEN_CARD_TITLE_2341") };
    };
    // The fixture's own "Visible work" is new in the window too, so a run names `visible` + 1 (+ 1 with the hidden one).
    // 499 waiting + the hidden one + "Visible work": 501 cards, over the cap — withheld on the link, kept locally.
    expect(await run(499, true)).toEqual({ local: 1, history: 0, poll: 0, leaked: false });
    // 498 + the hidden one + "Visible work": 500, at the cap — every code kept, the hidden one among them: withheld.
    expect(await run(498, true)).toEqual({ local: 1, history: 0, poll: 0, leaked: false });
    // 499 + "Visible work", nothing hidden: 500, at the cap — readable on the link.
    expect(await run(499, false)).toMatchObject({ local: 1, history: 1, poll: 1 });
    // 500 + "Visible work", nothing hidden: 501 — over the cap, withheld though nothing is hidden (fail closed).
    expect(await run(500, false)).toMatchObject({ local: 1, history: 0, poll: 0 });
  }, 60_000);

  it("the overflow marker is kept on disk and across a restart: the row stays withheld on the link", () => {
    let rows: StoredWebChatMessage[] = [];
    const h = new WebChatHistory({ boot: "aa", store: { schedule: (_i, snap) => { rows = snap(); }, remove: async () => {} } });
    h.record({ instance: "general", sender: "general", role: "status", text: "big summary", ts: "2026-10-21T01:00:00Z",
      cards: Array.from({ length: WEB_CHAT_CARDS_MAX + 1 }, (_, i) => `M-${i + 1}`) });
    expect(rows.map((r) => r.cards)).toEqual([[WEB_CHAT_CARDS_OVERFLOW]]);
    const next = new WebChatHistory({ boot: "bb" });
    next.restore("general", rows);
    expect(next.list("general", 10).map((m) => m.cards)).toEqual([[WEB_CHAT_CARDS_OVERFLOW]]);
  });

  it("the cards a summary names stay with it across a restart (the row on disk), and only a status line carries them", () => {
    let rows: StoredWebChatMessage[] = [];
    const h = new WebChatHistory({ boot: "aa", store: { schedule: (_i, snap) => { rows = snap(); }, remove: async () => {} } });
    h.record({ instance: "general", sender: "general", role: "status", text: "summary", ts: "2026-10-21T01:00:00Z", cards: ["M-1", "S-2", "M-1", "x", 3] });
    h.record({ instance: "general", sender: "ann", role: "user", text: "hi", ts: "2026-10-21T01:00:01Z", cards: ["M-9"] });
    expect(rows.map((r) => r.cards)).toEqual([["M-1", "S-2"], undefined]);
    const next = new WebChatHistory({ boot: "bb" });
    next.restore("general", [...rows, { ...rows[1]!, id: 3, cards: ["M-7"] }]);
    expect(next.list("general", 10).map((m) => m.cards)).toEqual([["M-1", "S-2"], undefined, undefined]);
  });
});
