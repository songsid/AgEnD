/**
 * #1823: poll mode for a reply's buttons — a Kahoot-style timed vote. Design: issue #1823.
 *
 * The module and the store directly; then the real FleetManager reply path, click dispatch, store (reply-buttons.db in a
 * scratch dir) and delivery outbox (delivery-outbox.db, also scratch), with recording adapters; then the real Telegram
 * and Discord adapters against stubbed platform APIs. Nothing starts a fleet, tmux or a process.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { TelegramAdapter, telegramPollKeyboard } from "../src/channel/adapters/telegram.js";
import { DiscordAdapter, discordPollRows } from "../src/channel/adapters/discord.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import type { ChannelConfig } from "../src/types.js";
import { ReplyButtonStore, replyButtonCallback } from "../src/reply-buttons.js";
import {
  POLL_CLOSED_CALLBACK, POLL_STATUS_CALLBACK, nextBallot, parsePoll, pollCounts, pollRemaining, pollRender, pollResultsText,
  pollTickMs, pollVoteNotice, pollVotersText, type PollBallot, type PollConfig,
} from "../src/reply-polls.js";

const dirs: string[] = [];
const fleets: FleetManager[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fm of fleets.splice(0)) {
    const any = fm as any;
    any.replyButtonsCtl?.stop(); any.replyButtonsStore?.close();
    try { any.deliveryOutbox?.close(); } catch { /* closed */ }
  }
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1823-")); dirs.push(d); return d; };
const BUTTONS = [{ label: "Paris", value: "Paris" }, { label: "London", value: "London" }, { label: "Rome", value: "rome-it" }];
const POLL: PollConfig = { seconds: 30, multi: false, reveal: "close", showVoters: false, question: "Capital of France?" };

// ── the module ──

describe("the poll argument", () => {
  const parse = (raw: unknown, buttons = BUTTONS, text: unknown = "Capital of France?") => parsePoll(raw, buttons, text);
  it("defaults: one choice, revealed at close, counts only; the question is the reply's text, one line, cut", () => {
    expect(parse(undefined)).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse({ seconds: 30 })).toEqual({ poll: { seconds: 30, multi: false, reveal: "close", showVoters: false, question: "Capital of France?" } });
    expect(parse({ seconds: 10, multi: true, reveal: "live", show_voters: true }, BUTTONS, "  a\n b  ")).toEqual({ poll: { seconds: 10, multi: true, reveal: "live", showVoters: true, question: "a b" } });
    const long = parse({ seconds: 86400 }, BUTTONS, "q".repeat(400));
    expect(long && "poll" in long ? long.poll.question : "").toHaveLength(300);
  });
  it.each([
    ["no buttons", { seconds: 30 }, null, /at least 2 buttons/],
    ["one button", { seconds: 30 }, BUTTONS.slice(0, 1), /at least 2 buttons/],
    ["9 seconds", { seconds: 9 }, BUTTONS, /from 10 to 86400/],
    ["more than 24 h", { seconds: 86401 }, BUTTONS, /from 10 to 86400/],
    ["a fraction", { seconds: 30.5 }, BUTTONS, /whole number/],
    ["no seconds", {}, BUTTONS, /seconds must be/],
    ["seconds as text", { seconds: "30" }, BUTTONS, /seconds must be/],
    ["multi not a boolean", { seconds: 30, multi: "yes" }, BUTTONS, /multi must be/],
    ["an unknown reveal", { seconds: 30, reveal: "never" }, BUTTONS, /reveal must be/],
    ["show_voters not a boolean", { seconds: 30, show_voters: 1 }, BUTTONS, /show_voters must be/],
    ["an unknown key", { seconds: 30, anonymous: true }, BUTTONS, /poll\.anonymous is not a poll option/],
    ["not an object", [30], BUTTONS, /poll must be/],
  ])("refuses %s", (_n, raw, buttons, error) => {
    const r = parsePoll(raw, buttons, "q");
    expect(r && "error" in r ? r.error : null).toMatch(error);
  });
});

