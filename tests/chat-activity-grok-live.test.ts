/**
 * grok's turn in progress. The preview's report: "gork-test is working… 0:36" at the bottom, grok thinking in its
 * own pane, and NO block in the chat. Root cause, measured on that preview's own `updates.jsonl` and `events.jsonl`:
 *
 *   • grok writes `user_message_chunk` at once, but an `agent_thought_chunk` only when the thought ENDS (the next tool call,
 *     or the turn's end) — as ONE record. The captured turn (tests/fixtures/chat-activity-3648/grok-thinking-only-turn.jsonl,
 *     redacted) thought for 107 s and left nothing but the prompt in `updates.jsonl` until it was cancelled;
 *   • the transcript is read correctly (the file's growth is seen by the watch, the steps come at each tool call) — there was
 *     simply no step to show, and the grouping makes a live group only from a step it can show.
 *
 * The fix is in the page: a turn that has not ended, while the agent is busy, with nothing to show yet, is an EMPTY live
 * group — the "Working…" line and its elapsed time. The counter-proofs: without `busy` nothing changes; an ended turn, an
 * older turn and a turn that wrote no prompt never get one.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LogService, type LogServiceDeps } from "../src/log-service.js";
import type { LogStep } from "../src/log-steps.js";
import { GrokStepParser } from "../src/log-steps-agy-grok.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";
// @ts-expect-error — a JS module of the app, with no types
import { groupSteps, composeRows } from "../src/ui/chat-activity-groups.js";

type Mod = any;
let thread: Mod, act: Mod, i18n: Mod;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  thread = await import("/ui/js/chat-thread.js");
  act = await import("/ui/js/chat-activity.js");
  await import("/ui/js/chat-strings.js");
  i18n = await import("/assets/app-i18n.js");
  base.restore();
});
let pg: AppPage | null = null;
const dirs: string[] = [];
afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = null; act.forgetActivity(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const FIX = join(import.meta.dirname, "fixtures", "chat-activity-3648");
/** The captured turn, line by line as grok wrote it: [0] the prompt, [1] the whole thought, [2] turn_completed (cancelled). */
const turn = readFileSync(join(FIX, "grok-thinking-only-turn.jsonl"), "utf8").split("\n").filter(Boolean);
const PROMPT_MS = 1794462778828;
const upd = (sessionUpdate: string, rest: Record<string, unknown> = {}, ms = PROMPT_MS, method = "session/update") =>
  JSON.stringify({ timestamp: Math.floor(ms / 1000), method, params: { sessionId: "s", update: { sessionUpdate, ...rest }, _meta: { agentTimestampMs: ms } } });
const stepsOf = (lines: string[], thinking = true): LogStep[] => { const p = new GrokStepParser({ thinking }); lines.forEach((l, i) => p.push(l, i * 1000)); return p.steps; };
const rowsOf = (...ids: string[]) => ids.map((id, i) => ({ role: "user", boot: "b", id, anchor: id, text: "redo it", ts: new Date(PROMPT_MS + i).toISOString() }));
const NOW = PROMPT_MS + 36_000;                      // the screenshot's "0:36"

describe("grok's file while it thinks (the captured turn)", () => {
  it("the prompt is the only record for the whole thought: one user step, nothing else to show", () => {
    const s = stepsOf(turn.slice(0, 1));
    expect(s.map((x) => x.kind)).toEqual(["user"]);
    expect(s[0]!.anchor!.messageId).toBe("web-fixture-220");
  });
  it("counter-proof — the old rule: without `busy`, that turn has no live group, so the chat shows no block at all", () => {
    const rows = rowsOf("web-fixture-220");
    const g = groupSteps(rows, stepsOf(turn.slice(0, 1)), { now: NOW, complete: true });
    expect(g.live).toBeNull();
    expect(g.groups).toEqual([]);
    expect(composeRows(rows, g).map((r: any) => r.role)).toEqual(["user"]);
  });
  it("busy: the same turn has an EMPTY live group — no steps, started at the prompt, not ended", () => {
    const rows = rowsOf("web-fixture-220");
    const g = groupSteps(rows, stepsOf(turn.slice(0, 1)), { now: NOW, complete: true, busy: true });
    expect(g.live).toMatchObject({ level: "live", ended: false, items: [], trailing: [], from: PROMPT_MS, to: 0, rowKey: null });
    expect(composeRows(rows, g).map((r: any) => r.role)).toEqual(["user", "activity"]);
  });
  it("the thought arriving (as one chunk, at its end) fills the SAME group — same key, so the node is kept; the turn ending closes it", () => {
    const rows = rowsOf("web-fixture-220");
    const empty = groupSteps(rows, stepsOf(turn.slice(0, 1)), { now: NOW, complete: true, busy: true }).live;
    const thinking = groupSteps(rows, stepsOf(turn.slice(0, 2)), { now: NOW, complete: true, busy: true }).live;
    expect(thinking.items.map((x: LogStep) => x.kind)).toEqual(["thinking"]);
    expect(thinking.key).toBe(empty.key);
    const ended = groupSteps(rows, stepsOf(turn), { now: NOW, complete: true, busy: true });
    expect(ended.live).toBeNull();                     // turn_completed: nothing is live, even if the page still thinks it is busy
    expect(ended.groups.map((x: any) => [x.level, x.ended])).toEqual([["none", true]]);
  });
  it("thinking hidden (the default for a guest, or web.log_thinking off): the turn still has its Working… line, not a block of nothing", () => {
    const rows = rowsOf("web-fixture-220");
    const g = groupSteps(rows, stepsOf(turn.slice(0, 1), false), { now: NOW, complete: true, busy: true });
    expect(g.live).not.toBeNull();
  });
});

