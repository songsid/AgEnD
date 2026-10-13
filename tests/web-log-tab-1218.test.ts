/**
 * #1218 phase 1: the instance Log tab (/ui/log/<name>) — between View and Details in the instance switch; off by
 * default (an explanation and Turn on, never over the public link); on: the newest steps, live by the stream's
 * steps_tick (a read after the page's cursor, merged by id), older steps on demand, a filter, outputs on demand.
 * The real Shell, router, store and panel in the mini DOM; fetch is a fake that records what is asked.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
let calls: string[] = [];
let puts: Array<{ url: string; body: unknown }> = [];
/** Answers for /ui/steps, in order (the last one repeats). */
let answers: unknown[] = [];
const live = (name: string, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", model: "opus", context_pct: 10, tags: [], execution_state: "idle", ...o });
const INSTANCES = [live("web-dev"), live("api-server", { backend: "grok" })];
const ON = (o: Record<string, unknown> = {}) => ({ enabled: true, instance: "web-dev", backend: "claude-code", supported: true, key: "1-2", steps: [], events: [], before: null, after: 100, ev: 0, ...o });
const step = (id: string, o: Record<string, unknown>) => ({ id, turn: "t1", ts: Date.parse("2026-10-13T08:00:00Z"), ...o });

async function fakeFetch(url: string, init: { method?: string; body?: string } = {}) {
  const m = init.method || "GET";
  calls.push(`${m} ${url}`);
  if (url.startsWith("/ui/steps")) {
    const a = answers.length > 1 ? answers.shift() : answers[0];
    return { ok: true, status: 200, json: async () => structuredClone(a), text: async () => JSON.stringify(a) };
  }
  if (m === "PUT" && url === "/api/settings/fleet/web") {
    puts.push({ url, body: JSON.parse(String(init.body)) });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
}

let logp: any, appStore: any;
const ticks = new Set<(d: unknown) => void>();
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  logp = await import("../src/ui/panel-log.js");
  ({ appStore } = await import("/assets/app-store.js"));
  base.restore();
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  calls = []; puts = []; answers = []; ticks.clear();
});

const PANELS = () => new Map([
  ["log", { load: async () => logp.LogPanel }],
  ["chat", { Component: () => h("div", { class: "stub-chat" }, "chat") }], ["view", { Component: () => h("div", { class: "stub-view" }, "view") }],
  ["details", { Component: () => h("div", { class: "stub-details" }, "details") }], ["fleet", { Component: () => h("div", {}, "fleet") }],
  ["settings", { Component: () => h("div", {}, "settings") }], ["needs", { Component: () => h("div", {}, "needs") }],
]);
async function app(path: string, body: Record<string, string> = {}) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  for (const [k, v] of Object.entries(body)) (pg.document as any).body.dataset[k] = v;
  (globalThis as any).fetch = fakeFetch;
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: INSTANCES });
  appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { if (name !== "steps_tick") return () => {}; ticks.add(fn); return () => ticks.delete(fn); } });
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return pg;
}
const tick = async (instance = "web-dev") => { for (const fn of [...ticks]) fn({ instance }); await settle(8); };
/** Each row's head as words: its parts (icon, label, subject, status…) joined by a space, the time left out. */
const rows = (pg: AppPage): string[] => pg.root.querySelectorAll(".p-log .log-item").map((li: any) => {
  const parts: string[] = [];
  const walk = (n: any) => { for (const c of n.children ?? []) {
    if (c.classList?.contains("log-time")) continue;
    if (c.children?.length && !c.classList?.contains("log-status")) walk(c); else if (c.textContent.trim()) parts.push(c.textContent.trim());
  } };
  walk(li.querySelector(".log-head"));
  return parts.join(" ");
});
const stepsCalls = () => calls.filter(c => c.includes("/ui/steps")).map(c => c.replace("GET /ui/steps?", ""));