describe("a ballot, the tally and what is shown", () => {
  it("the voter's notice fits a Telegram toast (200 characters), however many long options are picked", () => {
    const labels = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(80));
    const notice = pollVoteNotice(labels, [0, 1, 2, 3, 4]);
    expect(notice.length).toBe(200);
    expect(notice.endsWith("…")).toBe(true);
    expect(pollVoteNotice(["Paris"], [0])).toBe("✓ Your vote: Paris");
  });
  it("one choice: the click is the vote; the same option again changes nothing", () => {
    expect(nextBallot(null, 1, false)).toEqual({ options: [1], changed: true });
    expect(nextBallot([1], 2, false)).toEqual({ options: [2], changed: true });
    expect(nextBallot([1], 1, false)).toEqual({ options: [1], changed: false });
  });
  it("several: a click toggles that option, sorted; the last one off empties the ballot", () => {
    expect(nextBallot(null, 2, true)).toEqual({ options: [2], changed: true });
    expect(nextBallot([2], 0, true)).toEqual({ options: [0, 2], changed: true });
    expect(nextBallot([0, 2], 2, true)).toEqual({ options: [0], changed: true });
    expect(nextBallot([0], 0, true)).toEqual({ options: [], changed: true });
  });
  const ballots: PollBallot[] = [
    { voter: "tg:1", name: "alice", options: [0], at: 5_000 },
    { voter: "tg:2", name: "bob", options: [0, 2], at: 3_000 },
    { voter: "dc:3", name: "carol", options: [1], at: 9_000 },
  ];
  it("counts per option", () => expect(pollCounts(3, ballots)).toEqual([2, 1, 1]));
  it("Kahoot by default: while open only 'N answered' — no counts on the options; live shows them", () => {
    const cbs = [0, 1, 2].map(i => replyButtonCallback("a".repeat(32), i));
    const open = pollRender(["Paris", "London", "Rome"], cbs, POLL, ballots, 99, false);
    expect(open).toEqual({ options: [{ id: cbs[0], label: "Paris" }, { id: cbs[1], label: "London" }, { id: cbs[2], label: "Rome" }], status: "🗳 3 answered", deadline: 99, closed: false });
    const live = pollRender(["Paris", "London", "Rome"], cbs, { ...POLL, reveal: "live" }, ballots, 99, false);
    expect(live.options.map(o => o.label)).toEqual(["Paris · 2", "London · 1", "Rome · 1"]);
  });
  it("closed: every option shows its count and share; the options are inert", () => {
    const closed = pollRender(["Paris", "London", "Rome"], ["x", "y", "z"], POLL, ballots, 99, true);
    expect(closed.options).toEqual([
      { id: `${POLL_CLOSED_CALLBACK}:0`, label: "Paris · 2 (67%)" }, { id: `${POLL_CLOSED_CALLBACK}:1`, label: "London · 1 (33%)" },
      { id: `${POLL_CLOSED_CALLBACK}:2`, label: "Rome · 1 (33%)" },
    ]);
    expect(closed.status).toBe("🗳 Closed · 3 answered");
    expect(pollRender(["A", "B"], ["x", "y"], POLL, [], 99, true).options.map(o => o.label)).toEqual(["A · 0", "B · 0"]);
  });
  it("the time left, rounded up to the redraw step; redraws coarser the more is left", () => {
    expect([0, 1, 4_999, 5_000, 61_000, 120_000].map(pollRemaining)).toEqual(["0:00", "0:05", "0:05", "0:05", "1:05", "2:00"]);
    expect([120_001, 59 * 60_000, 60 * 60_000, 3 * 3600_000 + 60_001].map(pollRemaining)).toEqual(["3 min", "59 min", "1 h 00 min", "3 h 02 min"]);
    expect([60_000, 120_000, 120_001, 600_000, 600_001].map(pollTickMs)).toEqual([5_000, 5_000, 30_000, 30_000, 300_000]);
  });
  it("the results: per option its count and voters, each with an id and ms since the poll opened, fastest first", () => {
    const set = { id: "3f2a9c00".padEnd(32, "0"), buttons: BUTTONS, createdAt: 1_000, expiresAt: 31_000 };
    expect(pollResultsText(set, POLL, ballots, 31_200)).toBe([
      "[poll results] poll 3f2a9c00 · single choice · 30 s · 3 voted · closed on time",
      "Q: Capital of France?",
      "1) Paris — 2: bob [tg:2] 2000 ms; alice [tg:1] 4000 ms",
      "2) London — 1: carol [dc:3] 8000 ms",
      "3) Rome (value: rome-it) — 1: bob [tg:2] 2000 ms",
      "ms = time from the poll opening to the voter's last change. AgEnD only counts votes: post the answer and any scores yourself.",
    ].join("\n"));
    expect(pollResultsText(set, { ...POLL, multi: true, question: "" }, [], 151_000)).toBe([
      "[poll results] poll 3f2a9c00 · multiple choice · 30 s · 0 voted · closed 120 s late (AgEnD was not running at the deadline)",
      "1) Paris — 0", "2) London — 0", "3) Rome (value: rome-it) — 0",
      "ms = time from the poll opening to the voter's last change. AgEnD only counts votes: post the answer and any scores yourself.",
    ].join("\n"));
  });
  it("show_voters: who picked what", () => {
    expect(pollVotersText(["Paris", "London", "Rome"], ballots)).toBe("🗳 Who voted:\nParis (2): bob, alice\nLondon (1): carol\nRome (1): bob");
  });
});

// ── the store ──