describe("when it must NOT make a live group", () => {
  it("not busy (a turn that never wrote its end — a crash, an interrupt — is not a spinner on its own)", () => {
    expect(groupSteps(rowsOf("web-fixture-220"), stepsOf(turn.slice(0, 1)), { now: NOW, busy: false }).live).toBeNull();
  });
  it("the turn has ended", () => {
    expect(groupSteps(rowsOf("web-fixture-220"), stepsOf(turn), { now: NOW, busy: true }).live).toBeNull();
  });
  it("an older turn: only the newest can be live (the prompt of a later turn is the last)", () => {
    const first = [upd("user_message_chunk", { content: { type: "text", text: "one" } }, 1000), upd("turn_completed", { stop_reason: "end_turn" }, 2000, "_x.ai/session/update")];
    const second = [upd("user_message_chunk", { content: { type: "text", text: "two" }, _meta: { promptIndex: 1 } }, 3000)];
    const g = groupSteps([], stepsOf([...first, ...second]), { now: 5000, busy: true });
    expect(g.live).toMatchObject({ items: [], from: 3000 });
    expect(g.groups).toEqual([]);
  });
  it("no prompt seen (the window starts mid-turn, or the instance is busy with something the transcript has not recorded)", () => {
    expect(groupSteps([], [], { now: NOW, busy: true }).live).toBeNull();
  });
  it("a turn that already has steps is the same live group, only marked busy", () => {
    const lines = [turn[0]!, upd("tool_call", { toolCallId: "c1", title: "read_file", rawInput: { path: "a.txt" } }, PROMPT_MS + 4000)];
    const a = groupSteps(rowsOf("web-fixture-220"), stepsOf(lines), { now: NOW, busy: false }).live;
    const b = groupSteps(rowsOf("web-fixture-220"), stepsOf(lines), { now: NOW, busy: true }).live;
    expect(b).toEqual({ ...a, busy: true });                   // the one difference: it is marked busy (never hidden as empty)
    expect(b.items.map((x: LogStep) => x.kind)).toEqual(["tool"]);
  });
});

describe("the log service, reading the file as it grows (a real file, the captured lines appended one by one)", () => {
  const svc = (path: string, over: Partial<LogServiceDeps> = {}) => new LogService({ enabled: () => false, toolProgress: () => "verbose", thinking: () => true, known: () => true, source: () => ({ backend: "grok", path, format: "grok" }), events: () => [], emit: () => {}, ...over });
  it("after the prompt: the answer has the user step, a cursor and no more; each later record is read by the next `after=`", async () => {
    const d = mkdtempSync(join(tmpdir(), "agend-220-")); dirs.push(d);
    const file = join(d, "updates.jsonl");
    writeFileSync(file, turn[0] + "\n");
    const s = svc(file);
    const a: any = await s.steps("x", { chat: true, thinking: true, watch: true });
    expect(a.steps.map((x: LogStep) => x.kind)).toEqual(["user"]);
    expect(a.after).toBeGreaterThan(0);
    appendFileSync(file, turn[1] + "\n");
    const b: any = await s.steps("x", { chat: true, thinking: true, after: a.after, key: a.key });
    expect(b.steps.map((x: LogStep) => x.kind)).toEqual(["thinking"]);
    appendFileSync(file, turn[2] + "\n");
    const c: any = await s.steps("x", { chat: true, thinking: true, after: b.after, key: a.key });
    expect(c.steps.map((x: LogStep) => [x.kind, x.status])).toEqual([["turn_end", "interrupted"]]);
  });
});

