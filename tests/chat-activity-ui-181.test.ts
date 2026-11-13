/**
 * AGEND-181 PR1, the page: the chat's activity timeline — a Preact island in the keyed DOM thread (one node for a live
 * turn and the reply it becomes: nothing remounts, what the reader opened stays), thinking only as asked, paths shortened
 * for display only, long groups folded with "Show N earlier steps"; the feed (GET /ui/steps) that fills it; and the Log
 * tab's rows unchanged (the shared row, log-row.js). The real modules in the mini DOM with the vendored Preact.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";
import { ClaudeStepParser, type LogStep } from "../src/log-steps.js";

type Mod = any;
let thread: Mod, act: Mod, groups: Mod, row: Mod, i18n: Mod;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  thread = await import("/ui/js/chat-thread.js");
  act = await import("/ui/js/chat-activity.js");
  groups = await import("/ui/js/chat-activity-groups.js");
  row = await import("/ui/js/log-row.js");
  await import("/ui/js/chat-strings.js");
  i18n = await import("/assets/app-i18n.js");
  base.restore();
});
let pg: AppPage | null = null;
afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = null; act.forgetActivity(); });

const FIX = join(import.meta.dirname, "fixtures", "chat-activity-3648");
const ledger = JSON.parse(readFileSync(join(FIX, "claude-web-chat.ledger.json"), "utf8")) as Array<Record<string, any>>;
const records = readFileSync(join(FIX, "claude-web-chat.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => {
  const e = JSON.parse(l);
  for (const b of e.message?.content ?? []) if (b?.type === "thinking" && b.thinking === "") b.thinking = "Checking the fleet first.";
  return JSON.stringify(e);
});
const steps = (from = 0, to = records.length): LogStep[] => { const p = new ClaudeStepParser({ thinking: true }); records.slice(from, to).forEach((r, i) => p.push(r, i * 1000)); return p.steps; };
const NOW = Date.parse("2026-11-11T07:00:00Z");
const tr = (k: string) => i18n.t(k);

function mount(ctx: () => Mod = () => ({ paths: null, thinking: true })) {
  pg = page({ storage: { agend_tour_done: "1" } });
  const doc = pg.document as any;
  const scroller = doc.createElement("div"), list = doc.createElement("div");
  scroller.append(list); doc.body.append(scroller);
  const th = thread.createThread(list, scroller, {
    t: tr, tf: (k: string, ...a: unknown[]) => i18n.t(k, ...a), isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {},
    setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
    activity: { mount: (node: unknown, g: unknown) => act.mountActivity(node, g, ctx) },
  });
  return { list, th, doc };
}
const draw = (th: Mod, rows: Mod[], s: LogStep[], o: Record<string, unknown> = {}) => th.render(groups.composeRows(rows, groups.groupSteps(rows, s, { now: NOW, complete: true, ...o })));
const blocks = (list: Mod) => list.querySelectorAll(".activity-row");
const isOpen = (el: Mod) => el.open === true || el.hasAttribute("open");

describe("the timeline in the thread", () => {
  it("each reply has its turn's block right above it; the person's bubble and the reply stay untouched", async () => {
    const { list, th } = mount();
    draw(th, ledger, steps());
    await settle();
    const kids = [...list.children].map((c: any) => (c.classList.contains("activity-row") ? "activity" : c.classList.contains("user") ? "user" : "agent"));
    expect(kids).toEqual(["user", "activity", "agent", "user", "activity", "agent"]);
    const second = blocks(list)[1];
    // Finished: ONE line, "Tool history · used N tools" (its three tool calls; thinking and the line said after the reply are steps, not tools).
    expect(second.querySelector(".act-title").textContent).toBe(`${tr("act.history")} · ${i18n.t("act.usedTools", 3)}`);
    expect(blocks(list)[0].querySelector(".act-title").textContent).toBe(`${tr("act.history")} · ${tr("act.usedTool")}`);
    expect(isOpen(second.querySelector("details"))).toBe(false);                 // finished: shut
    expect(list.querySelectorAll(".msg[data-key]")).toHaveLength(4);             // activity rows are not messages
  });
  it("a live turn is SHUT to one line naming its current step; its reply arriving keeps the same node, with the reader's choice kept", async () => {
    const { list, th } = mount();
    const upTo = records.findIndex((r) => r.includes("I looked at the fleet"));
    const going = steps(0, upTo);
    draw(th, ledger.slice(0, 3), going);
    await settle();
    const node = blocks(list)[blocks(list).length - 1];
    expect(node.querySelector("details").classList.contains("live")).toBe(true);
    expect(node.querySelector(".act-title").textContent).toBe(tr("log.thinking"));      // the newest step of the turn so far
    expect(isOpen(node.querySelector("details"))).toBe(false);
    // the reply arrives: the group is now that reply's, above its row — the very same node
    draw(th, ledger, steps());
    await settle();
    expect(blocks(list)).toHaveLength(2);
    expect(blocks(list)[1]).toBe(node);
    expect(node.querySelector("details").classList.contains("done")).toBe(true);
    expect(isOpen(node.querySelector("details"))).toBe(false);
    // the reader opens it; a later update (a tick) leaves it open
    fire(node.querySelector("summary"), "click");
    await settle();
    expect(isOpen(node.querySelector("details"))).toBe(true);
    draw(th, ledger, steps());
    await settle();
    expect(isOpen(blocks(list)[1].querySelector("details"))).toBe(true);
  });
  it("without a way to draw it (opts.activity absent) the thread shows only messages", async () => {
    pg = page();
    const doc = pg.document as any;
    const list = doc.createElement("div"), scroller = doc.createElement("div");
    const th = thread.createThread(list, scroller, { t: tr, tf: tr, isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {}, setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {} });
    draw(th, ledger, steps());
    expect(blocks(list)).toHaveLength(0);
    expect(list.querySelectorAll(".msg[data-key]")).toHaveLength(4);
  });
});

describe("what a block shows", () => {
  it("thinking only when asked for; a block of nothing else is hidden; hiding is the page's, showing needs the server's answer", async () => {
    let thinking = true;
    const { list, th } = mount(() => ({ paths: null, thinking }));
    draw(th, ledger, steps());
    await settle();
    fire(blocks(list)[1].querySelector("summary"), "click"); await settle();
    expect(list.querySelectorAll(".act-block .k-thinking").length).toBe(3);
    thinking = false;
    draw(th, ledger, steps());
    await settle();
    expect(list.querySelectorAll(".act-block .k-thinking")).toHaveLength(0);
    // the first reply's block holds only a ToolSearch: still shown; one with only thinking is hidden
    const onlyThinking = [{ id: "t1", turn: "x", ts: 1, kind: "thinking", body: "hmm" }, { id: "r", turn: "x", ts: 2, kind: "tool", tool: "mcp__agend__reply", status: "done", anchor: { messageId: "web-a" } }] as LogStep[];
    draw(th, [{ boot: "b", id: 9, role: "agent", sender: "w", text: "x", ts: new Date(3).toISOString(), anchor: "web-a" }], onlyThinking);
    await settle();
    expect(blocks(list)[0].hidden).toBe(true);
  });
  it("a thinking row is folded to its start and opens on demand", async () => {
    const { list, th } = mount();
    const long = "First line of the reasoning.\nSecond line that is hidden until opened.";
    draw(th, [{ boot: "b", id: 9, role: "agent", sender: "w", text: "x", ts: new Date(3).toISOString(), anchor: "web-a" }],
      [{ id: "t1", turn: "x", ts: 1, kind: "thinking", body: long }, { id: "r", turn: "x", ts: 2, kind: "tool", tool: "mcp__agend__reply", status: "done", anchor: { messageId: "web-a" } }] as LogStep[]);
    await settle();
    fire(blocks(list)[0].querySelector("summary"), "click"); await settle();
    const t1 = () => blocks(list)[0].querySelector(".log-think").textContent;
    expect(t1()).toBe("First line of the reasoning.…");
    fire(blocks(list)[0].querySelector(".log-more"), "click"); await settle();
    expect(t1()).toBe(long);
  });
  it("paths under the working directory are shown relative and home as ~ — the title keeps the full path; the Log tab (no paths) is as before", async () => {
    const paths = { cwd: "/srv/work/proj", home: "/home/me" };
    const { list, th } = mount(() => ({ paths, thinking: true }));
    const s = [{ id: "c", turn: "x", ts: 1, kind: "tool", tool: "Read", cat: "read", subject: "/srv/work/proj/src/a.ts", status: "done" },
      { id: "d", turn: "x", ts: 2, kind: "tool", tool: "Read", cat: "read", subject: "/home/me/.config/x", status: "done" },
      { id: "r", turn: "x", ts: 3, kind: "tool", tool: "mcp__agend__reply", status: "done", anchor: { messageId: "web-a" } }] as LogStep[];
    draw(th, [{ boot: "b", id: 9, role: "agent", sender: "w", text: "x", ts: new Date(4).toISOString(), anchor: "web-a" }], s);
    await settle();
    fire(blocks(list)[0].querySelector("summary"), "click"); await settle();
    const subjects = blocks(list)[0].querySelectorAll(".log-subject").map((e: any) => e.textContent);
    expect(subjects).toEqual(["src/a.ts", "~/.config/x"]);
    expect(blocks(list)[0].querySelector(".log-subject").getAttribute("title")).toBe("/srv/work/proj/src/a.ts");
    expect(row.shortenPaths("/srv/work/proj/src/a.ts", null)).toBe("/srv/work/proj/src/a.ts");
    expect(row.shortenPaths("/srv/work/proj-2/a /srv/work/proj", paths)).toBe("/srv/work/proj-2/a .");
    expect(row.shortenPaths("C:\\Users\\me\\proj\\a.ts", { cwd: "C:\\Users\\me\\proj", home: "C:\\Users\\me" })).toBe("a.ts");
  });
  it("a long group shows its newest rows with Show N earlier steps", async () => {
    const { list, th } = mount();
    const many: LogStep[] = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, turn: "x", ts: i + 1, kind: "tool", tool: "Bash", cat: "run", subject: `cmd ${i}`, status: "done" }) as LogStep);
    many.push({ id: "r", turn: "x", ts: 100, kind: "tool", tool: "mcp__agend__reply", status: "done", anchor: { messageId: "web-a" } } as LogStep);
    draw(th, [{ boot: "b", id: 9, role: "agent", sender: "w", text: "x", ts: new Date(101).toISOString(), anchor: "web-a" }], many);
    await settle();
    fire(blocks(list)[0].querySelector("summary"), "click"); await settle();
    expect(blocks(list)[0].querySelectorAll(".log-item")).toHaveLength(act.SHOWN_MAX);
    expect(blocks(list)[0].querySelector(".act-earlier").textContent).toBe(tr("act.earlier").replace("{0}", String(act.EARLIER_STEP)));
    fire(blocks(list)[0].querySelector(".act-earlier"), "click"); await settle();
    expect(blocks(list)[0].querySelectorAll(".log-item")).toHaveLength(act.SHOWN_MAX + act.EARLIER_STEP);
    expect(blocks(list)[0].querySelector(".act-earlier").textContent).toBe(tr("act.earlier").replace("{0}", String(45 - act.SHOWN_MAX - act.EARLIER_STEP)));
  });
  it("a match that is not exact says so; the exact one does not; the words said after the last reply are in the same block", async () => {
    const { list, th } = mount();
    const noAnchor = ledger.map(({ anchor: _a, ...r }) => r);
    // replies that name no id (R4: one that names an id never falls back to its words): the text match is the one shown
    draw(th, noAnchor, steps().map((s) => (s.anchor?.messageId && s.kind === "tool" ? { ...s, anchor: { replyText: s.anchor.replyText } } : s)));
    await settle();
    expect(blocks(list)[0].querySelector(".act-lvl").textContent).toBe(i18n.t("act.noteInferred", tr("act.lvl_text")));
    draw(th, ledger, steps());
    await settle();
    expect(blocks(list)[0].querySelector(".act-lvl")).toBeNull();
    // What was said after the last reply is the block's last step — in the same block, with no "after the reply" label above the reply.
    const last = blocks(list)[1].querySelectorAll(".log-item");
    expect(last[last.length - 1].textContent).toContain("I could not create the instances");
    expect(blocks(list)[1].querySelector(".act-unsent")).toBeNull();
  });
  it("every string has English and Traditional Chinese", () => {
    const keys = ["working", "history", "activity", "usedTools", "usedTool", "tools", "tool", "stepsN", "stepN", "noteInferred", "lvl_text", "lvl_time", "lvl_turn", "lvl_none", "partial", "earlier", "menuActivity", "menuThinking"];
    const en = keys.map((k) => i18n.t(`act.${k}`));
    i18n.setLang("zh-TW");
    const zh = keys.map((k) => i18n.t(`act.${k}`));
    const thinking = ["said", "thinking", "thinkingMore", "thinkingLess"].map((k) => [i18n.t(`log.${k}`)]);
    i18n.setLang("en");
    expect(en.every((v, i) => v && v !== `act.${keys[i]}`)).toBe(true);
    expect(zh.every((v, i) => v && v !== `act.${keys[i]}` && v !== en[i])).toBe(true);
    expect(thinking.flat().every((v) => v && !v.startsWith("log."))).toBe(true);
  });
});

describe("the feed", () => {
  const answer = (o: Record<string, unknown> = {}) => ({ enabled: true, instance: "w", backend: "claude-code", supported: true, thinking: true, cwd: "/srv/w", home: "/home/me", key: "1-2", steps: [], events: [], before: null, after: 100, ev: 0, ...o });
  function fakeFeed(answers: Array<Record<string, unknown> | number>, over: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const timers: Array<{ fn: () => void; ms: number; on: boolean }> = [];
    const ticks = new Set<(d: unknown) => void>();
    let changed = 0;
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url);
      const a = answers.length > 1 ? answers.shift()! : answers[0]!;
      return typeof a === "number" ? { ok: a < 400, status: a, json: async () => ({}) } : { ok: true, status: 200, json: async () => structuredClone(a) };
    });
    const feed = act.observeActivity("w", { fetcher, changed: () => { changed++; }, streamOn: (n: string, fn: (d: unknown) => void) => { if (n === "steps_tick") ticks.add(fn); return () => ticks.delete(fn); },
      setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, on: true }; timers.push(t); return t; }, clearTimer: (t: { on: boolean }) => { t.on = false; }, shown: () => true, ...over });
    return { feed, calls, timers, ticks, fetcher, get changed() { return changed; } };
  }
  const bodyAttrs = (v: Record<string, string>) => { pg = page(); for (const [k, x] of Object.entries(v)) (pg.document as any).body.dataset[k] = x; };

  it("opens the window with the watch (and thinking when offered), then reads after its cursor on each steps_tick, merging by id", async () => {
    bodyAttrs({ chatActivity: "1", logThinking: "1" });
    const first = answer({ steps: [{ id: "a", turn: "t", ts: 1, kind: "tool", tool: "Bash", status: "running" }], after: 10 });
    const next = answer({ steps: [{ id: "a", turn: "t", ts: 1, kind: "tool", tool: "Bash", status: "done" }, { id: "b", turn: "t", ts: 2, kind: "assistant", body: "ok" }], after: 20 });
    const f = fakeFeed([first, next]);
    f.feed.start(); await settle();
    expect(f.calls[0]).toBe("/ui/steps?instance=w&chat=1&watch=1&thinking=1");
    expect(f.timers.length).toBe(2);                       // the poll (idle while the stream is live) and the lease renewal
    for (const fn of f.ticks) fn({ instance: "other" }); await settle();
    expect(f.calls).toHaveLength(1);                       // another instance's tick reads nothing
    for (const fn of f.ticks) fn({ instance: "w" }); await settle();
    expect(f.calls[1]).toBe("/ui/steps?instance=w&chat=1&watch=1&thinking=1&ev=0&after=10&key=1-2");
    expect(f.feed.info()).toMatchObject({ thinking: true, cwd: "/srv/w" });
    const rows = f.feed.compose([]);                       // the turn has not ended and has no reply yet: the live group, steps merged by id
    expect(rows.map((r: any) => [r.role, r.group.level, r.group.items.map((x: any) => `${x.id}:${x.status ?? x.kind}`)])).toEqual([["activity", "live", ["a:done", "b:assistant"]]]);
    expect(f.changed).toBe(2);
  });
  it("not asked for thinking when the server does not offer it or this browser hides it; switching it on reads the window again", async () => {
    bodyAttrs({ chatActivity: "1", logThinking: "0" });
    let want = true;
    const f = fakeFeed([answer({ thinking: false })], { wantThinking: () => want });
    f.feed.start(); await settle();
    expect(f.calls[0]).toContain("thinking=0");
    f.feed.stop();
    act.forgetActivity();
    bodyAttrs({ chatActivity: "1", logThinking: "1" });
    want = false;
    const g = fakeFeed([answer({ thinking: true })], { wantThinking: () => want });
    g.feed.start(); await settle();
    expect(g.calls[0]).toContain("thinking=0");
    want = true;
    for (const fn of g.ticks) fn({ instance: "w" }); await settle();
    expect(g.calls[1]).toBe("/ui/steps?instance=w&chat=1&watch=1&thinking=1");   // the window again, not a read after the cursor
  });
  it("a server that does not offer it (403, 404, off, a backend with no transcript) ends the feed for this page; stop() ends every timer and listener", async () => {
    bodyAttrs({ chatActivity: "1" });
    for (const a of [403, 404, { enabled: false }, answer({ supported: false, reason: "unsupported" })]) {
      act.forgetActivity();
      const f = fakeFeed([a as never]);
      f.feed.start(); await settle();
      expect(f.feed.dead()).toBe(true);
      expect(f.feed.compose([{ boot: "b", id: 1 }])).toEqual([{ boot: "b", id: 1 }]);
      f.feed.stop();
      expect(f.timers.every((t) => !t.on) && f.ticks.size === 0).toBe(true);
    }
  });
  it("a chat shown again starts from what the page knew (no empty flash), and reads what is new", async () => {
    bodyAttrs({ chatActivity: "1" });
    const s = steps();
    const f = fakeFeed([answer({ steps: s, after: 500, before: null })]);
    f.feed.start(); await settle(); f.feed.stop();
    const shown = act.composeActivity("w", ledger, NOW);
    expect(shown.filter((r: any) => r.role === "activity")).toHaveLength(2);
    const g = fakeFeed([answer({ steps: [], after: 600 })]);
    g.feed.start(); await settle();
    expect(g.calls[0]).toBe("/ui/steps?instance=w&chat=1&watch=1&thinking=0&ev=0&after=500&key=1-2");
  });
  it("nothing is offered unless <body data-chat-activity=1> (an admin session on the local dashboard) — the Log tab's switch no longer decides", () => {
    bodyAttrs({});
    expect(act.activityOffered()).toBe(false);
    (pg!.document as any).body.dataset.logTab = "1";
    expect(act.activityOffered()).toBe(false);
    (pg!.document as any).body.dataset.chatActivity = "0";
    expect(act.activityOffered()).toBe(false);
    (pg!.document as any).body.dataset.chatActivity = "1";
    expect(act.activityOffered()).toBe(true);
  });
});

describe("the Log tab's rows are the shared row, unchanged", () => {
  it("a tool row, a user row and an error row render as before (no paths: nothing shortened); a thinking row only when given one", async () => {
    pg = page();
    const { render } = await import("/assets/app-html.js");
    const { html } = await import("/assets/app-html.js");
    const host = (pg.document as any).createElement("ol"); (pg.document as any).body.append(host);
    const xs = [
      { id: "1", kind: "user", turn: "t", ts: 0, body: "hello /srv/work/proj" },
      { id: "2", kind: "tool", turn: "t", ts: 0, tool: "Read", cat: "read", subject: "/srv/work/proj/a.ts", status: "done", input: "{}", body: "x" },
      { id: "3", kind: "error", turn: "t", ts: 0, body: "boom", note: "500" },
    ];
    render(html`${xs.map((x) => html`<${row.LogRow} key=${x.id} x=${x} />`)}`, host);
    await settle();
    const items = host.querySelectorAll(".log-item");
    expect(items.map((e: any) => e.className.split(" ").filter((c: string) => c.startsWith("k-")).join())).toEqual(["k-user", "k-tool", "k-error"]);
    expect(host.querySelector(".log-subject").textContent).toBe("/srv/work/proj/a.ts");
    expect(host.textContent).toContain("hello /srv/work/proj");
  });
});

describe("Prism #3709 R5: a later read's result with no turn evidence keeps the call's turn", () => {
  const rec = (o: unknown) => JSON.stringify(o);
  const read1 = [
    rec({ type: "user", uuid: "u1", promptId: "p1", message: { role: "user", content: "q (message_id: web-u1 | verification_id: hmsg-1)" } }),
    rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }] } }),
    rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] } }),
    rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "mcp__agend__reply", input: { text: "Done." } }] } }),
  ];
  const read2 = [rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: JSON.stringify({ chatId: "1", messageId: "web-r1" }) }] } })];
  const parse = (records: string[]) => { const p = new ClaudeStepParser(); records.forEach((r, i) => p.push(r, i * 100)); return p.steps; };
  const rows = [
    { boot: "b", id: 1, role: "user", text: "q", ts: new Date(1).toISOString(), anchor: "web-u1" },
    { boot: "b", id: 2, role: "agent", text: "Done.", ts: new Date(2).toISOString(), anchor: "web-r1" },
  ];
  const shaped = (g: any) => g.groups.map((x: any) => [x.turn, x.rowKey, x.level, x.items.map((i: any) => i.tool ?? i.kind)]);

  it("the fresh parser's second read really has no turn for the result (the premise)", () => {
    expect(parse(read2).find((s) => s.id === "r1")?.turn).toBe("");
  });
  it("a poll-by-poll Log groups exactly as a cold read does, and the call's turn survives the merge", () => {
    const cold = parse([...read1, ...read2]);
    const incremental = row.mergeSteps(parse(read1), parse(read2));
    expect(incremental.find((s: LogStep) => s.id === "r1").turn).toBe(cold.find((s) => s.id === "r1")!.turn);
    expect(incremental.find((s: LogStep) => s.id === "r1").turn).not.toBe("");
    const want = shaped(groups.groupSteps(rows, cold, { now: NOW, complete: true }));
    expect(want[0][1]).toBe("b-2");                                   // the cold read attaches the tools to the reply
    expect(shaped(groups.groupSteps(rows, incremental, { now: NOW, complete: true }))).toEqual(want);
  });
  it("the older-page direction: a call's turn is filled in when the newer read knew only the result", () => {
    const newer = parse(read2), older = parse(read1);
    const merged = row.mergeSteps(newer, older, true);
    expect(merged.find((s: LogStep) => s.id === "r1")).toMatchObject({ tool: "mcp__agend__reply", turn: parse(read1).find((s) => s.id === "r1")!.turn });
    expect(merged.find((s: LogStep) => s.id === "r1").turn).not.toBe("");
  });
  it("controls: a result that does name a turn still sets it; a step with no turn anywhere stays without one", () => {
    expect(row.mergeSteps([{ id: "a", kind: "tool", turn: "" }], [{ id: "a", kind: "tool", turn: "t2" }])[0].turn).toBe("t2");
    expect(row.mergeSteps([{ id: "a", kind: "tool", turn: "t1" }], [{ id: "a", kind: "tool", turn: "t2" }])[0].turn).toBe("t2");
    expect(row.mergeSteps([{ id: "a", kind: "tool", turn: "" }], [{ id: "a", kind: "tool", turn: "" }])[0].turn).toBe("");
  });
});