describe("the store: one ballot per voter, until the deadline; it outlives a restart", () => {
  const ID = "b".repeat(32);
  const open = (path: string, poll: PollConfig = POLL, at = 1_000) => {
    const store = new ReplyButtonStore(path);
    store.create({ id: ID, instance: "w", adapterId: "tg", chatId: "-100", threadId: "7", buttons: BUTTONS, poll }, at);
    return store;
  };
  it("a poll's deadline is its seconds after it opened; it takes votes only once bound and before then", () => {
    const store = open(join(scratch(), "rb.db"));
    expect(store.get(ID)).toMatchObject({ createdAt: 1_000, expiresAt: 31_000, poll: POLL, closedAt: null, resultsAt: null });
    expect(store.vote(ID, "tg:1", "alice", 0, 2_000)).toMatchObject({ ok: false, reason: "pending" });
    store.bind(ID, "55");
    expect(store.vote(ID, "tg:1", "alice", 0, 2_000)).toMatchObject({ ok: true, options: [0], changed: true });
    expect(store.vote(ID, "tg:1", "alice", 3, 2_000)).toMatchObject({ ok: false, reason: "missing" });
    expect(store.vote(ID, "tg:2", "bob", 1, 31_000)).toMatchObject({ ok: false, reason: "closed" });
    expect(store.ballots(ID)).toEqual([{ voter: "tg:1", name: "alice", options: [0], at: 2_000 }]);
    store.close();
  });
  it("a changed vote takes the time of the change; the same option again keeps the earlier time (a double click)", () => {
    const store = open(join(scratch(), "rb.db"));
    store.bind(ID, "55");
    store.vote(ID, "tg:1", "alice", 0, 2_000);
    expect(store.vote(ID, "tg:1", "alice", 0, 4_000)).toMatchObject({ ok: true, options: [0], changed: false });
    expect(store.ballots(ID)[0]!.at).toBe(2_000);
    store.vote(ID, "tg:1", "alice", 2, 6_000);
    expect(store.ballots(ID)).toEqual([{ voter: "tg:1", name: "alice", options: [2], at: 6_000 }]);
    store.close();
  });
  it("several choices: toggles; an emptied ballot withdraws the voter", () => {
    const store = open(join(scratch(), "rb.db"), { ...POLL, multi: true });
    store.bind(ID, "55");
    store.vote(ID, "dc:9", "zed", 2, 2_000);
    store.vote(ID, "dc:9", "zed", 0, 3_000);
    expect(store.ballots(ID)).toEqual([{ voter: "dc:9", name: "zed", options: [0, 2], at: 3_000 }]);
    store.vote(ID, "dc:9", "zed", 0, 4_000);
    expect(store.vote(ID, "dc:9", "zed", 2, 5_000)).toMatchObject({ ok: true, options: [], changed: true });
    expect(store.ballots(ID)).toEqual([]);
    store.close();
  });
  it("a poll is never consumed as one-click buttons — not even through a read that missed it is a poll", () => {
    const store = open(join(scratch(), "rb.db"));
    store.bind(ID, "55");
    expect(store.consume(ID, 0, "alice", 2_000)).toMatchObject({ ok: false, reason: "missing" });
    const real = store.get(ID)!;
    vi.spyOn(store, "get").mockReturnValueOnce({ ...real, poll: null });
    expect(store.consume(ID, 0, "alice", 2_000)).toMatchObject({ ok: false });
    expect(store.get(ID)!.consumedAt).toBeNull();
    expect(store.unsettled(40_000)).toEqual([]);             // one-click bookkeeping never picks a poll up
    store.close();
  });
  it("closing is once; then no vote counts; results and settling are tracked; all of it survives reopening the file", () => {
    const path = join(scratch(), "rb.db");
    let store = open(path);
    store.bind(ID, "55");
    store.vote(ID, "tg:1", "alice", 1, 5_000);
    expect(store.nextExpiry(10_000)).toBe(31_000);
    expect(store.openPolls().map(s => s.id)).toEqual([ID]);
    store.close();
    store = new ReplyButtonStore(path);                        // a restart, after the deadline
    expect(store.pollsDue(40_000).map(s => s.id)).toEqual([ID]);
    expect(store.closePoll(ID, 40_000)).toBe(true);
    expect(store.closePoll(ID, 40_001)).toBe(false);
    expect(store.vote(ID, "tg:2", "bob", 0, 20_000)).toMatchObject({ ok: false, reason: "closed" }); // closed wins over the clock
    expect(store.pollsDue(50_000)).toEqual([]);
    expect(store.nextExpiry(10_000)).toBeNull();
    expect(store.pollsAwaitingResults().map(s => s.id)).toEqual([ID]);
    expect(store.pollsUnsettled().map(s => s.id)).toEqual([ID]);
    store.markResults(ID, 40_002);
    store.markSettled(ID, 40_003);
    expect(store.pollsAwaitingResults()).toEqual([]);
    expect(store.pollsUnsettled()).toEqual([]);
    expect(store.ballots(ID)).toEqual([{ voter: "tg:1", name: "alice", options: [1], at: 5_000 }]);
    store.close();
  });
  it("pruning keeps a poll whose results are still owed, however old; then drops it with its ballots", () => {
    const store = open(join(scratch(), "rb.db"));
    store.bind(ID, "55");
    store.vote(ID, "tg:1", "alice", 1, 5_000);
    store.closePoll(ID, 31_000);
    store.markSettled(ID, 31_001);
    expect(store.prune(10 ** 12)).toBe(0);
    store.markResults(ID, 31_002);
    expect(store.prune(10 ** 12)).toBe(1);
    expect(store.ballots(ID)).toEqual([]);
    store.close();
  });
  it("an older reply-buttons.db (no poll columns) opens and keeps its sets as one-click buttons", () => {
    const path = join(scratch(), "rb.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE reply_buttons (id TEXT PRIMARY KEY, instance TEXT NOT NULL, adapter_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '', message_id TEXT, buttons TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      consumed_at INTEGER, chosen_index INTEGER, chosen_by TEXT, settled_at INTEGER, delivered_at INTEGER)`);
    db.prepare("INSERT INTO reply_buttons (id, instance, adapter_id, chat_id, buttons, created_at, expires_at, message_id) VALUES (?, 'w', 'dc', 'g', ?, 1, 99999999999999, 'm')")
      .run(ID, JSON.stringify(BUTTONS));
    db.close();
    const store = new ReplyButtonStore(path);
    expect(store.get(ID)).toMatchObject({ poll: null, closedAt: null, resultsAt: null });
    expect(store.consume(ID, 0, "alice", 2)).toMatchObject({ ok: true });
    store.close();
  });
});

// ── the fleet ──

interface Rec {
  sends: Array<{ chatId: string; text: string; opts: any }>;
  renders: Array<{ at: number; chatId: string; messageId: string; threadId?: string; poll: any }>;
}

/** A platform-like adapter with polls; `ticks` makes it one that cannot count down by itself (Telegram). */
function pollAdapter(id: string, rec: Rec, o: { ticks?: boolean; polls?: boolean; interval?: number; scope?: "chat" } = {}): ChannelAdapter {
  let n = 0;
  return {
    id, type: o.ticks ? "telegram" : "discord",
    supportsReplyButtons: true,
    ...(o.polls === false ? {} : { supportsPolls: true, pollEditIntervalMs: o.interval ?? 2_000, ...(o.ticks ? { pollCountdownTicks: true } : {}), ...(o.scope ? { pollRateScope: o.scope } : {}) }),
    sendText: async (chatId: string, text: string, opts: any) => {
      rec.sends.push({ chatId, text, opts });
      const mid = `msg-${++n}`;
      return { messageId: mid, chatId, ...(opts?.replyButtons ? { buttonsMessageId: `${mid}-last` } : {}) };
    },
    sendFile: async () => ({ messageId: "f", chatId: "x" }),
    renderPoll: async (chatId: string, messageId: string, threadId: string | undefined, poll: unknown) => {
      rec.renders.push({ at: Date.now(), chatId, messageId, threadId, poll });
    },
  } as unknown as ChannelAdapter;
}

function fleet(options: { dir?: string; ticks?: boolean; polls?: boolean; classic?: boolean; scope?: "chat"; interval?: number } = {}) {
  const dir = options.dir ?? scratch();
  const fm = new FleetManager(dir);
  fleets.push(fm);
  const any = fm as any;
  const rec: Rec = { sends: [], renders: [] };
  const adapter = pollAdapter("dc", rec, { ticks: options.ticks, polls: options.polls, scope: options.scope, interval: options.interval });
  const channel = { id: "dc", type: "discord", mode: "topic", bot_token_env: "X", group_id: "guild", access: { mode: "locked", allowed_users: ["owner", "u2", "u3", "bot-self"], max_pending_codes: 0, code_expiry_minutes: 0 } } as unknown as ChannelConfig;
  any.fleetConfig = { channels: [channel], defaults: {}, instances: { w: { working_directory: "/tmp", topic_id: "42", channel_id: "dc" }, v: { working_directory: "/tmp", topic_id: "43", channel_id: "dc" } } };
  const world = new AdapterWorld("dc", adapter, new AccessManager(channel.access as any, join(dir, "access.json")), channel);
  world.botUserId = "bot-self";
  any.worlds.set("dc", world);
  any.adapter = adapter;
  if (options.classic) any.classicChannels = { getChannelIdByInstance: (name: string) => (name === "w" ? "room" : undefined), getAll: () => [], isCollab: () => false };
  const answers: any[] = [];
  any.instanceIpcClients.set("w", { send: (m: unknown) => { answers.push(m); return true; } });
  any.instanceIpcClients.set("v", { send: (m: unknown) => { answers.push(m); return true; } });
  any.getInstanceIdle = () => true; any.clearCancelButton = () => {}; any.reactDone = () => {};
  any.deliverToInstance = vi.fn(async () => true);
  const sse: Array<{ event: string; data: any }> = [];
  const realEmit = any.emitSseEvent.bind(fm);
  any.emitSseEvent = (event: string, data: any) => { sse.push({ event, data }); realEmit(event, data); };
  const ctl = () => {
    const c = any.replyButtons();
    c.deps.monotonic = () => Date.now();                    // fake timers drive Date; the throttle reads this
    return c;
  };
  const reply = async (args: Record<string, unknown>, instance = "w") => {
    const before = answers.length;
    await any.handleOutboundFromInstance(instance, { tool: "reply", args: { chat_id: "guild", ...args }, fleetRequestId: `r${before}` });
    await vi.waitFor(() => expect(answers.length).toBeGreaterThan(before));
    return answers[answers.length - 1];
  };
  const pollCbs = () => (rec.sends.at(-1)!.opts.replyPoll.options as Array<{ id: string }>).map(o => o.id);
  const vote = async (index: number, userId = "owner", username = "alice", over: Record<string, unknown> = {}) => {
    const acks: Array<string | undefined> = [];
    const handled = await any.dispatchAdapterCallback({ callbackData: pollCbs()[index], chatId: "guild", threadId: "42", messageId: `msg-${rec.sends.length}-last`, userId, username, ack: (n?: string) => acks.push(n), ...over }, "dc", adapter);
    return { handled, acks };
  };
  const notices = () => {
    const db = new Database(join(dir, "delivery-outbox.db"), { readonly: true });
    try { return db.prepare("SELECT source_key, target_instance, payload_json FROM deliveries WHERE source_key LIKE 'poll:%' ORDER BY created_seq").all() as Array<{ source_key: string; target_instance: string; payload_json: string }>; }
    finally { db.close(); }
  };
  return { fm, any, rec, adapter, answers, sse, reply, vote, pollCbs, notices, ctl, dir };
}
const setIdOf = (h: ReturnType<typeof fleet>) => h.pollCbs()[0]!.split(":")[1]!;

describe("the reply path", () => {
  it("a poll goes out as its options plus a status; the result names the poll; the web chat shows the text only", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    const answer = await h.reply({ text: "Capital of France?", buttons: BUTTONS, poll: { seconds: 30 } });
    expect(answer.error).toBeUndefined();
    const sent = h.rec.sends[0]!;
    const id = setIdOf(h);
    expect(sent.opts.replyPoll).toEqual({
      options: BUTTONS.map((b, i) => ({ id: replyButtonCallback(id, i), label: b.label })), status: "🗳 0 answered", deadline: 1_030_000, closed: false,
    });
    expect(answer.result).toMatchObject({ poll_id: id, messageId: "msg-1" });
    expect(JSON.stringify(h.rec.sends)).not.toContain("rome-it");
    const store = h.any.replyButtonsStore as ReplyButtonStore;
    expect(store.get(id)).toMatchObject({ messageId: "msg-1-last", expiresAt: 1_030_000, poll: { seconds: 30, multi: false, reveal: "close" } });
    const msg = h.sse.find(e => e.event === "message" && e.data.role === "agent")!.data;
    expect(msg.buttons).toBeUndefined();
  });
  it.each([
    ["a poll on one button", { buttons: BUTTONS.slice(0, 1), poll: { seconds: 30 } }, /at least 2 buttons/],
    ["a poll of 5 seconds", { buttons: BUTTONS, poll: { seconds: 5 } }, /from 10 to 86400/],
    ["a poll without buttons", { poll: { seconds: 30 } }, /at least 2 buttons/],
  ])("refused before anything is sent: %s", async (_n, args, error) => {
    const h = fleet();
    const answer = await h.reply({ text: "Q?", ...args });
    expect(answer.error).toMatch(error);
    expect(h.rec.sends).toEqual([]);
  });
  it("where a poll cannot be shown it is refused, never sent as text options", async () => {
    const h = fleet({ polls: false });
    const answer = await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 30 } });
    expect(answer.error).toMatch(/a poll cannot be shown here/);
    expect(h.rec.sends).toEqual([]);
  });
  it("buttons without poll are still the first-click-answers-for-everyone buttons", async () => {
    const h = fleet();
    await h.reply({ text: "Deploy?", buttons: BUTTONS });
    expect(h.rec.sends[0]!.opts.replyPoll).toBeUndefined();
    expect(h.rec.sends[0]!.opts.replyButtons).toHaveLength(3);
  });
});

