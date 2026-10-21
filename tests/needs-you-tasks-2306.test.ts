/**
 * #2306 review: Send back and Answer from the chat's Needs you, at their boundaries.
 * - One prompt per world, card, person and verb at a time: reserved before the send, released when it fails; the
 *   prompts open at once are capped.
 * - A prompt keeps whose card it is and the world as it was: an instance that moved to another world, a replaced
 *   connection or a new notice room — before the prompt is posted or after — and its reply is not taken.
 * - A reply is found by where the prompt is, whichever bot received it, and judged by the prompt's world's admins.
 *
 * Isolation: a fake clock and timers; fake adapters record every call, and a send can be held.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeedsYouHub, TASK_REPLY_MAX, type NeedsYouHubContext, type TaskAction } from "../src/needs-you-hub.js";
import type { TaskInput } from "../src/needs-you.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const task = (over: Partial<TaskInput>): TaskInput => ({
  uuid: "u1", code: "M-1", title: "Weekly leaderboard", status: "review", version: 4, assignee: "alpha", note: "", since: 990_000, ...over,
});

function adapterFor(name: string, calls: string[]) {
  let n = 0;
  const held: Array<{ resolve: (v: { messageId: string }) => void; reject: (e: Error) => void }> = [];
  const a = {
    type: "telegram", hold: false, held,
    notifyAlert: vi.fn(async (chatId: string, alert: { choices?: Array<{ id: string; label: string }> }, opts?: { threadId?: string }) => ({ messageId: `${name}-m${++n}`, chatId, threadId: opts?.threadId })),
    editAlert: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    sendText: vi.fn((chatId: string, text: string, opts?: { threadId?: string; replyTo?: string }) => {
      calls.push(`${name} say ${opts?.replyTo ? `↩${opts.replyTo} ` : ""}${text}`);
      const id = `${name}-s${++n}`;
      if (!a.hold) return Promise.resolve({ messageId: id, chatId });
      return new Promise((resolve, reject) => held.push({ resolve: () => resolve({ messageId: id, chatId }), reject }));
    }),
  };
  return a as typeof a & Record<string, any>;
}

function rig(opts: { admins?: Record<string, string[]> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "needs-tasks-2306-")); dirs.push(dir);
  let mono = 0, id = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  const calls: string[] = [];
  const tg = adapterFor("tg", calls), sib = adapterFor("sib", calls);
  const world = {
    owner: { alpha: "tg" } as Record<string, string | undefined>,
    list: [{ id: "tg", place: { type: "telegram", groupId: "-100" }, adapter: tg as any }, { id: "sib", place: { type: "telegram", groupId: "-200" }, adapter: sib as any }],
    target: { chatId: "-100", threadId: "1" } as { chatId: string; threadId?: string },
  };
  const admins = opts.admins ?? { tg: ["100", "101"], sib: ["100", "101"] };
  const state = { tasks: [] as TaskInput[], actions: [] as TaskAction[] };
  const ctx: NeedsYouHubContext = {
    dataDir: dir, now: () => 1_000_000, mono: () => mono,
    setTimer: (fn, ms) => { const h = ++id; timers.push({ at: mono + ms, fn, id: h }); return h; },
    clearTimer: h => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1); },
    prompts: () => [], instances: () => [], deliveries: () => [],
    ownerOf: i => world.owner[i],
    worlds: () => world.list,
    noticeTarget: (w) => (w === "tg" ? world.target : { chatId: "-200" }),
    instanceTopic: () => "77",
    isFleetAdmin: (u, w) => (admins[w] ?? []).includes(u),
    fleetAdmins: (w) => admins[w] ?? [],
    emitSse: () => {}, acknowledge: () => true,
    settings: () => ({ liveMessage: true, dm: false }), stopping: () => false,
    t: (k, ...a) => `${k}${a.length ? `(${a.join(",")})` : ""}`,
    log: () => {},
    tasks: () => state.tasks,
    taskAction: (a) => { state.actions.push(a); return { ok: true, message: "done" }; },
  };
  const hub = new NeedsYouHub(ctx);
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const end = mono + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift(); mono = next.at; next.fn();
      await settle();
    }
    mono = end;
    await settle();
  };
  const press = (label: string, userId = "100") => {
    const all = [...tg.notifyAlert.mock.calls.map((c: any) => c[1].choices), ...tg.editAlert.mock.calls.map((c: any) => c[2]?.choices)].filter(Boolean);
    const choice = (all.at(-1) as Array<{ id: string; label: string }>).find(c => c.label === label)!;
    const acks: string[] = [];
    hub.handleCallback({ callbackData: choice.id, chatId: "-100", threadId: "1", messageId: `tg-m${tg.notifyAlert.mock.calls.length}`, userId, username: "ann", ack: (n?: string) => acks.push(n ?? "") } as any, "tg");
    return acks;
  };
  const prompts = () => calls.filter(c => c.includes("needs.task_back_prompt") || c.includes("needs.task_answer_prompt")).length;
  const reply = (replyTo: string, over: Record<string, unknown> = {}) =>
    hub.handleReply({ adapterId: "tg", chatId: "-100", threadId: "1", replyTo, messageId: `in${Math.random()}`, userId: "100", username: "ann", text: "ties share a rank", ...over });
  /** The message id of the last prompt the bot posted. */
  const lastPrompt = async () => (await tg.sendText.mock.results.at(-1)!.value as { messageId: string }).messageId;
  return { hub, state, calls, tg, sib, world, admins, advance, settle, press, prompts, reply, lastPrompt, tick: (ms: number) => { mono += ms; } };
}

