/**
 * AGEND-181 PR1, through the real chat panel: with the Log on, the chat reads the instance's steps (GET /ui/steps) and
 * draws each turn above its reply; steps_tick makes the turn in progress grow; this browser's Show activity switch ends it
 * (and its reads); a chat shown again draws from memory at once; with the Log off nothing is asked and nothing drawn.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";
import { ClaudeStepParser } from "../src/log-steps.js";

const ORIGIN = "http://127.0.0.1:19280";
let panel: any, act: any, appStore: any;
let current: AppPage | null = null;
const ticks = new Set<(d: unknown) => void>();
const FIX = join(import.meta.dirname, "fixtures", "chat-activity-3648");
const ledger = (JSON.parse(readFileSync(join(FIX, "claude-web-chat.ledger.json"), "utf8")) as Array<Record<string, any>>).map((r) => ({ ...r, instance: "w", ...(r.role === "agent" ? { sender: "w" } : {}) }));
const records = readFileSync(join(FIX, "claude-web-chat.jsonl"), "utf8").split("\n").filter(Boolean);
const stepsOf = (n = records.length) => { const p = new ClaudeStepParser({ thinking: true }); records.slice(0, n).forEach((r, i) => p.push(r, i * 1000)); return p.steps; };
const replyAt = records.findIndex((r) => r.includes("I looked at the fleet"));

beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  // @ts-expect-error — a JS module of the app, with no types
  panel = await import("../src/ui/panel-chat.js");
  act = await import("/ui/js/chat-activity.js");
  ({ appStore } = await import("/assets/app-store.js"));
  panel.boot({ stream: { on() {} }, boot: {}, deps: { fetch: () => new Promise(() => {}) } });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running", backend: "claude-code" }, { name: "x", status: "running" }],
    streamOn: (n: string, fn: (d: unknown) => void) => { if (n === "steps_tick") ticks.add(fn); return () => ticks.delete(fn); } });
  let clock = 0; panel.setThreadClock(() => (clock += 5000));
  base.restore();
});
afterEach(async () => {
  await current?.unmount();
  panel.forgetKeptThreads(); act.forgetActivity(); act.setActivityOn(true); act.setActivityThinking(true);
  panel.store.state.msgs.w = []; panel.store.state.msgs.x = []; ticks.clear();
  current?.restore(); current = null;
});

let asked: string[] = [];
/** /ui/steps answers `next()` each time; everything else never answers. */
function steps(next: () => Record<string, unknown>) {
  asked = [];
  globalThis.fetch = vi.fn((url: string) => {
    if (!url.startsWith("/ui/steps")) return new Promise(() => {});
    asked.push(url);
    return Promise.resolve({ ok: true, status: 200, json: async () => structuredClone(next()) });
  }) as any;
}
const answer = (n: number, o: Record<string, unknown> = {}) => ({ enabled: true, instance: "w", backend: "claude-code", supported: true, thinking: true, cwd: "/srv/w", home: "/home/me", key: "1-1", steps: stepsOf(n), events: [], before: null, after: n * 1000, ev: 0, ...o });
async function open(body: Record<string, string> = { logTab: "1", logThinking: "1" }) {
  current = page({ url: `${ORIGIN}/ui/chat/w`, storage: { agend_tour_done: "1" } });
  for (const [k, v] of Object.entries(body)) (current.document as any).body.dataset[k] = v;
  panel.store.state.msgs.w = ledger.map((r) => ({ ...r }));
  panel.store.state.msgs.x = [];
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  await settle(); await settle();
  return current.document as any;
}
const rowsOf = (doc: any) => [...doc.querySelector(".thread").children].map((c: any) => (c.classList.contains("activity-row") ? "activity" : c.classList.contains("user") ? "user" : "agent"));

describe("the chat with the Log on", () => {
  it("reads the instance's steps and draws each turn above its reply", async () => {
    steps(() => answer(records.length));
    const doc = await open();
    expect(asked[0]).toBe("/ui/steps?instance=w&watch=1&thinking=1");
    expect(rowsOf(doc)).toEqual(["user", "activity", "agent", "user", "activity", "agent"]);
  });
  it("a turn in progress grows at the end on steps_tick and becomes its reply's block, in the same node", async () => {
    let n = replyAt - 3;
    steps(() => answer(n, { steps: stepsOf(n) }));
    const doc = await open();
    const live = doc.querySelector(".thread").lastChild;
    expect(live.classList.contains("activity-row")).toBe(true);
    const before = live.querySelectorAll(".log-item").length;
    n = replyAt + 1;                                                       // the rest of the turn is written
    panel.store.state.msgs.w = ledger.map((r) => ({ ...r }));
    for (const fn of [...ticks]) fn({ instance: "w" });
    await settle(); await settle();
    expect(asked[1]).toContain("after=");
    expect(rowsOf(doc)).toEqual(["user", "activity", "agent", "user", "activity", "agent"]);
    const nodes = doc.querySelectorAll(".activity-row");
    expect(nodes[1]).toBe(live);                                           // not remounted
    expect(before).toBeGreaterThanOrEqual(0);
  });
  it("Show activity off: the blocks go and no further read is made; on again: they come back", async () => {
    steps(() => answer(records.length));
    const doc = await open();
    expect(doc.querySelectorAll(".activity-row")).toHaveLength(2);
    act.setActivityOn(false);
    await settle();
    expect(doc.querySelectorAll(".activity-row")).toHaveLength(0);
    const n = asked.length;
    for (const fn of [...ticks]) fn({ instance: "w" });
    await settle();
    expect(asked.length).toBe(n);
    act.setActivityOn(true);
    await settle(); await settle();
    expect(doc.querySelectorAll(".activity-row")).toHaveLength(2);
  });
  it("shown again after another chat: drawn at once from what the page knew", async () => {
    steps(() => answer(records.length));
    const doc = await open();
    await current!.mount(h(panel.ChatPanel, { route: { instance: "x" }, navKey: "two" })); await settle();
    steps(() => new Promise(() => {}) as never);                           // the next read never answers
    await current!.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "three" })); await settle();
    expect(doc.querySelectorAll(".activity-row")).toHaveLength(2);
  });
  it("the ⋯ menu offers Show activity, and Show thinking once the server says it sends thinking; each is this browser's choice", async () => {
    steps(() => answer(records.length));
    const doc = await open();
    const menu = async () => {
      const btn = [...doc.querySelectorAll("button")].find((b: any) => b.getAttribute("aria-label") === "More actions");
      btn.click(); await settle();
      const items = [...doc.querySelectorAll(".menu-list button[role^='menuitem']")];
      return items;
    };
    const items = await menu();
    const text = items.map((i: any) => i.textContent.trim());
    expect(text).toContain("Show activity");
    expect(text).toContain("Show thinking");
    items.find((i: any) => i.textContent.trim() === "Show thinking").click();
    await settle();
    expect(act.activityPrefs.get().thinking).toBe(false);
    expect(doc.querySelectorAll(".act-block .k-thinking")).toHaveLength(0);
  });
});

describe("the chat with the Log off", () => {
  it("asks nothing and draws nothing", async () => {
    steps(() => answer(records.length));
    const doc = await open({ logTab: "0" });
    expect(asked).toEqual([]);
    expect(doc.querySelectorAll(".activity-row")).toHaveLength(0);
    expect(rowsOf(doc)).toEqual(["user", "agent", "user", "agent"]);
  });
});