describe("voting", () => {
  it("everyone allowed votes once each; their choice is told to them alone; the message shows only how many answered", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 30 } });
    const id = setIdOf(h);
    vi.setSystemTime(1_002_000);
    expect(await h.vote(0, "owner", "alice")).toEqual({ handled: true, acks: ["✓ Your vote: Paris"] });
    vi.setSystemTime(1_003_000);
    expect((await h.vote(2, "u2", "bob")).acks).toEqual(["✓ Your vote: Rome"]);
    vi.setSystemTime(1_004_000);
    expect((await h.vote(1, "owner", "alice")).acks).toEqual(["✓ Your vote: London"]);   // changed
    const store = h.any.replyButtonsStore as ReplyButtonStore;
    expect(store.ballots(id).map(b => [b.voter, b.options, b.at])).toEqual([["dc:u2", [2], 1_003_000], ["dc:owner", [1], 1_004_000]]);
    await vi.advanceTimersByTimeAsync(2_000);
    const last = h.rec.renders.at(-1)!;
    expect(last.poll).toMatchObject({ status: "🗳 2 answered", closed: false });
    expect(last.poll.options.map((o: any) => o.label)).toEqual(["Paris", "London", "Rome"]);   // no counts while open
    expect(h.any.deliverToInstance).not.toHaveBeenCalled();                                    // a vote is not a message
  });
  it("several choices: toggles, the voter told their whole ballot; the last one off withdraws them", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 30, multi: true } });
    expect((await h.vote(2)).acks).toEqual(["✓ Your vote: Rome"]);
    expect((await h.vote(0)).acks).toEqual(["✓ Your vote: Paris, Rome"]);
    expect((await h.vote(0)).acks).toEqual(["✓ Your vote: Rome"]);
    expect((await h.vote(2)).acks).toEqual(["Your vote is withdrawn."]);
    expect((h.any.replyButtonsStore as ReplyButtonStore).ballots(setIdOf(h))).toEqual([]);
  });
  it("reveal: live — the counts show on the options while open", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 30, reveal: "live" } });
    await h.vote(0); await h.vote(0, "u2", "bob");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.rec.renders.at(-1)!.poll.options.map((o: any) => o.label)).toEqual(["Paris · 2", "London · 0", "Rome · 0"]);
  });
  it.each([
    ["someone not allowed here", { userId: "stranger" }],
    ["a fleet bot", { userId: "bot-self" }],
  ])("refused: %s — told so, nothing counted", async (_n, over) => {
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 30 } });
    expect((await h.vote(0, String(over.userId), "x")).acks).toEqual(["⛔ You can't use this button."]);
    expect((h.any.replyButtonsStore as ReplyButtonStore).ballots(setIdOf(h))).toEqual([]);
  });
  it("in a ClassicBot room anyone there may vote", async () => {
    const h = fleet({ classic: true });
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 30 } });
    // A ClassicBot reply is posted in its room; Discord reports the click as guild + room.
    expect(h.rec.sends[0]!.chatId).toBe("room");
    expect((await h.vote(1, "stranger", "zoe", { threadId: "room" })).acks).toEqual(["✓ Your vote: London"]);
  });
  it("a click copied to another message counts nothing", async () => {
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 30 } });
    expect((await h.vote(0, "owner", "alice", { messageId: "elsewhere" })).acks).toEqual(["⚠️ This button does not match the prompt it belongs to. Run the command again."]);
    expect((h.any.replyButtonsStore as ReplyButtonStore).ballots(setIdOf(h))).toEqual([]);
  });
  it("a late vote (after the deadline, before the sweep) is told the poll is closed and not counted", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    const c = h.ctl();
    c.arm = () => {};                                          // the sweep has not run yet
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 30 } });
    vi.setSystemTime(1_030_000);
    expect((await h.vote(0)).acks).toEqual(["This poll is closed."]);
    expect((h.any.replyButtonsStore as ReplyButtonStore).ballots(setIdOf(h))).toEqual([]);
  });
  it("a click in the instant between the send and the bind is told to try again, not that the poll is closed", async () => {
    const h = fleet();
    const c = h.ctl();
    const { id } = c.prepare({ instance: "w", adapterId: "dc", chatId: "guild", threadId: "42" }, BUTTONS, POLL);
    const acks: Array<string | undefined> = [];
    expect(c.vote(id, "dc:owner", "alice", 0, (n?: string) => acks.push(n))).toMatchObject({ ok: false });
    expect(acks).toEqual(["This poll is still being posted — try again in a moment."]);
  });
  it("the status button and a closed poll's options answer without counting anything", async () => {
    const h = fleet();
    h.ctl();
    const acks: Array<string | undefined> = [];
    for (const cb of [POLL_STATUS_CALLBACK, `${POLL_CLOSED_CALLBACK}:1`]) {
      expect(await h.any.dispatchAdapterCallback({ callbackData: cb, chatId: "guild", messageId: "m", userId: "owner", ack: (n?: string) => acks.push(n) }, "dc", h.adapter)).toBe(true);
    }
    expect(acks).toEqual([undefined, "This poll is closed."]);
  });
});

