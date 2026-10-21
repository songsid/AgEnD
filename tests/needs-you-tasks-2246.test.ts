/**
 * #2246 step 3: the task board in Needs you — cards waiting for the person, in each chat world's live list under their
 * assignee, with Confirm, Send back and Answer; Send back and Answer take words as a reply to the prompt the bot posts,
 * which only the admin who clicked may give. #2352: a card with a lane (the instance that handed it out, else its
 * project's lead) belongs to the lane's world. And in a real FleetManager: the board's cards become items, and a move
 * from the chat is the person's.
 *
 * Isolation: a fake clock and timers; fake adapters record every call; temp databases.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeedsYouHub, TASK_REPLY_TTL_MS, type NeedsYouHubContext, type TaskAction } from "../src/needs-you-hub.js";
import { deriveNeedsYou, type TaskInput } from "../src/needs-you.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const task = (over: Partial<TaskInput>): TaskInput => ({
  uuid: "u1", code: "M-1", title: "Weekly leaderboard", status: "review", version: 4, assignee: "alpha", note: "", since: 990_000, ...over,
});

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "needs-tasks-")); dirs.push(dir);
  let mono = 0, n = 0, id = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  const calls: string[] = [];
  const adapter = {
    type: "telegram",
    notifyAlert: vi.fn(async (chatId: string, alert: { message: string; choices?: Array<{ id: string; label: string }> }, opts?: { threadId?: string }) => {
      calls.push(`post ${alert.message.split("\n").join(" | ")} [${(alert.choices ?? []).map(c => c.label).join(", ")}]`);
      return { messageId: `m${++n}`, chatId, threadId: opts?.threadId };
    }),
    editAlert: vi.fn(async (_c: string, messageId: string, alert: { message: string; choices?: Array<{ label: string }> }) => {
      calls.push(`edit ${messageId} ${alert.message.split("\n").join(" | ")} [${(alert.choices ?? []).map(c => c.label).join(", ")}]`);
    }),
    deleteMessage: vi.fn(async () => {}),
    sendText: vi.fn(async (chatId: string, text: string, opts?: { threadId?: string; replyTo?: string }) => {
      calls.push(`say ${opts?.threadId ?? "-"}${opts?.replyTo ? ` ↩${opts.replyTo}` : ""} ${text}`);
      return { messageId: `s${++n}`, chatId };
    }),
  } as any;
  const state = { tasks: [] as TaskInput[], actions: [] as TaskAction[], outcome: { ok: true, message: "done" } };
  const ctx: NeedsYouHubContext = {
    dataDir: dir, now: () => 1_000_000, mono: () => mono,
    setTimer: (fn, ms) => { const h = ++id; timers.push({ at: mono + ms, fn, id: h }); return h; },
    clearTimer: h => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1); },
    prompts: () => [], instances: () => [], deliveries: () => [],
    ownerOf: i => (i === "alpha" ? "tg" : undefined),
    worlds: () => [{ id: "tg", place: { type: "telegram", groupId: "-100" }, adapter }],
    noticeTarget: () => ({ chatId: "-100", threadId: "1" }),
    instanceTopic: () => "77",
    isFleetAdmin: (u) => u === "100" || u === "101",
    fleetAdmins: () => ["100", "101"],
    emitSse: () => {}, acknowledge: () => true,
    settings: () => ({ liveMessage: true, dm: false }), stopping: () => false,
    t: (k, ...a) => `${k}${a.length ? `(${a.join(",")})` : ""}`,
    log: () => {},
    tasks: () => state.tasks,
    taskAction: (a) => { state.actions.push(a); return state.outcome; },
  };
  const hub = new NeedsYouHub(ctx);
  const advance = async (ms: number) => {
    const end = mono + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift(); mono = next.at; next.fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    mono = end;
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const choices = () => {
    const last = [...adapter.notifyAlert.mock.calls.map((c: any) => c[1].choices), ...adapter.editAlert.mock.calls.map((c: any) => c[2].choices)].at(-1) ?? [];
    return last as Array<{ id: string; label: string }>;
  };
  const click = (label: string, userId = "100", username = "ann") => {
    const choice = choices().find(c => c.label === label);
    if (!choice) throw new Error(`no button ${label} in ${JSON.stringify(choices().map(c => c.label))}`);
    const acks: string[] = [];
    const messageId = `m${adapter.notifyAlert.mock.calls.length}`;
    const handled = hub.handleCallback({ callbackData: choice.id, chatId: "-100", messageId, userId, username, ack: (n?: string) => acks.push(n ?? "") } as any, "tg");
    return { handled, acks };
  };
  return { hub, state, calls, advance, choices, click, adapter, tick: (ms: number) => { mono += ms; } };
}

describe("the board's cards as Needs you items", () => {
  it("under their assignee, with the card and what it asks or lacks; a laned card is its lane's world's (#2352)", () => {
    const worlds: Record<string, string> = { alpha: "tg", lead: "dc" };
    const items = deriveNeedsYou({ prompts: [], instances: [], deliveries: [], ownerOf: i => worlds[i], tasks: [
      task({ note: "not wrapped up: no result" }),
      task({ uuid: "u2", code: "S-5", title: "Build the API", status: "blocked", note: "Ties: same rank?", since: 980_000 }),
      task({ uuid: "u3", code: "S-7", lane: "lead" }),
      task({ uuid: "u4", code: "M-9", assignee: null }),
      task({ uuid: "u5", code: "M-10", assignee: null, lane: "lead" }),
    ] });
    expect(items.map(i => [i.id, i.reason, i.detail, i.owner ?? null, i.card?.code, i.lane ?? null])).toEqual([
      ["task:u2:blocked:980000", "task_blocked", "S-5 Build the API — Ties: same rank?", "tg", "S-5", null],
      ["task:u1:review:990000", "task_review", "M-1 Weekly leaderboard — not wrapped up: no result", "tg", "M-1", null],
      ["task:u3:review:990000", "task_review", "S-7 Weekly leaderboard", "dc", "S-7", "lead"],        // the lane's world, not alpha's
      ["task:u4:review:990000", "task_review", "M-9 Weekly leaderboard", null, "M-9", null],          // nobody's: listed under no instance
      ["task:u5:review:990000", "task_review", "M-10 Weekly leaderboard", "dc", "M-10", "lead"],      // nobody's, but its lead lists it
    ]);
  });
});

describe("the chat's live list: Confirm, Send back, Answer", () => {
  it("each card's line names it; a card to confirm gets Confirm and Send back, a blocked one Answer — three cards at most", async () => {
    const r = rig();
    r.state.tasks = [1, 2, 3, 4].map(k => task({ uuid: `u${k}`, code: `M-${k}`, since: 990_000 + k }));
    r.state.tasks[3] = task({ uuid: "u4", code: "S-4", status: "blocked", note: "which?", since: 990_000 });
    r.hub.start();
    await r.advance(0);
    expect(r.calls[0]).toBe("post needs.live_header(4) | • alpha — needs.reason.task_blocked: S-4 Weekly leaderboard — which? (<1m) | "
      + "• alpha — needs.reason.task_review: M-1 Weekly leaderboard (<1m) | • alpha — needs.reason.task_review: M-2 Weekly leaderboard (<1m) | "
      + "• alpha — needs.reason.task_review: M-3 Weekly leaderboard (<1m) "
      + "[needs.task_answer_button(S-4), needs.task_confirm_button(M-1), needs.task_back_button(M-1), needs.task_confirm_button(M-2), needs.task_back_button(M-2)]");
  });

  it("Confirm: the person's move at the version shown; another admin may, someone else may not", async () => {
    const r = rig();
    r.state.tasks = [task({})];
    r.hub.start();
    await r.advance(0);
    expect(r.click("needs.task_confirm_button(M-1)", "999")).toEqual({ handled: true, acks: ["buttons.admin_only"] });
    // A button's id names what it does: the same capability under another verb is no button at all.
    const forged = r.choices().find(c => c.label === "needs.task_confirm_button(M-1)")!.id.replace(/:confirm$/, ":back");
    const acks: string[] = [];
    r.hub.handleCallback({ callbackData: forged, chatId: "-100", messageId: "m1", userId: "100", ack: (n?: string) => acks.push(n ?? "") } as any, "tg");
    expect(acks).toEqual(["needs.ack_stale"]);
    expect(r.state.actions).toEqual([]);
    expect(r.click("needs.task_confirm_button(M-1)", "101", "bob")).toEqual({ handled: true, acks: ["done"] });
    expect(r.state.actions).toEqual([{ verb: "confirm", code: "M-1", version: 4, by: { platform: "telegram", userId: "101", username: "bob" } }]);
  });

  it("a newer card renders again, with buttons for its new version; the old ones are stale", async () => {
    const r = rig();
    r.state.tasks = [task({})];
    r.hub.start();
    await r.advance(0);
    const old = r.choices().find(c => c.label === "needs.task_confirm_button(M-1)")!;
    r.state.tasks = [task({ version: 5 })];
    r.hub.poke();
    await r.advance(20_000);
    expect(r.calls.at(-1)).toMatch(/^edit m1 /);
    const acks: string[] = [];
    r.hub.handleCallback({ callbackData: old.id, chatId: "-100", messageId: "m1", userId: "100", ack: (n?: string) => acks.push(n ?? "") } as any, "tg");
    expect(acks).toEqual(["needs.ack_stale"]);
    r.click("needs.task_confirm_button(M-1)");
    expect(r.state.actions.map(a => a.version)).toEqual([5]);
  });

  it("Send back: a prompt to reply to; the clicker's reply is the reason, and goes no further", async () => {
    const r = rig();
    r.state.tasks = [task({})];
    r.hub.start();
    await r.advance(0);
    expect(r.click("needs.task_back_button(M-1)")).toEqual({ handled: true, acks: ["needs.task_reply_asked"] });
    await r.advance(0);
    expect(r.calls.at(-1)).toBe(`say - needs.task_back_prompt(M-1, (@ann),${TASK_REPLY_TTL_MS / 60_000})`);   // in General
    const prompt = (await r.adapter.sendText.mock.results.at(-1).value).messageId;
    const reply = (over: Record<string, unknown>) => r.hub.handleReply({ adapterId: "tg", chatId: "-100", threadId: "1", replyTo: prompt, messageId: "in1", userId: "100", username: "ann", text: "ties share a rank", ...over });
    expect(reply({ userId: "101" })).toBe(false);                 // another admin's reply is a message like any other
    expect(reply({ replyTo: "m1" })).toBe(false);                 // a reply to something else, too
    expect(r.state.actions).toEqual([]);
    expect(reply({})).toBe(true);
    expect(r.state.actions).toEqual([{ verb: "back", code: "M-1", version: 4, text: "ties share a rank", by: { platform: "telegram", userId: "100", username: "ann" } }]);
    await r.advance(0);
    expect(r.calls.at(-1)).toBe("say 1 ↩in1 done");                // answered in place, to the reply
    expect(reply({ messageId: "in2" })).toBe(false);               // answered once: the prompt is spent
  });

  it("Answer a blocked card the same way; an empty reply changes nothing; a lapsed prompt is not ours", async () => {
    const r = rig();
    r.state.tasks = [task({ status: "blocked", note: "which?" })];
    r.hub.start();
    await r.advance(0);
    r.click("needs.task_answer_button(M-1)");
    await r.advance(0);
    let prompt = (await r.adapter.sendText.mock.results.at(-1).value).messageId;
    expect(r.hub.handleReply({ adapterId: "tg", chatId: "-100", threadId: "1", replyTo: prompt, messageId: "in1", userId: "100", text: "  " })).toBe(true);
    await r.advance(0);
    expect(r.calls.at(-1)).toBe("say 1 ↩in1 needs.task_reply_empty(M-1)");
    expect(r.state.actions).toEqual([]);
    r.click("needs.task_answer_button(M-1)");
    await r.advance(0);
    prompt = (await r.adapter.sendText.mock.results.at(-1).value).messageId;
    r.tick(TASK_REPLY_TTL_MS);
    expect(r.hub.handleReply({ adapterId: "tg", chatId: "-100", threadId: "1", replyTo: prompt, messageId: "in2", userId: "100", text: "codes" })).toBe(false);
    expect(r.state.actions).toEqual([]);
  });
});

describe("in the fleet: the board's cards in Needs you, and a move from the chat", () => {
  it("cards to confirm and blocked ones are items; the chat's move is the person's, and a stale one says so", () => {
    const d = mkdtempSync(join(tmpdir(), "needs-tasks-fm-")); dirs.push(d);
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { "dev-a": {}, lead: {} } };
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.scheduler = scheduler;
    const board = scheduler.db.board;
    const ann = { kind: "person" as const, name: "Ann" }, dev = { kind: "instance" as const, name: "dev-a" };
    const mine = board.createCards(ann, { cards: [{ title: "Leaderboard", assignee: "dev-a", acceptance: ["top 100"] }] }).cards[0]!;
    const theirs = board.createCards({ kind: "instance", name: "lead" }, { cards: [{ title: "Archive", assignee: "dev-a" }] }).cards[0]!;
    board.moveCard(dev, mine.code, "claimed");
    board.moveCard(ann, mine.code, "review");                                 // not wrapped up: no result, the checklist unticked
    board.moveCard(ann, theirs.code, "claimed");
    board.moveCard(ann, theirs.code, "blocked", { reason: "which season?" });
    const items = fm.needsYouTasks() as TaskInput[];
    // #2352: "lead" handed `theirs` out, but it has no channel here (no world, no topic): General, as before.
    expect(items.map(i => [i.code, i.status, i.assignee, i.lane ?? null, i.note])).toEqual([
      [mine.code, "review", "dev-a", null, "not wrapped up: 1 checklist item(s) unchecked, no result"],
      [theirs.code, "blocked", "dev-a", null, "which season?"],
    ]);
    const version = board.getCard(mine.code).version;
    const by = { platform: "telegram", userId: "100", username: "ann_tg" };
    expect(fm.taskActionFromChat({ verb: "confirm", code: mine.code, version: version - 1, by }).ok).toBe(false);
    expect(fm.taskActionFromChat({ verb: "back", code: mine.code, version, text: "tick the checklist", by }).ok).toBe(true);
    expect(board.getCard(mine.code).status).toBe("claimed");
    expect(board.detail(mine.code).comments.map((e: any) => [e.kind, e.author, e.authorKind, e.text])).toEqual([["reject", "ann_tg", "person", "tick the checklist"]]);
    expect(fm.taskActionFromChat({ verb: "answer", code: theirs.code, version: board.getCard(theirs.code).version, text: "the current one", by }).ok).toBe(true);
    expect(board.getCard(theirs.code).status).toBe("claimed");
    scheduler.db.close();
  });
});
