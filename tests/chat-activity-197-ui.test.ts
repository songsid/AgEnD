/**
 * AGEND-197 (the owner's ruling on #3648), the page. The chat's activity block is drawn as #3639's mockups:
 *   running  — shut to ONE live line (the current step · N tools · elapsed); opened, the steps with the newest in bold;
 *   finished — one line "Tool history · used N tools" and its duration above the reply; never duplicated on reload;
 *   a turn with no shown step has no block; a lone `.` after the reply is not a step;
 *   the words follow the page's language (the steps are structured data, not a rendered Chinese string);
 *   live: before the reply — by the stream's tick, by a poll when the stream has fallen back to polling, and on a message.
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";
import { LogService } from "../src/log-service.js";
import { chatStep, type LogStep } from "../src/log-steps.js";

type Mod = any;
let thread: Mod, act: Mod, groups: Mod, i18n: Mod;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  thread = await import("/ui/js/chat-thread.js");
  act = await import("/ui/js/chat-activity.js");
  groups = await import("/ui/js/chat-activity-groups.js");
  await import("/ui/js/chat-strings.js");
  i18n = await import("/assets/app-i18n.js");
  base.restore();
});
let pg: AppPage | null = null;
const tmp: string[] = [];
afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = null; act.forgetActivity(); i18n.setLang("en"); for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

const tr = (k: string, ...a: unknown[]) => i18n.t(k, ...a);
const NOW = Date.now();
const user = (anchor = "w-u1", ts = NOW - 60_000): LogStep => ({ id: `u-${anchor}`, turn: "t1", ts, kind: "user", anchor: { messageId: anchor } });
const tool = (id: string, over: Partial<LogStep> = {}): LogStep => ({ id, turn: "t1", ts: NOW - 50_000, kind: "tool", tool: "Read", cat: "read", subject: "/srv/w/src/a.ts", status: "done", ...over });
const reply = (id: string, ts: number, messageId: string): LogStep => ({ id, turn: "t1", ts, kind: "tool", tool: "mcp__agend__reply", cat: "message", status: "done", anchor: { messageId, replyText: "hi" } });
const say = (id: string, body: string, ts = NOW - 5_000): LogStep => ({ id, turn: "t1", ts, kind: "assistant", body });
const end = (ts = NOW - 1000): LogStep => ({ id: "end", turn: "t1", ts, kind: "turn_end" });
const rows = (withReply = true) => [
  { boot: "b", id: 1, role: "user", sender: "u", text: "do it", anchor: "w-u1", ts: new Date(NOW - 61_000).toISOString() },
  ...(withReply ? [{ boot: "b", id: 2, role: "agent", sender: "w", text: "hi", anchor: "w-r1", ts: new Date(NOW - 3_000).toISOString() }] : []),
];

function mount(ctx: () => Mod = () => ({ paths: { cwd: "/srv/w", home: "/home/me" }, thinking: false })) {
  pg = page({ storage: { agend_tour_done: "1" } });
  const doc = pg.document as any;
  const scroller = doc.createElement("div"), list = doc.createElement("div");
  scroller.append(list); doc.body.append(scroller);
  const th = thread.createThread(list, scroller, {
    t: (k: string) => i18n.t(k), tf: (k: string, ...a: unknown[]) => i18n.t(k, ...a), isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {},
    setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
    activity: { mount: (node: unknown, g: unknown) => act.mountActivity(node, g, ctx) },
  });
  return { list, th };
}
const draw = (th: Mod, r: Mod[], s: LogStep[]) => th.render(groups.composeRows(r, groups.groupSteps(r, s, { now: NOW, complete: true })));
const blocks = (list: Mod) => [...list.querySelectorAll(".activity-row")].filter((n: any) => !n.hidden);
const det = (node: Mod) => node.querySelector("details");
const isOpen = (el: Mod) => el.open === true || el.hasAttribute("open");

describe("a running turn: one shut line, opened the steps (newest in bold)", () => {
  const going = [user(), tool("a", { subject: "/srv/w/src/panel.js" }), tool("b", { tool: "Bash", cat: "run", subject: "npm run build", status: "done" }), tool("c", { subject: "/srv/w/tests/x.test.ts", status: "running" })];
  it("collapsed by default; the line is the current step, then N tools · elapsed", async () => {
    const { list, th } = mount();
    draw(th, rows(false), going.map((s, i) => ({ ...s, ts: NOW - 40_000 + i }) as LogStep));
    await settle();
    const b = blocks(list);
    expect(b).toHaveLength(1);
    expect(det(b[0]).classList.contains("live")).toBe(true);
    expect(isOpen(det(b[0]))).toBe(false);
    expect(b[0].querySelector(".act-title").textContent).toBe(`${tr("log.cat_read")} tests/x.test.ts`);   // the newest step, its path shortened
    expect(b[0].querySelector(".act-meta").textContent).toMatch(/^3 tools · \d+ s$|^3 tools · \d+ m \d+ s$/);
    expect(b[0].querySelector(".act-spin")).not.toBeNull();
  });
  it("opened (by the reader): every step, the newest in bold, and it stays open as the turn grows", async () => {
    const { list, th } = mount();
    draw(th, rows(false), going);
    await settle();
    fire(blocks(list)[0].querySelector("summary"), "click"); await settle();
    const items = blocks(list)[0].querySelectorAll(".log-item");
    expect(items).toHaveLength(3);
    expect([...items].map((e: any) => e.classList.contains("latest"))).toEqual([false, false, true]);
    expect(items[0].classList.contains("compact")).toBe(true);
    draw(th, rows(false), [...going, tool("d", { subject: "/srv/w/src/z.ts", status: "running" })]);
    await settle();
    const more = blocks(list)[0].querySelectorAll(".log-item");
    expect(more).toHaveLength(4);
    expect(isOpen(det(blocks(list)[0]))).toBe(true);
    expect([...more].map((e: any) => e.classList.contains("latest"))).toEqual([false, false, false, true]);
  });
  it("no step shown yet (only thinking, which this browser or the server hides): no block", async () => {
    const { list, th } = mount();
    draw(th, rows(false), [user(), { id: "t", turn: "t1", ts: NOW - 10_000, kind: "thinking", body: "hmm" } as LogStep]);
    await settle();
    expect(blocks(list)).toHaveLength(0);
  });
});

describe("a finished turn: one line above the reply", () => {
  const done = [user(), tool("a", { ts: NOW - 50_000 }), tool("b", { tool: "Bash", cat: "run", subject: "npm", ts: NOW - 40_000 }), reply("r", NOW - 4_000, "w-r1"), end()];
  it("“Tool history · used N tools” and the time the work took, shut, above the reply bubble", async () => {
    const { list, th } = mount();
    draw(th, rows(), done);
    await settle();
    const kids = [...list.children].map((c: any) => (c.classList.contains("activity-row") ? "activity" : c.classList.contains("user") ? "user" : "agent"));
    expect(kids).toEqual(["user", "activity", "agent"]);
    const b = blocks(list)[0];
    expect(det(b).classList.contains("done")).toBe(true);
    expect(isOpen(det(b))).toBe(false);
    expect(b.querySelector(".act-title").textContent).toBe(`${tr("act.history")} · ${tr("act.usedTools", 2)}`);
    expect(b.querySelector(".act-meta").textContent).toBe("56 s");              // from the turn's start to the reply call
    expect(b.querySelector(".act-spin")).toBeNull();
  });
  it("a turn with no tools but something said: still one block, worded as steps (not 'used 0 tools')", async () => {
    const { list, th } = mount();
    draw(th, rows(), [user(), say("s", "Checking the notes first.", NOW - 30_000), reply("r", NOW - 4_000, "w-r1"), end()]);
    await settle();
    expect(blocks(list)[0].querySelector(".act-title").textContent).toBe(`${tr("act.activity")} · ${tr("act.stepN")}`);
  });
  it("a turn with no shown step has no block at all — the lone `.` Claude Code writes after its reply is not one", async () => {
    const { list, th } = mount();
    draw(th, rows(), [user(), reply("r", NOW - 4_000, "w-r1"), say("dot", ".", NOW - 3_900), end()]);
    await settle();
    expect(blocks(list)).toHaveLength(0);
    for (const punct of ["…", "!!", " ", "。"]) {
      draw(th, rows(), [user(), reply("r", NOW - 4_000, "w-r1"), say("dot", punct, NOW - 3_900), end()]);
      await settle();
      expect(blocks(list), JSON.stringify(punct)).toHaveLength(0);
    }
    // A closing sentence with words is a step.
    draw(th, rows(), [user(), reply("r", NOW - 4_000, "w-r1"), say("dot", "That is all.", NOW - 3_900), end()]);
    await settle();
    expect(blocks(list)).toHaveLength(1);
  });
  it("reloaded: drawn again from the same steps, the block is still ONE per reply (never a second line, a second summary or a second spinner)", async () => {
    const { list, th } = mount();
    draw(th, rows(), done);
    await settle();
    draw(th, rows(), done);
    draw(th, rows(), [...done]);                                          // the same steps read again (a reload reads them all anew)
    await settle();
    expect(list.querySelectorAll(".activity-row")).toHaveLength(1);
    expect(list.querySelectorAll(".act-sum")).toHaveLength(1);
    expect(list.querySelectorAll(".act-block.live")).toHaveLength(0);
    // And a fresh thread (the page reloaded) given the same steps and rows draws the same single block.
    const again = mount();
    draw(again.th, rows(), done);
    await settle();
    expect(again.list.querySelectorAll(".act-sum")).toHaveLength(1);
  });
});

describe("what a step shows follows the agent's tool_progress — as the server cut it", () => {
  const raw: LogStep[] = [user(), { id: "bash", turn: "t1", ts: NOW - 40_000, kind: "tool", tool: "Bash", cat: "run", subject: "npm run typecheck -- --pretty", input: "{\"command\":\"npm run typecheck -- --pretty\"}", body: "no errors", status: "done" } as LogStep, reply("r", NOW - 4_000, "w-r1"), end()];
  const open = async (level: "standard" | "verbose") => {
    const { list, th } = mount();
    draw(th, rows(), raw.map((s) => chatStep(s, level)));
    await settle();
    fire(blocks(list)[0].querySelector("summary"), "click"); await settle();
    return blocks(list)[0];
  };
  it("standard: the step (what kind, the program) — no command, no arguments, no output to open", async () => {
    const b = await open("standard");
    expect(b.querySelector(".log-subject").textContent).toBe("npm");
    expect(b.querySelector(".log-toggle")).toBeNull();
    expect(b.textContent).not.toContain("typecheck");
    expect(b.textContent).not.toContain("no errors");
  });
  it("verbose: adds the command, and the arguments and output on demand", async () => {
    const b = await open("verbose");
    expect(b.querySelector(".log-subject").textContent).toBe("npm run typecheck -- --pretty");
    fire(b.querySelector(".log-toggle"), "click"); await settle();
    expect(b.textContent).toContain("no errors");
  });
});

describe("the words follow the page's language (structured steps, not a rendered string)", () => {
  const steps = [user(), tool("a"), tool("b", { tool: "Bash", cat: "run", subject: "npm" }), tool("c", { tool: "Grep", cat: "search" }), reply("r", NOW - 4_000, "w-r1"), end()];
  const words = async (lang: string) => {
    i18n.setLang(lang);
    const { list, th } = mount();
    draw(th, rows(), steps);
    await settle();
    fire(blocks(list)[0].querySelector("summary"), "click"); await settle();
    const b = blocks(list)[0];
    return { title: b.querySelector(".act-title").textContent, cats: [...b.querySelectorAll(".log-cat")].map((e: any) => e.textContent) };
  };
  it("English: English words, no Chinese anywhere in the block", async () => {
    const en = await words("en");
    expect(en.title).toBe("Tool history · used 3 tools");
    expect(en.cats).toEqual(["Read", "Run", "Search"]);
    expect(JSON.stringify(en)).not.toMatch(/[一-鿿]/);
  });
  it("Traditional Chinese: the same steps in Chinese", async () => {
    const zh = await words("zh-TW");
    expect(zh.title).toBe("工具歷程 · 用了 3 個工具");
    expect(zh.cats).toEqual(["讀取", "執行", "搜尋"]);
  });
});

describe("live before the reply — the feed", () => {
  const rec = (o: unknown) => JSON.stringify(o) + "\n";
  const stamp = (n: number) => new Date(NOW - 60_000 + n * 1000).toISOString();
  it("a real transcript growing line by line: the block is there while the agent works, before its reply, and becomes the reply's block in the same group key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-197-live-")); tmp.push(dir);
    const f = join(dir, "t.jsonl");
    writeFileSync(f, rec({ type: "user", promptId: "p1", timestamp: stamp(0), message: { role: "user", content: "(message_id: w-u1 | verification_id: v)\nplease look" } }));
    const svc = new LogService({ enabled: () => false, toolProgress: () => "standard", thinking: () => false, known: () => true,
      source: () => ({ backend: "claude-code", path: f, format: "claude" }), events: () => [], emit() {} });
    const fetcher = async (u: string) => {
      const q = new URL(u, "http://x").searchParams, o: Record<string, unknown> = { chat: true };
      for (const [k, v] of q) { if (["after", "before", "ev", "limit"].includes(k)) o[k] = Number(v); else if (k === "key") o.key = v; else if (k === "skip" || k === "watch") o[k] = v === "1"; }
      const a = await svc.steps("w", o as never);
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(a)) };
    };
    pg = page(); (pg.document as any).body.dataset.chatActivity = "1";
    let tick: ((d: unknown) => void) | null = null;
    const feed = act.observeActivity("w", { fetcher, changed() {}, streamOn: (_n: string, fn: (d: unknown) => void) => { tick = fn; return () => {}; }, setTimer: () => 0, clearTimer() {} });
    feed.start(); await settle();
    const shape = (r: Mod[]) => r.map((x: any) => (x.role === "activity" ? `act:${x.group.level}:${x.group.items.length}` : x.role)).join(" ");
    const user1 = rows(false);
    expect(shape(feed.compose(user1))).toBe("user");                           // nothing done yet: no block (the work bar says "working")
    appendFileSync(f, rec({ type: "assistant", timestamp: stamp(2), message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/srv/w/a.ts" } }] } }));
    tick!({ instance: "w" }); await settle();
    expect(shape(feed.compose(user1))).toBe("user act:live:1");                // the first step, long before any reply
    const key = feed.compose(user1)[1].group.key;
    appendFileSync(f, rec({ type: "user", promptId: "p1", timestamp: stamp(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } })
      + rec({ type: "assistant", timestamp: stamp(4), message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }] } }));
    tick!({ instance: "w" }); await settle();
    expect(shape(feed.compose(user1))).toBe("user act:live:2");
    expect(feed.compose(user1)[1].group.key).toBe(key);
    // the reply: its row arrives (by anchor), the same key above it
    appendFileSync(f, rec({ type: "assistant", timestamp: stamp(6), message: { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "mcp__agend__reply", input: { text: "hi" } }] } })
      + rec({ type: "user", promptId: "p1", timestamp: stamp(6.5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "{\"chatId\":\"web\",\"messageId\":\"w-r1\"}" }] } })
      + rec({ type: "assistant", timestamp: stamp(7), message: { role: "assistant", content: [{ type: "text", text: "." }] } })
      + rec({ type: "system", subtype: "turn_duration", durationMs: 7000, timestamp: stamp(7.5) }));
    tick!({ instance: "w" }); await settle();
    const rowsDone = rows(true).map((r) => (r.role === "agent" ? { ...r, ts: stamp(6.6) } : { ...r, ts: stamp(-1) }));
    expect(shape(feed.compose(rowsDone))).toBe("user act:id:2 agent");        // the `.` is not a step: two tools, one block, above the reply
    expect(feed.compose(rowsDone)[1].group.key).toBe(key);                      // the same group the live block was
    feed.stop();
  });

  const fakeFeed = (over: Record<string, unknown> = {}, answers: Array<Record<string, unknown>> = [{ enabled: true, supported: true, level: "standard", thinking: false, key: "1-1", steps: [], events: [], before: null, after: 10, ev: 0 }]) => {
    const calls: string[] = [];
    const timers: Array<{ fn: () => void; ms: number; on: boolean }> = [];
    const ticks = new Set<(d: unknown) => void>();
    const fetcher = vi.fn(async (url: string) => { calls.push(url); const a = answers.length > 1 ? answers.shift()! : answers[0]!; return { ok: true, status: 200, json: async () => structuredClone(a) }; });
    const feed = act.observeActivity("w", { fetcher, changed() {}, streamOn: (n: string, fn: (d: unknown) => void) => { if (n === "steps_tick") ticks.add(fn); return () => ticks.delete(fn); },
      setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, on: true }; timers.push(t); return t; }, clearTimer: (t: { on: boolean }) => { t.on = false; }, shown: () => true, ...over });
    return { feed, calls, timers, ticks };
  };
  it("the stream has fallen back to polling (no steps_tick travels): the feed polls every POLL_MS — and does not while the stream is live", async () => {
    pg = page();
    let polling = false;
    const f = fakeFeed({ polling: () => polling });
    f.feed.start(); await settle();
    const poll = f.timers.find((t) => t.ms === act.POLL_MS)!;
    expect(poll).toBeDefined();
    const before = f.calls.length;
    poll.fn(); await settle();
    expect(f.calls.length).toBe(before);                 // live stream: the tick does it; the poll is idle
    polling = true;                                      // SSE went silent: appStore.connection is now "polling"
    poll.fn(); await settle();
    expect(f.calls.length).toBe(before + 1);
    expect(f.calls.at(-1)).toContain("after=10");
  });
  it("nudge(): a message came or went — what is new is read now (once at a time), and never after stop()", async () => {
    pg = page();
    const f = fakeFeed();
    f.feed.start(); await settle();
    const before = f.calls.length;
    f.feed.nudge(); await settle();
    expect(f.calls.length).toBe(before + 1);
    f.feed.stop();
    f.feed.nudge(); await settle();
    expect(f.calls.length).toBe(before + 1);
  });
  it("tool_progress off: no steps are kept, nothing is composed, and the next answer with it on brings them back (not dead for good)", async () => {
    pg = page();
    const live = [user(), tool("a", { status: "running" })];
    const f = fakeFeed({}, [
      { enabled: true, supported: true, level: "off", thinking: false, steps: [], events: [], before: null, after: null, ev: 0 },
      { enabled: true, supported: true, level: "standard", thinking: false, key: "1-1", steps: live, events: [], before: null, after: 50, ev: 0 },
    ]);
    f.feed.start(); await settle();
    expect(f.feed.info().level).toBe("off");
    expect(f.feed.dead()).toBe(false);
    expect(f.feed.compose(rows(false))).toEqual(rows(false));
    for (const fn of f.ticks) fn({ instance: "w" }); await settle();            // the owner turned tool_progress on
    expect(f.feed.info().level).toBe("standard");
    expect(f.feed.compose(rows(false)).filter((r: any) => r.role === "activity")).toHaveLength(1);
    expect(f.calls[0]).toContain("chat=1");
  });
  it("AGEND-210: tool_progress moves from standard to verbose — the steps held (cut at standard) are dropped and the window is read again", async () => {
    pg = page();
    const std = tool("a", { tool: "Bash", cat: "run", subject: "git" });                                  // what standard keeps: no output
    const full = tool("a", { tool: "Bash", cat: "run", subject: "git status", body: "On branch main", input: '{"command":"git status"}' });
    const f = fakeFeed({}, [
      { enabled: true, supported: true, level: "standard", thinking: false, key: "1-1", steps: [user(), std], events: [], before: null, after: 50, ev: 0 },
      // the next read (after=50) was answered at the new level: only what is new, and the old step is not in it
      { enabled: true, supported: true, level: "verbose", thinking: false, key: "1-1", steps: [tool("b", { subject: "/srv/w/b.ts" })], events: [], before: null, after: 80, ev: 0 },
      // the window, read again at verbose: the old step now with its output
      { enabled: true, supported: true, level: "verbose", thinking: false, key: "1-1", steps: [user(), full, tool("b", { subject: "/srv/w/b.ts" })], events: [], before: null, after: 80, ev: 0 },
    ]);
    f.feed.start(); await settle();
    for (const fn of f.ticks) fn({ instance: "w" }); await settle();
    expect(f.calls).toHaveLength(3);
    expect(f.calls[1]).toContain("after=50");                                                           // the incremental read
    expect(f.calls[2]).not.toContain("after=");                                                         // then the window again
    expect(f.feed.info().level).toBe("verbose");
    const items = (f.feed.compose(rows(false)).find((r: any) => r.role === "activity") as any).group.items;
    expect(items.find((x: any) => x.id === "a")).toMatchObject({ subject: "git status", body: "On branch main" });   // not the standard step kept
  });
  it("AGEND-210 (counter): the level unchanged keeps the steps and the cursor — only a change reopens the window", async () => {
    pg = page();
    const f = fakeFeed({}, [
      { enabled: true, supported: true, level: "standard", thinking: false, key: "1-1", steps: [user(), tool("a")], events: [], before: null, after: 50, ev: 0 },
      { enabled: true, supported: true, level: "standard", thinking: false, key: "1-1", steps: [tool("b")], events: [], before: null, after: 80, ev: 0 },
    ]);
    f.feed.start(); await settle();
    for (const fn of f.ticks) fn({ instance: "w" }); await settle();
    expect(f.calls).toHaveLength(2);
    const items = (f.feed.compose(rows(false)).find((r: any) => r.role === "activity") as any).group.items;
    expect(items.map((x: any) => x.id)).toEqual(["a", "b"]);
  });
});