describe("redraws stay inside the platform's edit limits", () => {
  it("a burst of votes is one redraw per interval, drawn from the latest state", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 60 } });
    await h.vote(0, "owner");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rec.renders.map(r => r.poll.status)).toEqual(["🗳 1 answered"]);   // the first went at once…
    await h.vote(1, "u2"); await h.vote(2, "u3");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.rec.renders).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.rec.renders.map(r => r.poll.status)).toEqual(["🗳 1 answered", "🗳 3 answered"]); // …the rest coalesced, 2 s on
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.rec.renders).toHaveLength(2);                                      // nothing changed: nothing redrawn
  });
  it("a vote that changes nothing (the same option again) redraws nothing", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 60 } });
    await h.vote(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await h.vote(1)).acks).toEqual(["✓ Your vote: London"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.rec.renders).toHaveLength(1);
  });
  it("two polls in one chat share its interval", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q1?", buttons: BUTTONS, poll: { seconds: 60 } });
    const first = { cb: h.pollCbs(), msg: `msg-${h.rec.sends.length}-last` };
    await h.reply({ text: "Q2?", buttons: BUTTONS, poll: { seconds: 60 } });
    await h.any.dispatchAdapterCallback({ callbackData: first.cb[0], chatId: "guild", threadId: "42", messageId: first.msg, userId: "owner", username: "a", ack: () => {} }, "dc", h.adapter);
    await h.vote(0, "owner");
    await vi.advanceTimersByTimeAsync(5_000);
    const [a, b] = h.rec.renders;
    expect([a!.messageId, b!.messageId]).toEqual(["msg-1-last", "msg-2-last"]);
    expect(b!.at - a!.at).toBe(2_000);
  });
  it("Telegram: polls in two topics of one group share the group's interval (its edit limit is per chat)", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet({ scope: "chat", interval: 3_000 });
    h.ctl();
    await h.reply({ text: "Q1?", buttons: BUTTONS, poll: { seconds: 60 } }, "w");
    const first = { cb: h.pollCbs(), msg: `msg-${h.rec.sends.length}-last` };
    await h.reply({ text: "Q2?", buttons: BUTTONS, poll: { seconds: 60 } }, "v");
    expect(h.rec.sends.map(s => s.opts.threadId)).toEqual(["42", "43"]);
    await h.any.dispatchAdapterCallback({ callbackData: first.cb[0], chatId: "guild", threadId: "42", messageId: first.msg, userId: "owner", username: "a", ack: () => {} }, "dc", h.adapter);
    await h.vote(0, "owner", "a", { threadId: "43" });
    await vi.advanceTimersByTimeAsync(10_000);
    const [a, b] = h.rec.renders;
    expect([a!.threadId, b!.threadId]).toEqual(["42", "43"]);
    expect(b!.at - a!.at).toBe(3_000);
  });
  it("Discord: polls in two channels do not wait for each other (each has its own bucket)", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q1?", buttons: BUTTONS, poll: { seconds: 60 } }, "w");
    const first = { cb: h.pollCbs(), msg: `msg-${h.rec.sends.length}-last` };
    await h.reply({ text: "Q2?", buttons: BUTTONS, poll: { seconds: 60 } }, "v");
    await h.any.dispatchAdapterCallback({ callbackData: first.cb[0], chatId: "guild", threadId: "42", messageId: first.msg, userId: "owner", username: "a", ack: () => {} }, "dc", h.adapter);
    await h.vote(0, "owner", "a", { threadId: "43" });
    await vi.advanceTimersByTimeAsync(10_000);
    const [a, b] = h.rec.renders;
    expect(b!.at - a!.at).toBe(0);
  });
  it("a platform that cannot count down is redrawn as time passes: every 5 s in the last two minutes", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet({ ticks: true });
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 20 } });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(h.rec.renders.map(r => Math.round((r.at - 1_000_000) / 1000))).toEqual([5, 10, 15]);
    // On the step's boundaries of the time left (a late redraw does not shift the next): within a timer's ms of one.
    for (const r of h.rec.renders) { const d = (r.poll.deadline - r.at) % 5_000; expect(Math.min(d, 5_000 - d)).toBeLessThanOrEqual(2); }
    expect(h.rec.renders.map(r => r.poll.deadline)).toEqual([1_020_000, 1_020_000, 1_020_000]);
  });
  it("a platform that counts down itself (Discord) is not redrawn just for the time", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 20 } });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(h.rec.renders).toEqual([]);
  });
});