async function started(over: Partial<TaskInput> = {}, opts?: Parameters<typeof rig>[0]) {
  const r = rig(opts);
  r.state.tasks = [task(over)];
  r.hub.start();
  await r.advance(0);
  return r;
}

describe("one prompt per card, person and verb at a time", () => {
  it("presses while the prompt is on its way, or still waits, post nothing more; a hundred replays post one", async () => {
    const r = await started();
    r.tg.hold = true;
    expect(r.press("needs.task_back_button(M-1)")).toEqual(["needs.task_reply_asked"]);
    for (let i = 0; i < 100; i++) r.press("needs.task_back_button(M-1)");
    await r.settle();
    expect(r.prompts()).toBe(1);
    expect(r.press("needs.task_back_button(M-1)")).toEqual(["needs.task_reply_already(M-1)"]);
    r.tg.held.shift()!.resolve({ messageId: "x" }); await r.settle();
    expect(r.press("needs.task_back_button(M-1)")).toEqual(["needs.task_reply_already(M-1)"]);   // the prompt now waits
    expect(r.prompts()).toBe(1);
    // Another person, or the other verb's prompt, is its own.
    expect(r.press("needs.task_back_button(M-1)", "101")).toEqual(["needs.task_reply_asked"]);
  });

  it("a send that fails releases its reservation: the next press asks again; an answered prompt frees it too", async () => {
    const r = await started();
    r.tg.hold = true;
    r.press("needs.task_back_button(M-1)");
    await r.settle();
    r.tg.held.shift()!.reject(new Error("telegram is down")); await r.settle();
    r.tg.hold = false;
    expect(r.press("needs.task_back_button(M-1)")).toEqual(["needs.task_reply_asked"]);
    await r.settle();
    expect(r.prompts()).toBe(2);
    expect(r.reply(await r.lastPrompt())).toBe(true);
    await r.settle();
    expect(r.press("needs.task_back_button(M-1)")).toEqual(["needs.task_reply_asked"]);
  });

  it(`at most ${TASK_REPLY_MAX} prompts open at once over every card and person; a lapsed one frees its place`, async () => {
    const users = Array.from({ length: TASK_REPLY_MAX + 3 }, (_, i) => String(1000 + i));
    const r = await started({}, { admins: { tg: users, sib: [] } });
    const acks = users.map((u) => r.press("needs.task_back_button(M-1)", u)[0]);
    await r.settle();
    expect(acks.filter((a) => a === "needs.task_reply_asked")).toHaveLength(TASK_REPLY_MAX);
    expect(acks.slice(TASK_REPLY_MAX)).toEqual(["needs.task_reply_busy", "needs.task_reply_busy", "needs.task_reply_busy"]);
    expect(r.prompts()).toBe(TASK_REPLY_MAX);
    r.tick(10 * 60_000);
    expect(r.press("needs.task_back_button(M-1)", users.at(-1))).toEqual(["needs.task_reply_asked"]);
  });
});

