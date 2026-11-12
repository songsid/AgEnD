/**
 * The turn in progress has a live line from the moment the agent is working — not from its first
 * step. The preview's report, for Claude Code (haiku, effort max, "test is working… 0:11", the pane at "Crystallizing…
 * (44s · thinking some more with max effort)") and for grok alike: the chat showed NO block while the agent thought.
 *
 * Measured on the preview's own transcript (tests/fixtures/chat-activity-3648/claude-thinking-gap.jsonl: its two prompt
 * records, redacted, with their real timestamps): the first prompt was written 05:57:12.888 and the next one 06:00:25.226 —
 * 192 s with NOT ONE assistant record between them, though the agent was thinking the whole time. Claude Code writes a
 * message's blocks (thinking, then its tool calls: stamped 2 ms apart in the same transcript) when the message completes,
 * and grok's updates.jsonl writes a thought as one record when the thought ends (see the grok transcript
 * parser in #3710). So for as long as a thought lasts there is no step, and the grouping only made a live group from a step.
 *
 * The page knows the agent is working (the chat's own busy state, the one behind "test is working… 0:11"): then the turn
 * that has not ended has an EMPTY live group — "Working…" and its elapsed time, nothing read from the pane or guessed — and
 * the first step fills the same node. Counter-proofs: not busy, ended, an older turn, no prompt: no group, as before.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClaudeStepParser, type LogStep } from "../src/log-steps.js";
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
afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = null; act.forgetActivity(); });
void h;

const FIX = join(import.meta.dirname, "fixtures", "chat-activity-3648");
const gap = readFileSync(join(FIX, "claude-thinking-gap.jsonl"), "utf8").split("\n").filter(Boolean);
const T1 = Date.parse("2026-11-12T05:57:12.888Z"), T2 = Date.parse("2026-11-12T06:00:25.226Z");
const stepsOf = (lines: string[], thinking = true): LogStep[] => { const p = new ClaudeStepParser({ thinking }); lines.forEach((l, i) => p.push(l, i * 1000)); return p.steps; };
const userRow = (id: string, ts: number) => ({ role: "user", boot: "b", id, anchor: id, text: "x", ts: new Date(ts).toISOString() });
const NOW = T1 + 36_000;
const assistant = (ms: number, block: Record<string, unknown>) => JSON.stringify({ type: "assistant", uuid: `a${ms}`, timestamp: new Date(ms).toISOString(), message: { role: "assistant", content: [block] } });

describe("Claude Code's transcript while it thinks (the captured turn)", () => {
  it("the real gap: two prompts 192 s apart and no assistant record between them", () => {
    expect(T2 - T1).toBe(192_338);
    const s = stepsOf(gap);
    expect(s.map((x) => x.kind)).toEqual(["user", "user"]);                 // not one step to show for the whole turn
    expect(s.map((x) => x.anchor!.messageId)).toEqual(["web-fixture-220-1", "web-fixture-220-2"]);
  });
  it("counter-proof — the old rule: without `busy` the turn has no live group, so the chat shows no block at all", () => {
    const rows = [userRow("web-fixture-220-1", T1)];
    const g = groupSteps(rows, stepsOf(gap.slice(0, 1)), { now: NOW, complete: true });
    expect(g.live).toBeNull();
    expect(composeRows(rows, g).map((r: any) => r.role)).toEqual(["user"]);
  });
  it("busy: an EMPTY live group — no steps, started at the prompt, not ended, shown even with thinking hidden", () => {
    const rows = [userRow("web-fixture-220-1", T1)];
    const g = groupSteps(rows, stepsOf(gap.slice(0, 1)), { now: NOW, complete: true, busy: true });
    expect(g.live).toMatchObject({ level: "live", ended: false, busy: true, items: [], trailing: [], from: T1, to: 0, rowKey: null });
    expect(composeRows(rows, g).map((r: any) => r.role)).toEqual(["user", "activity"]);
  });
  it("a thought that ends fills the SAME group (same key: the node is kept); the reply row ends it", () => {
    const rows = [userRow("web-fixture-220-1", T1)];
    const empty = groupSteps(rows, stepsOf(gap.slice(0, 1)), { now: NOW, complete: true, busy: true }).live;
    const thought = [gap[0]!, assistant(T1 + 30_000, { type: "thinking", thinking: "Worked it out." })];
    const filled = groupSteps(rows, stepsOf(thought), { now: NOW, complete: true, busy: true }).live;
    expect(filled.items.map((x: LogStep) => x.kind)).toEqual(["thinking"]);
    expect(filled.key).toBe(empty.key);
  });
  it("the next prompt makes the turn before it an older one: only the newest turn is live", () => {
    const rows = [userRow("web-fixture-220-1", T1), userRow("web-fixture-220-2", T2)];
    const g = groupSteps(rows, stepsOf(gap), { now: T2 + 5000, complete: true, busy: true });
    expect(g.live).toMatchObject({ items: [], from: T2 });
    expect(g.groups).toEqual([]);                                           // the first turn left no step, so no group of nothing
  });
});

describe("when it must NOT make a live group", () => {
  const rows = [userRow("web-fixture-220-1", T1)];
  it("not busy — a turn that never wrote its end (a crash, an interrupt) is not a spinner on its own", () => {
    expect(groupSteps(rows, stepsOf(gap.slice(0, 1)), { now: NOW, busy: false }).live).toBeNull();
  });
  it("the turn has ended (turn_duration)", () => {
    const ended = [gap[0]!, assistant(T1 + 5000, { type: "text", text: "done" }), JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 5000, timestamp: new Date(T1 + 5100).toISOString() })];
    expect(groupSteps(rows, stepsOf(ended), { now: NOW, busy: true }).live).toBeNull();
  });
  it("no prompt seen (the window starts mid-turn, or nothing is written yet)", () => {
    expect(groupSteps([], [], { now: NOW, busy: true }).live).toBeNull();
  });
  it("a turn that already has a step is the same live group, only marked busy", () => {
    const lines = [gap[0]!, assistant(T1 + 4000, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } })];
    const a = groupSteps(rows, stepsOf(lines), { now: NOW, busy: false }).live;
    const b = groupSteps(rows, stepsOf(lines), { now: NOW, busy: true }).live;
    expect(b).toEqual({ ...a, busy: true });
    expect(b.items.map((x: LogStep) => x.kind)).toEqual(["tool"]);
  });
});

describe("the page", () => {
  const mount = () => {
    pg = page({ storage: { agend_tour_done: "1" } });
    const doc = pg.document as any;
    const scroller = doc.createElement("div"), list = doc.createElement("div");
    scroller.append(list); doc.body.append(scroller);
    const th = thread.createThread(list, scroller, {
      t: (k: string) => i18n.t(k), tf: (k: string, ...a: unknown[]) => i18n.t(k, ...a), isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {},
      setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
      activity: { mount: (node: unknown, g: unknown) => act.mountActivity(node, g, () => ({ paths: null, thinking: true })) },
    });
    return { list, th };
  };
  const blocks = (list: Mod) => [...list.querySelectorAll(".activity-row")].filter((n: any) => !n.hidden);
  const at = (ms: number) => JSON.stringify({ ...JSON.parse(gap[0]!), timestamp: new Date(ms).toISOString() });

  it("busy, the prompt only: one visible block — spinner, \"Working…\", the elapsed time; the first step lands in the SAME node", async () => {
    const { list, th } = mount();
    const started = Date.now() - 36_000;                                   // the block counts with the page's own clock
    const rows = [userRow("web-fixture-220-1", started)];
    const draw = (lines: string[]) => th.render(composeRows(rows, groupSteps(rows, stepsOf(lines), { now: Date.now(), complete: true, busy: true })));
    draw([at(started)]);
    await settle();
    expect(blocks(list)).toHaveLength(1);
    const node = blocks(list)[0];
    expect(node.querySelector("details").classList.contains("live")).toBe(true);
    expect(node.querySelector(".act-title").textContent).toBe(i18n.t("act.working"));
    expect(node.querySelector(".act-meta").textContent).toMatch(/^3[6-9] s$/);
    expect(node.querySelector(".act-spin")).not.toBeNull();
    draw([at(started), assistant(started + 30_000, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } })]);
    await settle();
    expect(blocks(list)).toHaveLength(1);
    expect(blocks(list)[0]).toBe(node);                                    // no remount
  });
  it("counter-proof: not busy, the same file draws no block (what the preview showed)", async () => {
    const { list, th } = mount();
    const rows = [userRow("web-fixture-220-1", T1)];
    th.render(composeRows(rows, groupSteps(rows, stepsOf(gap.slice(0, 1)), { now: NOW, complete: true, busy: false })));
    await settle();
    expect(blocks(list)).toHaveLength(0);
  });
  it("hiding: a live group the page knows is busy is never hidden as empty; without `busy`, or once ended, the earlier rule holds (no step shown, no block)", () => {
    const only = [{ id: "t", kind: "thinking", body: "hmm", ts: 1 }];
    expect(act.isEmptyGroup({ ended: false, busy: true, items: [], trailing: [] }, { thinking: false })).toBe(false);
    expect(act.isEmptyGroup({ ended: false, busy: true, items: only, trailing: [] }, { thinking: false })).toBe(false);
    expect(act.isEmptyGroup({ ended: false, items: only, trailing: [] }, { thinking: false })).toBe(true);
    expect(act.isEmptyGroup({ ended: true, busy: true, items: [], trailing: [] }, { thinking: false })).toBe(true);
  });
  it("a long silence says so: the newest step is 40 s old and nothing is running → \"no new record for 40 s\"; a running call does not say it", async () => {
    const { list, th } = mount();
    const started = Date.now() - 60_000;
    const rows = [userRow("web-fixture-220-1", started)];
    const call = (status: "done" | "running", ms: number) => {
      const lines = [at(started), assistant(ms, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } })];
      if (status === "done") lines.push(JSON.stringify({ type: "user", uuid: "r1", timestamp: new Date(ms + 100).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }));
      return lines;
    };
    const draw = (lines: string[]) => th.render(composeRows(rows, groupSteps(rows, stepsOf(lines), { now: Date.now(), complete: true, busy: true })));
    draw(call("done", started + 20_000));
    await settle();
    expect(blocks(list)[0].querySelector(".act-meta").textContent).toMatch(/no new record for 4\d s/);
    draw(call("running", started + 20_000));
    await settle();
    expect(blocks(list)[0].querySelector(".act-meta").textContent).not.toContain("no new record");
    draw(call("done", Date.now() - 5000));
    await settle();
    expect(blocks(list)[0].querySelector(".act-meta").textContent).not.toContain("no new record");
  });
});