describe("the close: shown once, results to the agent exactly once — across a restart too", () => {
  it("at the deadline: closed, drawn with the tally, and one results notice to the instance addressed to the poll's chat", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Capital of France?", buttons: BUTTONS, poll: { seconds: 30 } });
    const id = setIdOf(h);
    await vi.advanceTimersByTimeAsync(4_210); await h.vote(0, "owner", "alice");
    await vi.advanceTimersByTimeAsync(3_790); await h.vote(1, "u2", "bob");
    await vi.advanceTimersByTimeAsync(22_000);
    const store = h.any.replyButtonsStore as ReplyButtonStore;
    expect(store.get(id)).toMatchObject({ closedAt: expect.any(Number), settledAt: expect.any(Number), resultsAt: expect.any(Number) });
    const final = h.rec.renders.filter(r => r.poll.closed);
    expect(final).toHaveLength(1);
    expect(final[0]!.poll.options.map((o: any) => o.label)).toEqual(["Paris · 1 (50%)", "London · 1 (50%)", "Rome · 0 (0%)"]);
    const [notice, ...more] = h.notices();
    expect(more).toEqual([]);
    expect(notice!.source_key).toBe(`poll:${id}`);
    expect(notice!.target_instance).toBe("w");
    const payload = JSON.parse(notice!.payload_json);
    // The ms are from the poll opening (its prepare, before the send) to each ballot; bob voted 3790 ms after alice.
    const msOf = (voter: string) => store.ballots(id).find(v => v.voter === voter)!.at - store.get(id)!.createdAt;
    expect(msOf("dc:u2") - msOf("dc:owner")).toBe(3_790);
    expect(payload.meta).toMatchObject({ chat_id: "guild", thread_id: "42", adapter_id: "dc", source: "agend-system" });
    expect(payload.content).toBe([
      `[poll results] poll ${id.slice(0, 8)} · single choice · 30 s · 2 voted · closed on time`,
      "Q: Capital of France?",
      `1) Paris — 1: alice [dc:owner] ${msOf("dc:owner")} ms`,
      `2) London — 1: bob [dc:u2] ${msOf("dc:u2")} ms`,
      "3) Rome (value: rome-it) — 0",
      "ms = time from the poll opening to the voter's last change. AgEnD only counts votes: post the answer and any scores yourself.",
    ].join("\n"));
    expect((await h.vote(2, "u3", "carol")).acks).toEqual(["This poll is closed."]);
    await h.ctl().sweep();
    expect(h.notices()).toHaveLength(1);
    expect(h.rec.renders.filter(r => r.poll.closed)).toHaveLength(1);
  });
  it("an open redraw still in flight at the close lands first: the closed one is the last word, and no tick follows it", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet({ ticks: true });
    h.ctl();
    const order: string[] = [];
    let release!: () => void;
    (h.adapter as any).renderPoll = (_c: string, _m: string, _t: string | undefined, poll: any) => {
      if (!poll.closed && !order.length) {
        order.push("open:start");
        return new Promise<void>(r => { release = () => { order.push("open:done"); r(); }; });
      }
      order.push(poll.closed ? "closed" : "open");
      return Promise.resolve();
    };
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 10 } });
    await h.vote(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["open:start"]);
    // The 5 s tick and the deadline both come while the first edit is still out: neither may go before it lands.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(order).toEqual(["open:start"]);
    expect((h.any.replyButtonsStore as ReplyButtonStore).get(setIdOf(h))!.closedAt).not.toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(order).toEqual(["open:start", "open:done", "closed"]);           // the tick's redraw saw it closed
  });
  it("#1824 review P1: edits slower than the interval still go one at a time, and the closed one only after every open one", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    const log: string[] = [];
    let active = 0, maxActive = 0, n = 0;
    let releaseFirst!: () => void;
    (h.adapter as any).renderPoll = (_c: string, _m: string, _t: string | undefined, poll: any) => {
      const tag = `${poll.closed ? "closed" : "open"}#${++n}`;
      active++; maxActive = Math.max(maxActive, active); log.push(`${tag}:start`);
      const done = () => { active--; log.push(`${tag}:done`); };
      // The first edit sticks until released; the next ones take 8 s each (a channel queued behind its rate limit).
      return new Promise<void>(r => { if (n === 1) releaseFirst = () => { done(); r(); }; else setTimeout(() => { done(); r(); }, 8_000); });
    };
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 20 } });
    await h.vote(0, "owner");
    await vi.advanceTimersByTimeAsync(2_100);
    await h.vote(1, "u2");                                                 // its redraw waits for the stuck one
    await vi.advanceTimersByTimeAsync(2_100);
    await h.vote(2, "u3");                                                 // …and so does this one
    await vi.advanceTimersByTimeAsync(1_000);
    releaseFirst();                                                         // both waiters wake on the same edit
    await vi.advanceTimersByTimeAsync(40_000);                              // the deadline comes while one is out
    expect(maxActive).toBe(1);
    const closedStart = log.indexOf(log.find(l => l.startsWith("closed"))!);
    const lastOpenDone = Math.max(...log.map((l, i) => (l.startsWith("open") && l.endsWith(":done") ? i : -1)));
    expect(closedStart).toBeGreaterThan(lastOpenDone);
    expect(log.filter(l => l.startsWith("closed") && l.endsWith(":start"))).toHaveLength(1);
    expect(log.at(-1)).toMatch(/^closed#\d+:done$/);
  });
  it("show_voters: one follow-up under the poll names who picked what; without it, none", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 10, show_voters: true } });
    await h.vote(2, "owner", "alice");
    await vi.advanceTimersByTimeAsync(10_000);
    const follow = h.rec.sends.slice(1);
    expect(follow.map(s => [s.text, s.opts.replyTo, s.opts.threadId])).toEqual([["🗳 Who voted:\nParis (0): —\nLondon (0): —\nRome (1): alice", "msg-1-last", "42"]]);
    const h2 = fleet();
    h2.ctl();
    await h2.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 10 } });
    await h2.vote(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h2.rec.sends).toHaveLength(1);
  });
  it("results the outbox took are not taken again — a crash between taking and marking them repeats nothing", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    const c = h.ctl();
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 10 } });
    const store = h.any.replyButtonsStore as ReplyButtonStore;
    const mark = vi.spyOn(store, "markResults").mockImplementation(() => {});   // the process "dies" before marking
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.notices()).toHaveLength(1);
    mark.mockRestore();
    await c.sweep();                                                            // the next process's sweep
    expect(h.notices()).toHaveLength(1);
    expect(store.get(setIdOf(h))!.resultsAt).not.toBeNull();
  });
  it("an outbox that cannot take the results now: owed, offered again later, then delivered once", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = fleet();
    const c = h.ctl();
    let refuse = true;
    const real = c.deps.admitResults;
    c.deps.admitResults = (...a: any[]) => { if (refuse) throw new Error("outbox closed"); return real(...a); };
    await h.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 10 } });
    await vi.advanceTimersByTimeAsync(10_000);
    const store = h.any.replyButtonsStore as ReplyButtonStore;
    expect(store.pollsAwaitingResults()).toHaveLength(1);
    expect(h.rec.renders.filter(r => r.poll.closed)).toHaveLength(1);            // people see it closed meanwhile
    refuse = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.pollsAwaitingResults()).toEqual([]);
    expect(h.notices()).toHaveLength(1);
  });
  it("a restart over an open poll: the deadline holds, the countdown is drawn again, votes count, results once", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const dir = scratch();
    const a = fleet({ dir, ticks: true });
    a.ctl();
    await a.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 60 } });
    const id = setIdOf(a);
    vi.setSystemTime(1_003_000); await a.vote(1, "owner", "alice");
    a.any.replyButtonsCtl.stop(); a.any.replyButtonsStore.close();
    a.any.replyButtonsCtl = null; a.any.replyButtonsStore = null;
    vi.setSystemTime(1_020_000);                                                  // AgEnD comes back, 40 s left
    const b = fleet({ dir, ticks: true });
    const c = b.ctl();
    await c.sweep();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.rec.renders[0]).toMatchObject({ messageId: "msg-1-last", poll: { status: "🗳 1 answered", closed: false, deadline: 1_060_000 } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await b.any.dispatchAdapterCallback({ callbackData: replyButtonCallback(id, 0), chatId: "guild", threadId: "42", messageId: "msg-1-last", userId: "u2", username: "bob", ack: () => {} }, "dc", b.adapter))).toBe(true);
    await vi.advanceTimersByTimeAsync(31_000);
    const notices = b.notices();
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0]!.payload_json).content).toContain("1) Paris — 1: bob [dc:u2] 30000 ms");
    expect(JSON.parse(notices[0]!.payload_json).content).toContain("2) London — 1: alice [dc:owner] 3000 ms");
  });
  it("a deadline that passed while AgEnD was down: closed at the first sweep, the results say how late", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const dir = scratch();
    const a = fleet({ dir });
    a.ctl();
    await a.reply({ text: "Q?", buttons: BUTTONS, poll: { seconds: 10 } });
    a.any.replyButtonsCtl.stop(); a.any.replyButtonsStore.close();
    a.any.replyButtonsCtl = null; a.any.replyButtonsStore = null;
    vi.setSystemTime(1_310_000);
    const b = fleet({ dir });
    await b.ctl().sweep();
    const [notice, ...more] = b.notices();
    expect(more).toEqual([]);
    expect(JSON.parse(notice!.payload_json).content).toMatch(/· closed 300 s late \(AgEnD was not running at the deadline\)/);
    expect(b.rec.renders.filter(r => r.poll.closed)).toHaveLength(1);
  });
});