describe("a prompt is its world's only while the card's instance, the connection and the room stay", () => {
  it("control: nothing moved — the reply is taken", async () => {
    const r = await started();
    r.press("needs.task_back_button(M-1)"); await r.settle();
    expect(r.reply(await r.lastPrompt())).toBe(true);
    expect(r.state.actions.map((a) => [a.verb, a.code, a.version])).toEqual([["back", "M-1", 4]]);
  });

  it("the instance moved to another world while the prompt was on its way: no prompt is kept — even once it is back — and a new press may ask", async () => {
    const r = await started({ status: "blocked", note: "which?" });
    r.tg.hold = true;
    r.press("needs.task_answer_button(M-1)"); await r.settle();
    r.world.owner.alpha = "sib";
    r.tg.held.shift()!.resolve({ messageId: "x" }); await r.settle();
    r.world.owner.alpha = "tg";                                         // back: the prompt posted meanwhile is still not kept
    expect(r.reply(await r.lastPrompt())).toBe(false);
    expect(r.state.actions).toEqual([]);
    r.tg.hold = false;
    expect(r.press("needs.task_answer_button(M-1)")).toEqual(["needs.task_reply_asked"]);
  });

  it("the instance moved after the prompt was posted, or the connection was replaced, or the notice room changed: its reply is not taken", async () => {
    for (const move of [
      (r: Awaited<ReturnType<typeof started>>) => { r.world.owner.alpha = "sib"; },
      (r: Awaited<ReturnType<typeof started>>) => { r.world.list = [{ ...r.world.list[0]!, adapter: { ...r.tg } }, r.world.list[1]!]; },
      (r: Awaited<ReturnType<typeof started>>) => { r.world.target = { chatId: "-100", threadId: "9" }; },
    ]) {
      const r = await started({ status: "blocked", note: "which?" });
      r.press("needs.task_answer_button(M-1)"); await r.settle();
      const prompt = await r.lastPrompt();
      move(r);
      expect(r.reply(prompt)).toBe(false);
      expect(r.state.actions).toEqual([]);
    }
  });
});

describe("a reply is found by where its prompt is, whichever bot received it, and judged by the prompt's world", () => {
  it("the sibling bot's copy of the admin's reply is the answer: taken once, and answered by the bot that asked", async () => {
    const r = await started();
    r.press("needs.task_back_button(M-1)"); await r.settle();
    const prompt = await r.lastPrompt();
    expect(r.reply(prompt, { adapterId: "sib", messageId: "in-1" })).toBe(true);
    expect(r.reply(prompt, { adapterId: "tg", messageId: "in-1" })).toBe(false);       // the other copy: already answered
    expect(r.state.actions).toHaveLength(1);
    await r.settle();
    expect(r.calls.at(-1)).toBe("tg say ↩in-1 done");
  });

  it("unauthorized: another person's reply is not taken; nor the clicker's once no admin of the prompt's world — even if still one of the receiving bot's", async () => {
    const r = await started({}, { admins: { tg: ["100"], sib: ["100", "102"] } });
    r.press("needs.task_back_button(M-1)"); await r.settle();
    const prompt = await r.lastPrompt();
    expect(r.reply(prompt, { adapterId: "sib", userId: "102" })).toBe(false);
    r.admins.tg = [];
    expect(r.reply(prompt, { adapterId: "sib", userId: "100" })).toBe(false);
    expect(r.state.actions).toEqual([]);
    r.admins.tg = ["100"];
    expect(r.reply(prompt, { adapterId: "sib", userId: "100" })).toBe(true);
  });
});
