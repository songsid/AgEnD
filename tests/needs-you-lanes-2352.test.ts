/**
 * #2352: a task card that waits for the person is listed in its lane's own channel — the instance that handed it out,
 * else its project's lead — not in General: one live message per lane, the same renderer, its buttons and its Send
 * back / Answer prompts bound to that message and place. Everything #2306 guarded still holds per lane; a lane that
 * moves (its instance's channel gone, the card routed elsewhere) takes no stale click or reply.
 *
 * Isolation: a fake clock and timers; a fake adapter records every call; a temp data dir for the pointers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeedsYouHub, liveKey, type NeedsYouHubContext, type TaskAction } from "../src/needs-you-hub.js";
import type { TaskInput } from "../src/needs-you.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const task = (over: Partial<TaskInput>): TaskInput => ({
  uuid: "u1", code: "M-1", title: "Weekly leaderboard", status: "review", version: 4, assignee: "alpha", note: "", since: 990_000, ...over,
});

/** General is thread 1 of group -100; `lead`'s own topic is 55, `beta`'s 66. */
function rig(opts: { pointers?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "needs-lanes-")); dirs.push(dir);
  if (opts.pointers) writeFileSync(join(dir, "needs-you-message.json"), JSON.stringify(opts.pointers));
  let mono = 0, n = 0, id = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  const calls: string[] = [];
  const posts: Array<{ messageId: string; threadId?: string; text: string; choices: Array<{ id: string; label: string }> }> = [];
  const adapter = {
    type: "telegram",
    notifyAlert: vi.fn(async (chatId: string, alert: { message: string; choices?: Array<{ id: string; label: string }> }, o?: { threadId?: string }) => {
      const messageId = `m${++n}`;
      posts.push({ messageId, threadId: o?.threadId, text: alert.message, choices: alert.choices ?? [] });
      calls.push(`post ${o?.threadId} ${messageId} ${alert.message.split("\n")[0]} [${(alert.choices ?? []).map(c => c.label).join(", ")}]`);
      return { messageId, chatId, threadId: o?.threadId };
    }),
    editAlert: vi.fn(async (_c: string, messageId: string, alert: { message: string; choices?: Array<{ id: string; label: string }> }, o?: { threadId?: string }) => {
      const p = posts.find(x => x.messageId === messageId);
      if (p) { p.text = alert.message; p.choices = alert.choices ?? []; }
      calls.push(`edit ${o?.threadId} ${messageId} ${alert.message.split("\n")[0]} [${(alert.choices ?? []).map(c => c.label).join(", ")}]`);
    }),
    deleteMessage: vi.fn(async () => {}),
    sendText: vi.fn(async (chatId: string, text: string, o?: { threadId?: string; replyTo?: string }) => {
      calls.push(`say ${o?.threadId ?? "-"}${o?.replyTo ? ` ↩${o.replyTo}` : ""} ${text}`);
      return { messageId: `s${++n}`, chatId };
    }),
  } as any;
  const owners: Record<string, string> = { alpha: "tg", lead: "tg", beta: "tg" };
  const topics: Record<string, string | null> = { lead: "55", beta: "66", alpha: "77" };
  const state = { tasks: [] as TaskInput[], actions: [] as TaskAction[], live: true };
  const ctx: NeedsYouHubContext = {
    dataDir: dir, now: () => 1_000_000, mono: () => mono,
    setTimer: (fn, ms) => { const h = ++id; timers.push({ at: mono + ms, fn, id: h }); return h; },
    clearTimer: h => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1); },
    prompts: () => [], instances: () => [], deliveries: () => [],
    ownerOf: i => owners[i],
    worlds: () => [{ id: "tg", place: { type: "telegram", groupId: "-100" }, adapter }],
    noticeTarget: () => ({ chatId: "-100", threadId: "1" }),
    laneTarget: i => (topics[i] ? { chatId: "-100", threadId: topics[i]! } : null),
    instanceTopic: i => topics[i] ?? undefined,
    isFleetAdmin: (u) => u === "100" || u === "101",
    fleetAdmins: () => ["100", "101"],
    emitSse: () => {}, acknowledge: () => true,
    settings: () => ({ liveMessage: state.live, dm: false }), stopping: () => false,
    t: (k, ...a) => `${k}${a.length ? `(${a.join(",")})` : ""}`,
    log: () => {},
    tasks: () => state.tasks,
    taskAction: (a) => { state.actions.push(a); return { ok: true, message: "done" }; },
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
  /** The latest message in a thread (General = "1": Telegram's General topic, which the canonical target names by no thread). */
  const at = (thread: string) => posts.filter(p => p.threadId === (thread === "1" ? undefined : thread)).at(-1);
  /** Click a button as the platform reports it: the message and thread it is on. */
  const click = (label: string, on: { threadId: string; messageId: string; choices: Array<{ id: string; label: string }> }, userId = "100") => {
    const choice = on.choices.find(c => c.label === label);
    if (!choice) throw new Error(`no ${label} in ${JSON.stringify(on.choices.map(c => c.label))}`);
    const acks: string[] = [];
    hub.handleCallback({ callbackData: choice.id, chatId: "-100", threadId: on.threadId, messageId: on.messageId, userId, username: "ann", ack: (x?: string) => acks.push(x ?? "") } as any, "tg");
    return acks;
  };
  const pointers = () => JSON.parse(readFileSync(join(dir, "needs-you-message.json"), "utf8")) as Record<string, { threadId?: string; messageId: string }>;
  return { hub, state, calls, posts, at, click, advance, adapter, owners, topics, pointers, tick: (ms: number) => { mono += ms; } };
}