describe("the page: the empty live group is a block, and it is replaced in place by the first step", () => {
  const mount = (ctx: () => Mod = () => ({ paths: null, thinking: true })) => {
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
  };
  const draw = (th: Mod, rows: Mod[], s: LogStep[], o: Record<string, unknown>) => th.render(composeRows(rows, groupSteps(rows, s, { now: NOW, complete: true, ...o })));
  const blocks = (list: Mod) => list.querySelectorAll(".activity-row");

  it("busy, the prompt only: one visible block — spinner, \"Working…\", the elapsed time — and the same node holds the thought when it lands", async () => {
    const { list, th } = mount();
    const rows = rowsOf("web-fixture-220");
    // The block counts with the page's own clock: the captured prompt, moved to 36 s ago.
    const at = (l: string, ms: number) => { const o = JSON.parse(l); o.params._meta.agentTimestampMs = ms; return JSON.stringify(o); };
    const started = Date.now() - 36_000;
    const lines = [at(turn[0]!, started), at(turn[1]!, started + 30_000)];
    draw(th, rows, stepsOf(lines.slice(0, 1)), { busy: true, now: Date.now() });
    await settle();
    expect(blocks(list)).toHaveLength(1);
    const node = blocks(list)[0];
    expect(node.hidden).not.toBe(true);
    expect(node.querySelector("details").classList.contains("live")).toBe(true);
    expect(node.querySelector(".act-title").textContent).toBe(i18n.t("act.working"));
    expect(node.querySelector(".act-meta").textContent).toMatch(/^3[6-9] s$/);           // the elapsed time, from the prompt
    expect(node.querySelector(".act-spin")).not.toBeNull();
    draw(th, rows, stepsOf(lines), { busy: true, now: Date.now() });
    await settle();
    expect(blocks(list)).toHaveLength(1);
    expect(blocks(list)[0]).toBe(node);                                                 // no remount
  });
  it("counter-proof: not busy, the same file draws no block (what the preview showed)", async () => {
    const { list, th } = mount();
    draw(th, rowsOf("web-fixture-220"), stepsOf(turn.slice(0, 1)), { busy: false });
    await settle();
    expect(blocks(list)).toHaveLength(0);
  });
  it("hiding: a live group the page knows is busy is never hidden as empty; without `busy` (or once ended) the old rule holds (AGEND-197: no step shown, no block)", () => {
    const only = [{ id: "t", kind: "thinking", body: "hmm", ts: 1 }];
    expect(act.isEmptyGroup({ ended: false, busy: true, items: [], trailing: [] }, { thinking: false })).toBe(false);
    expect(act.isEmptyGroup({ ended: false, busy: true, items: only, trailing: [] }, { thinking: false })).toBe(false);   // thinking hidden: the Working… line
    expect(act.isEmptyGroup({ ended: false, items: only, trailing: [] }, { thinking: false })).toBe(true);                // not busy: as before
    expect(act.isEmptyGroup({ ended: true, busy: true, items: [], trailing: [] }, { thinking: false })).toBe(true);
  });
});

describe("antigravity: the same, on its real capture (a record is written DONE when its step completes)", () => {
  const agyLines = readFileSync(join(FIX, "agy-web-chat.jsonl"), "utf8").split("\n").filter(Boolean);
  it("the prompt alone (step 0, before the first planner step is written) is one user step; busy: the empty live group; not busy: none", async () => {
    const d = mkdtempSync(join(tmpdir(), "agend-220-agy-")); dirs.push(d);
    const file = join(d, "transcript.jsonl");
    writeFileSync(file, agyLines[0] + "\n");
    const svc = new LogService({ enabled: () => false, toolProgress: () => "verbose", thinking: () => true, known: () => true, source: () => ({ backend: "antigravity", path: file, format: "antigravity" }), events: () => [], emit: () => {} });
    const a: any = await svc.steps("x", { chat: true, thinking: true });
    expect(a.steps.map((x: LogStep) => x.kind)).toEqual(["user"]);
    const rows = [{ role: "user", boot: "b", id: "u", anchor: a.steps[0].anchor.messageId, text: "x", ts: new Date(a.steps[0].ts).toISOString() }];
    expect(groupSteps(rows, a.steps, { now: a.steps[0].ts + 5000, complete: true, busy: false }).live).toBeNull();
    expect(groupSteps(rows, a.steps, { now: a.steps[0].ts + 5000, complete: true, busy: true }).live).toMatchObject({ items: [], ended: false, busy: true });
  });
});
