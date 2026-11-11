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
async function open(body: Record<string, string> = { chatActivity: "1", logThinking: "1" }) {
  current = page({ url: `${ORIGIN}/ui/chat/w`, storage: { agend_tour_done: "1" } });
  for (const [k, v] of Object.entries(body)) (current.document as any).body.dataset[k] = v;
  panel.store.state.msgs.w = ledger.map((r) => ({ ...r }));
  panel.store.state.msgs.x = [];
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  await settle(); await settle();
  return current.document as any;
}
const rowsOf = (doc: any) => [...doc.querySelector(".thread").children].map((c: any) => (c.classList.contains("activity-row") ? "activity" : c.classList.contains("user") ? "user" : "agent"));

describe("the chat for an admin session", () => {
  it("reads the instance's steps and draws each turn above its reply", async () => {
    steps(() => answer(records.length));
    const doc = await open();
    expect(asked[0]).toBe("/ui/steps?instance=w&chat=1&watch=1&thinking=1");
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

describe("the chat for anyone but an admin session on the local dashboard (AGEND-197)", () => {
  it("asks nothing and draws nothing — a guest, the public link and a read-only session are never offered the block", async () => {
    steps(() => answer(records.length));
    for (const body of [{ chatActivity: "0" }, { logTab: "1" }, {}] as Array<Record<string, string>>) {
      const doc = await open(body);
      expect(asked, JSON.stringify(body)).toEqual([]);
      expect(doc.querySelectorAll(".activity-row")).toHaveLength(0);
      await current!.unmount(); current!.restore(); current = null;
      panel.forgetKeptThreads(); act.forgetActivity();
    }
  });
});

describe("live without a stream tick (AGEND-197): the steps do not wait for the reply", () => {
  it("a message arriving makes the chat read the steps at once (a sent message opens the watch; a reply catches the steps up)", async () => {
    steps(() => answer(records.length));
    await open();
    const n = asked.length;
    panel.store.ingest({ instance: "w", boot: "a1b2", id: 99, role: "user", sender: "web-user", text: "next", ts: new Date().toISOString() });
    await settle(); await settle();
    expect(asked.length).toBe(n + 1);
    expect(asked.at(-1)).toContain("after=");
  });
  it("the stream fell back to polling (appStore.connection is polling: steps_tick does not travel): the chat polls the steps itself", async () => {
    const polls: Array<() => void> = [];
    const real = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === act.POLL_MS) { polls.push(fn); return 0 as never; }
      return (real as any)(fn, ms, ...rest);
    }) as never);
    try {
      steps(() => answer(records.length));
      appStore.set({ connection: "live" });
      await open();
      expect(polls.length).toBeGreaterThan(0);
      const live = asked.length;
      for (const p of polls) p(); await settle();
      expect(asked.length).toBe(live);                       // a live stream: the poll does nothing
      appStore.set({ connection: "polling" });
      for (const p of polls) p(); await settle(); await settle();
      expect(asked.length).toBeGreaterThan(live);
      expect(asked.at(-1)).toContain("after=");
    } finally { spy.mockRestore(); appStore.set({ connection: "none" }); }
  });
  it("the agent's tool_progress is off: the answer says level off — nothing is drawn, and the ⋯ menu does not offer Show activity", async () => {
    steps(() => ({ enabled: true, instance: "w", backend: "claude-code", supported: true, level: "off", thinking: false, steps: [], events: [], before: null, after: null, ev: 0 }));
    const doc = await open();
    expect(doc.querySelectorAll(".activity-row")).toHaveLength(0);
    const btn = [...doc.querySelectorAll("button")].find((b: any) => b.getAttribute("aria-label") === "More actions");
    btn.click(); await settle();
    const text = [...doc.querySelectorAll(".menu-list button[role^='menuitem']")].map((i: any) => i.textContent.trim());
    expect(text).not.toContain("Show activity");
    expect(text).not.toContain("Show thinking");
  });
});