describe("lanes: a card waits in its lane's channel, not in General", () => {
  it("General lists the rest; each lane its own cards, in its topic, under a header that says here; pointers by lane", async () => {
    const r = rig();
    r.state.tasks = [
      task({ uuid: "u1", code: "M-1" }),                                              // no lane: General
      task({ uuid: "u2", code: "M-2", lane: "lead", status: "blocked", note: "which?" }),
      task({ uuid: "u3", code: "S-3", lane: "lead" }),
      task({ uuid: "u4", code: "M-4", lane: "beta" }),
    ];
    r.hub.start();
    await r.advance(0);
    const general = r.at("1")!, lead = r.at("55")!, beta = r.at("66")!;
    expect(general.text.split("\n")).toEqual(["needs.live_header(1)", expect.stringContaining("M-1")]);
    expect(lead.text.split("\n")[0]).toBe("needs.live_header_lane(2)");
    expect(lead.text).toContain("M-2"); expect(lead.text).toContain("S-3"); expect(lead.text).not.toContain("M-1");
    expect(lead.choices.map(c => c.label)).toEqual(["needs.task_answer_button(M-2)", "needs.task_confirm_button(S-3)", "needs.task_back_button(S-3)"]);
    expect(beta.choices.map(c => c.label)).toEqual(["needs.task_confirm_button(M-4)", "needs.task_back_button(M-4)"]);
    expect(general.choices.map(c => c.label)).toEqual(["needs.task_confirm_button(M-1)", "needs.task_back_button(M-1)"]);
    const p = r.pointers();
    expect([!!p.tg, p.tg?.threadId, p[liveKey("tg", "lead")]?.threadId, p["tg#lane:beta"]?.threadId]).toEqual([true, undefined, "55", "66"]);
  });

  it("a lane's button works on its own message only: from General's message, or another lane's, it is the wrong place", async () => {
    const r = rig();
    r.state.tasks = [task({ uuid: "u2", code: "M-2", lane: "lead" }), task({ uuid: "u4", code: "M-4", lane: "beta" })];
    r.hub.start();
    await r.advance(0);
    const lead = r.at("55")!, beta = r.at("66")!;
    const stolen = { ...beta, choices: lead.choices };                              // lead's button replayed on beta's message
    expect(r.click("needs.task_confirm_button(M-2)", { ...stolen, threadId: "66" })).toEqual(["buttons.wrong_place"]);
    expect(r.state.actions).toEqual([]);
    expect(r.click("needs.task_confirm_button(M-2)", { ...lead, threadId: "55" }, "999")).toEqual(["buttons.admin_only"]);
    expect(r.click("needs.task_confirm_button(M-2)", { ...lead, threadId: "55" })).toEqual(["done"]);
    expect(r.state.actions.map(a => [a.verb, a.code, a.version])).toEqual([["confirm", "M-2", 4]]);
  });

  it("a laned card's world is its lane's, not its assignee's: the lane's admins act even when the assignee is in no world", async () => {
    const r = rig();
    delete r.owners.alpha;                                                          // the assignee: no chat world at all
    r.state.tasks = [task({ uuid: "u2", code: "M-2", lane: "lead" })];
    r.hub.start();
    await r.advance(0);
    expect(r.click("needs.task_confirm_button(M-2)", { ...r.at("55")!, threadId: "55" })).toEqual(["done"]);
    expect(r.state.actions.map(a => a.code)).toEqual(["M-2"]);
  });

  it("a card routed elsewhere since its button showed (its lead or dispatcher changed) is told so, and nothing moves", async () => {
    const r = rig();
    r.state.tasks = [task({ uuid: "u2", code: "M-2", lane: "lead" })];
    r.hub.start();
    await r.advance(0);
    const lead = { ...r.at("55")! };
    r.state.tasks = [task({ uuid: "u2", code: "M-2", lane: "beta" })];             // now beta's
    r.hub.recompute();                                                               // (the old render's buttons are not yet revoked)
    expect(r.click("needs.task_confirm_button(M-2)", { ...lead, threadId: "55" })).toEqual(["needs.task_moved"]);
    expect(r.state.actions).toEqual([]);
  });

  it("Send back asks in the lane's channel; the reply there is taken, unless the card moved meanwhile", async () => {
    const r = rig();
    r.state.tasks = [task({ uuid: "u2", code: "M-2", lane: "lead" })];
    r.hub.start();
    await r.advance(0);
    expect(r.click("needs.task_back_button(M-2)", { ...r.at("55")!, threadId: "55" })).toEqual(["needs.task_reply_asked"]);
    await r.advance(0);
    expect(r.calls.at(-1)).toMatch(/^say 55 needs\.task_back_prompt\(M-2/);
    const prompt = (await r.adapter.sendText.mock.results.at(-1).value).messageId;
    expect(r.hub.handleReply({ adapterId: "tg", chatId: "-100", threadId: "55", replyTo: prompt, messageId: "in1", userId: "100", text: "tick the list" })).toBe(true);
    expect(r.state.actions.map(a => [a.verb, a.code, a.text])).toEqual([["back", "M-2", "tick the list"]]);

    // Again, then the card's lane changes before the reply: not taken (it flows on as an ordinary message).
    r.state.actions = [];
    await r.advance(0);
    r.click("needs.task_back_button(M-2)", { ...r.at("55")!, threadId: "55" });
    await r.advance(0);
    const second = (await r.adapter.sendText.mock.results.at(-1).value).messageId;
    r.state.tasks = [task({ uuid: "u2", code: "M-2", lane: "beta" })];
    r.hub.recompute();
    expect(r.hub.handleReply({ adapterId: "tg", chatId: "-100", threadId: "55", replyTo: second, messageId: "in2", userId: "100", text: "late" })).toBe(false);
    expect(r.state.actions).toEqual([]);
  });

  it("a reply is refused once the lane's channel itself is gone (its topic removed)", async () => {
    const r = rig();
    r.state.tasks = [task({ uuid: "u2", code: "M-2", status: "blocked", note: "which?", lane: "lead" })];
    r.hub.start();
    await r.advance(0);
    r.click("needs.task_answer_button(M-2)", { ...r.at("55")!, threadId: "55" });
    await r.advance(0);
    const prompt = (await r.adapter.sendText.mock.results.at(-1).value).messageId;
    r.topics.lead = null;
    expect(r.hub.handleReply({ adapterId: "tg", chatId: "-100", threadId: "55", replyTo: prompt, messageId: "in1", userId: "100", text: "the current one" })).toBe(false);
    expect(r.state.actions).toEqual([]);
  });

  it("an emptied lane says nothing waits; a lane whose channel is gone says the list moved, without buttons, and is forgotten", async () => {
    const r = rig();
    r.state.tasks = [task({ uuid: "u2", code: "M-2", lane: "lead" }), task({ uuid: "u4", code: "M-4", lane: "beta" })];
    r.hub.start();
    await r.advance(0);
    const lead = r.at("55")!.messageId, beta = r.at("66")!.messageId;
    r.state.tasks = [];
    r.topics.beta = null;
    r.hub.recompute();
    await r.advance(60_000);
    expect(r.calls).toContain(`edit 55 ${lead} needs.live_empty []`);
    expect(r.calls).toContain(`edit 66 ${beta} needs.live_moved []`);
    expect(Object.keys(r.pointers()).sort()).toEqual(["tg#lane:lead"]);          // General never needed posting
  });

  it("a lane message from before a restart is rendered again even with nothing waiting (its old buttons are gone)", async () => {
    const r = rig({ pointers: { tg: { chatId: "-100", threadId: "1", messageId: "old-g" }, "tg#lane:lead": { chatId: "-100", threadId: "55", messageId: "old-l" } } });
    r.hub.start();
    await r.advance(60_000);
    expect(r.calls).toContain("edit 55 old-l needs.live_empty []");
    expect(r.adapter.notifyAlert).not.toHaveBeenCalled();
  });

  it("live_message off turns the lanes off too", async () => {
    const r = rig();
    r.state.tasks = [task({ uuid: "u2", code: "M-2", lane: "lead" })];
    r.hub.start();
    await r.advance(0);
    const lead = r.at("55")!.messageId;
    r.state.live = false;
    r.hub.recompute();
    await r.advance(0);
    expect(r.calls).toContain(`edit 55 ${lead} needs.live_off []`);
  });
});