describe("the instance switch: Chat · View · Log · Details", () => {
  it("Log between View and Details, a link for the same instance, current on its page", async () => {
    answers = [ON()];
    const pg = await app("/ui/log/web-dev");
    expect(pg.root.querySelectorAll(".inst-switch a.seg-item").map((a: any) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current") ?? null]))
      .toEqual([["Chat", "/ui/chat/web-dev", null], ["View", "/view/web-dev", null], ["Log", "/ui/log/web-dev", "page"], ["Details", "/ui/fleet/agent/web-dev", null]]);
    // A row in the sidebar opens that instance's Log (Log → Log).
    expect(pg.root.querySelectorAll("#instanceList a.inst").map((a: any) => a.getAttribute("href"))).toContain("/ui/log/api-server");
  });
});

describe("off by default", () => {
  it("off: what it is and Turn on; turning it on is the Settings write (log_tab: true), then the steps are read", async () => {
    answers = [{ enabled: false }, ON({ steps: [step("o1.0", { kind: "user", body: "hello" })] })];
    const pg = await app("/ui/log/web-dev");
    expect(pg.root.querySelector(".p-log .log-off")?.textContent).toContain("The Log is off");
    const btn = pg.root.querySelector(".p-log .log-enable") as any;
    expect(btn.textContent).toBe("Turn on the Log");
    btn.click(); await settle(10);
    expect(puts).toEqual([{ url: "/api/settings/fleet/web", body: { log_tab: true } }]);
    expect(rows(pg)).toEqual([expect.stringContaining("Asked")]);
  });
  it("over the public link: no Turn on (Settings cannot be written there) — where it can be turned on is said instead", async () => {
    answers = [{ enabled: false }];
    const pg = await app("/ui/log/web-dev", { publicLink: "1" });
    expect(pg.root.querySelector(".p-log .log-enable")).toBeNull();
    expect(pg.root.querySelector(".p-log .log-off")?.textContent).toContain("Settings → Web");
  });
});

describe("on: the newest steps, live, older on demand", () => {
  const WINDOW = ON({
    steps: [
      step("o1.0", { kind: "user", body: "fix the build" }),
      step("o2.0", { kind: "assistant", body: "Looking." }),
      step("toolu_1", { kind: "tool", tool: "Bash", cat: "run", subject: "npm test", status: "failed", exitCode: 1, durationMs: 4200, body: "1 failed", input: '{ "command": "npm test" }' }),
      step("toolu_2", { kind: "tool", tool: "Read", cat: "read", subject: "src/a.ts", status: "running" }),
    ],
    events: [{ id: 5, ts: Date.parse("2026-10-13T07:59:00Z"), type: "crash_respawn" }],
    before: 50,
  });

  it("the window: events by time among the steps, a tool's category, subject and status; its output on demand", async () => {
    answers = [WINDOW];
    const pg = await app("/ui/log/web-dev");
    expect(stepsCalls()).toEqual(["instance=web-dev&watch=1"]);
    expect(rows(pg)).toEqual([
      "Crashed and restarted", "Asked", "Replied", "Run npm test failed · exit 1 · 4.2 s", "Read src/a.ts running",
    ]);
    // Each row's icon is the app's SVG (never an emoji: a device without an emoji font draws boxes).
    expect(pg.root.querySelectorAll(".p-log .log-icon").map((i: any) => !!i.querySelector("svg"))).toEqual([true, true, true, true, true]);
    expect(pg.root.querySelector(".p-log .log-detail")).toBeNull();
    (pg.root.querySelector(".p-log .log-item.s-failed .log-toggle") as any).click(); await settle(4);
    expect(pg.root.querySelector(".p-log .log-detail")?.textContent).toContain("1 failed");
    expect(pg.root.querySelector(".p-log .log-detail")?.textContent).toContain('"command": "npm test"');
  });

  it("a steps_tick for this instance reads after the cursor: a running call is completed in place; another instance's tick reads nothing", async () => {
    answers = [WINDOW, ON({ steps: [step("toolu_2", { kind: "tool", tool: "Read", cat: "read", subject: "src/a.ts", status: "done", durationMs: 30 }), step("o9.0", { kind: "assistant", body: "Done." })], after: 180 })];
    const pg = await app("/ui/log/web-dev");
    await tick("api-server");
    expect(stepsCalls()).toHaveLength(1);
    await tick("web-dev");
    expect(stepsCalls()[1]).toBe("instance=web-dev&watch=1&ev=0&after=100&key=1-2");
    const r = rows(pg);
    expect(r.slice(-2)).toEqual(["Read src/a.ts done · 30 ms", "Replied"]);
    expect(r.filter(x => x.startsWith("Read"))).toHaveLength(1);
  });

  it("Load older: before the oldest offset, put above what is shown", async () => {
    answers = [WINDOW, ON({ steps: [step("o0.0", { kind: "user", body: "earlier" })], before: null, after: null })];
    const pg = await app("/ui/log/web-dev");
    (pg.root.querySelector(".p-log .log-older button") as any).click(); await settle(8);
    expect(stepsCalls()[1]).toBe("instance=web-dev&before=50&key=1-2");
    expect(pg.root.querySelectorAll(".p-log .log-item.k-user")[0].textContent).toContain("earlier");
    expect(pg.root.querySelector(".p-log .log-older")).toBeNull();
    expect(pg.root.querySelector(".p-log .log-start")?.textContent).toBe("The start of what can be read.");
  });

  it("the filter: Tools (tool calls only), Errors (failed or interrupted steps, errors, fleet events)", async () => {
    answers = [WINDOW];
    const pg = await app("/ui/log/web-dev");
    const choose = async (label: string) => { (pg.root.querySelectorAll(".p-log .log-bar .chip-btn").find((b: any) => b.textContent === label) as any).click(); await settle(4); };
    await choose("Tools");
    expect(rows(pg).map(x => x.split(" ")[0])).toEqual(["Run", "Read"]);
    await choose("Errors");
    expect(rows(pg).map(x => x.split(" ")[0])).toEqual(["Crashed", "Run"]);
  });

  it("a new conversation (reset) is said; a backend with no transcript says what it shows instead", async () => {
    answers = [WINDOW, ON({ steps: [step("o1.0", { kind: "user", body: "new" })], reset: true, key: "3-4", after: 10 })];
    const pg = await app("/ui/log/web-dev");
    await tick();
    expect(pg.root.querySelector(".p-log .log-notice")?.textContent).toBe("A new conversation began: showing it from its latest steps.");
    expect(rows(pg)).toHaveLength(1);
    // Another page load (the old page gone first: one page at a time, as a browser has).
    await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1);
    answers = [ON({ instance: "api-server", backend: "grok", supported: false, reason: "unsupported", after: null, key: undefined })];
    const pg2 = await app("/ui/log/api-server");
    expect(pg2.root.querySelector(".p-log .log-why")?.textContent).toContain("grok has no transcript AgEnD can read");
  });
});

describe("the page's helpers", () => {
  it("mergeSteps: an update replaces in place; new steps go after (or before, for an older page, which never overwrites)", () => {
    const a = [{ id: "1", v: 1 }, { id: "2", v: 1 }];
    expect(logp.mergeSteps(a, [{ id: "2", v: 2 }, { id: "3", v: 1 }])).toEqual([{ id: "1", v: 1 }, { id: "2", v: 2 }, { id: "3", v: 1 }]);
    expect(logp.mergeSteps(a, [{ id: "0", v: 1 }, { id: "1", v: 9 }], true)).toEqual([{ id: "0", v: 1 }, { id: "1", v: 1 }, { id: "2", v: 1 }]);
    // A result whose call was on the older page: the call names it (tool, subject, input, start time); its outcome stays.
    const orphan = { id: "c", kind: "tool", tool: "", cat: "other", status: "done", body: "ok", ts: 20 };
    const call = { id: "c", kind: "tool", tool: "Bash", cat: "run", subject: "ls", input: "{}", status: "running", ts: 10 };
    expect(logp.mergeSteps([orphan], [call], true)).toEqual([{ id: "c", kind: "tool", tool: "Bash", cat: "run", subject: "ls", input: "{}", status: "done", body: "ok", ts: 10 }]);
    // …and the other way round: a live read that saw only the result completes the named call without unnaming it.
    const running = { ...call, status: "running" };
    expect(logp.mergeSteps([running], [orphan])).toEqual([{ id: "c", kind: "tool", tool: "Bash", cat: "run", subject: "ls", input: "{}", status: "done", body: "ok", ts: 10 }]);
    expect(logp.mergeSteps([running], [{ ...orphan, tool: "Bash2", cat: "edit" }])[0]).toMatchObject({ tool: "Bash2", cat: "edit", ts: 20 });
    const named = { ...orphan, tool: "Read", cat: "read", subject: "a.ts" };
    expect(logp.mergeSteps([named], [call], true)).toEqual([named]);
  });
  it("timeline: events placed by time among the steps; collapse: repeated identical finished tool steps as one, with a count", () => {
    const steps = [{ id: "a", ts: 10, kind: "user" }, { id: "b", ts: 30, kind: "user" }];
    expect(logp.timeline(steps, [{ id: 1, ts: 20, type: "x" }, { id: 2, ts: 40, type: "y" }]).map((x: any) => x.id)).toEqual(["a", 1, "b", 2]);
    const t = (id: string, status = "done") => ({ id, kind: "tool", tool: "Bash", subject: "git push", status, turn: "t" });
    expect(logp.collapse([t("1"), t("2"), t("3"), t("4", "running"), t("5", "failed")]).map((x: any) => [x.id, x.repeat ?? 1])).toEqual([["1", 3], ["4", 1], ["5", 1]]);
  });
});