describe("the results notice names its chat, but has no platform message to react to (#1824 review)", () => {
  it("channelStatus: none for a notice from AgEnD; an ordinary message keeps its status holder", async () => {
    const { channelStatus } = await import("../src/daemon.js");
    expect(channelStatus({ chat_id: "guild", thread_id: "42", message_id: "system-notice-1", source: "agend-system" })).toBeUndefined();
    expect(channelStatus({ chat_id: "guild", thread_id: "42", message_id: "m1", source: "discord" })).toEqual({ chatId: "guild", messageId: "m1", threadId: "42" });
  });
});

describe("where there is no fleet, a poll is refused (its votes and results live in the fleet)", () => {
  it("the standalone daemon refuses it before sending; buttons alone still go out as text options", async () => {
    const { Daemon } = await import("../src/daemon.js");
    const d = new Daemon("poll-standalone", {
      working_directory: "/tmp", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
    } as any, scratch(), false, undefined, undefined, { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } as any) as any;
    const sendText = vi.fn(async () => ({ messageId: "m1", chatId: "c" }));
    const adapter = { id: "tg", type: "telegram", sendText, sendFile: vi.fn() };
    d.messageBus = { getAllAdapters: () => [adapter], getAdapter: () => adapter };
    d.lastChatId = "c"; d.lastAdapterId = "tg";
    const sent: any[] = [];
    d.ipcServer = { send: (_s: unknown, m: unknown) => { sent.push(m); return true; }, broadcast: vi.fn() };
    const socket = {} as any;
    d.handleToolCall({ tool: "reply", requestId: 1, args: { text: "Q?", buttons: BUTTONS, poll: { seconds: 30 } } }, socket);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ requestId: 1, result: null, error: "reply: a poll needs AgEnD's fleet; send the question without poll" });
    expect(sendText).not.toHaveBeenCalled();
    d.handleToolCall({ tool: "reply", requestId: 2, args: { text: "Q?", buttons: BUTTONS } }, socket);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sendText).toHaveBeenCalledWith("c", "Q?\n\nOptions: 1) Paris  2) London  3) Rome — reply with your choice.", expect.anything());
  });
  it("agend-agent reply (POST /agent) refuses it before sending", async () => {
    const { dispatchAgentOperation } = await import("../src/agent-endpoint.js");
    const { ReplyDeduper } = await import("../src/reply-dedup.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dataDir = scratch();
    mkdirSync(join(dataDir, "instances", "agy"), { recursive: true });
    writeFileSync(join(dataDir, "instances", "agy", "last-chat.json"), JSON.stringify({ chatId: "chat-1", adapterId: "tg" }));
    const sendText = vi.fn(async () => ({ messageId: "t1", chatId: "chat-1" }));
    const ctx = {
      dataDir, fleetConfig: { defaults: {}, instances: { agy: { tool_set: "worker" } } },
      adapters: new Map([["tg", { id: "tg", type: "telegram", sendText, sendFile: vi.fn() }]]), replyDeduper: new ReplyDeduper(),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }, clearCancelButton: vi.fn(),
    } as any;
    expect(await dispatchAgentOperation(ctx, "agy", "reply", { text: "Q?", buttons: BUTTONS, poll: { seconds: 30 } }))
      .toEqual({ error: "reply: a poll cannot be sent from here; send the question without poll" });
    expect(sendText).not.toHaveBeenCalled();
  });
});

// ── the real adapters ──

const SET = "a".repeat(32);
const render = (closed: boolean, status?: string) => {
  const r = pollRender(["Paris", "London"], [0, 1].map(i => replyButtonCallback(SET, i)), POLL,
    [{ voter: "a", name: "a", options: [0], at: 1 }, { voter: "b", name: "b", options: [0], at: 2 }], 1_030_000, closed);
  return status ? { ...r, status } : r;
};

describe("Telegram", () => {
  function telegram() {
    const calls: Array<{ method: string; opts: any }> = [];
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(adapter, {
      id: "tg",
      bot: { api: {
        sendMessage: async (_c: number, text: string, opts: any) => { calls.push({ method: "sendMessage", opts: { text, ...opts } }); return { message_id: 7 }; },
        editMessageReplyMarkup: async (_c: number, messageId: number, opts: any) => { calls.push({ method: "editMessageReplyMarkup", opts: { messageId, ...opts } }); return true; },
      } },
    });
    return { adapter, calls };
  }
  it("posted: the options, then an inert status row with the time left; redrawn by editing the keyboard", async () => {
    const { adapter, calls } = telegram();
    expect([adapter.supportsPolls, adapter.pollCountdownTicks, adapter.pollEditIntervalMs, adapter.pollRateScope]).toEqual([true, true, 3_000, "chat"]);
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await adapter.sendText("-100", "Capital?", { threadId: "5", replyPoll: render(false) });
    expect(calls[0]!.opts.reply_markup.inline_keyboard).toEqual([
      [{ text: "Paris", callback_data: `rb:${SET}:0` }, { text: "London", callback_data: `rb:${SET}:1` }],
      [{ text: "🗳 2 answered · ⏳ 0:30", callback_data: POLL_STATUS_CALLBACK }],
    ]);
    await adapter.renderPoll!("-100", "7", "5", render(true));
    expect(calls[1]).toMatchObject({ method: "editMessageReplyMarkup", opts: { messageId: 7 } });
    expect(calls[1]!.opts.reply_markup.inline_keyboard.at(-1)).toEqual([{ text: "🗳 Closed · 2 answered", callback_data: POLL_STATUS_CALLBACK }]);
    expect(calls[1]!.opts.reply_markup.inline_keyboard[0]![0]).toEqual({ text: "Paris · 2 (100%)", callback_data: `${POLL_CLOSED_CALLBACK}:0` });
  });
  it("the keyboard for a long wait reads hours and minutes", () => {
    const k = telegramPollKeyboard({ ...render(false), deadline: 1_000_000 + 3 * 3600_000 }, 1_000_000);
    expect(k.at(-1)).toEqual([{ text: "🗳 2 answered · ⏳ 3 h 00 min", callback_data: POLL_STATUS_CALLBACK }]);
  });
});

describe("Discord", () => {
  function discord() {
    const dir = scratch();
    const adapter = new DiscordAdapter({
      id: "dc", botToken: "fake-token", accessManager: new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 } as any, join(dir, "a.json")),
      inboxDir: dir, guildId: "guild-1", registerCommands: false,
    } as any);
    stops.push(() => adapter.stop());
    const sends: any[] = [], edits: any[] = [];
    const rowsOf = (p: any) => (p.components ?? []).map((r: any) => (typeof r.toJSON === "function" ? r.toJSON() : r));
    let content = "";
    const channel = {
      send: async (payload: any) => { content = payload.content; sends.push({ content: payload.content, rows: rowsOf(payload) }); return { id: `m${sends.length}` }; },
      messages: {
        edit: async (messageId: string, p: any) => { edits.push({ messageId, how: "edit", content: p.content, rows: rowsOf(p) }); },
        fetch: async (messageId: string) => ({ content, edit: async (p: any) => { edits.push({ messageId, how: "fetch+edit", content: p.content, rows: rowsOf(p) }); } }),
      },
    };
    vi.spyOn(adapter as any, "_fetchTextChannel").mockResolvedValue(channel);
    return { adapter, sends, edits };
  }
  it("posted: a deadline line Discord counts down itself, the options, and a disabled status button", async () => {
    const { adapter, sends } = discord();
    const generic: ChannelAdapter = adapter;
    expect([generic.supportsPolls, generic.pollCountdownTicks, generic.pollEditIntervalMs, generic.pollRateScope]).toEqual([true, undefined, 2_000, undefined]);
    const sent = await adapter.sendText("guild-1", "Capital?", { threadId: "chan", replyPoll: render(false) });
    expect(sends[0].content).toBe("Capital?\n\n⏳ Closes <t:1030:R>");
    expect(sends[0].rows.map((r: any) => r.components.map((c: any) => [c.custom_id, c.label, c.disabled ?? false]))).toEqual([
      [[`rb:${SET}:0`, "Paris", false], [`rb:${SET}:1`, "London", false]],
      [[POLL_STATUS_CALLBACK, "🗳 2 answered", true]],
    ]);
    expect(sent.buttonsMessageId).toBe("m1");
  });
  it("redrawn while open: the components only; at close also the deadline line, which says closed", async () => {
    const { adapter, edits } = discord();
    await adapter.sendText("guild-1", "Capital?", { threadId: "chan", replyPoll: render(false) });
    await adapter.renderPoll!("guild-1", "m1", "chan", render(false, "🗳 3 answered"));
    expect(edits[0]).toMatchObject({ messageId: "m1", how: "edit", content: undefined });
    await adapter.renderPoll!("guild-1", "m1", "chan", render(true));
    expect(edits[1]).toMatchObject({ messageId: "m1", how: "fetch+edit", content: "Capital?\n\n🔒 Poll closed" });
    expect(edits[1].rows.flatMap((r: any) => r.components.map((c: any) => [c.custom_id, c.label, c.disabled]))).toEqual([
      [`${POLL_CLOSED_CALLBACK}:0`, "Paris · 2 (100%)", true], [`${POLL_CLOSED_CALLBACK}:1`, "London · 0 (0%)", true],
      [POLL_STATUS_CALLBACK, "🗳 Closed · 2 answered", true],
    ]);
  });
  it("ten options are two rows of five and the status row: inside Discord's five rows", () => {
    const rows = discordPollRows({ options: Array.from({ length: 10 }, (_, i) => ({ id: replyButtonCallback(SET, i), label: `O${i}` })), status: "s", deadline: 1, closed: false });
    expect(rows.map(r => r.toJSON().components.length)).toEqual([5, 5, 1]);
  });
});
