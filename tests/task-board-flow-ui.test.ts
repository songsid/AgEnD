/**
 * A main task says what its sub tasks' agents are really doing, and how the baton passes (docs/design/task-board.md, "Live state and
 * handoffs"; fleet-task-flow.js):
 *
 *   1. What a line says (pure): a sub task being worked on, busy with several cards, waiting for the person, looking stuck, idle, blocked;
 *      waiting for another; ready and handed on — sending, taken, read, offline, paused, failed, not sent (and why); the summary the main task's
 *      block lists; a handoff as the activity stream says it; the step line of the chat's own feed.
 *   2. The main task's page: the title of the sub task that runs shimmers (its tooltip says what the agent is doing — the state alone when steps are
 *      not offered, tool progress is off, or the viewer is not an admin), the "Agent activity" block lists the same with a turning ring, and "Running" sits
 *      beside the status; the board's tile says it too. Waiting, handed on, read, offline, failed, blocked, idle — each a short label in its row.
 *   3. The activity: the sub tasks' moves, and each handoff as a row that is not folded away; none for a session that cannot write.
 *   4. Live: the stream's ping reads the card again, a notice on its way is read again by itself, steps move as the feed does.
 *   5. Both languages; the sub task's own page says where its hand-over stands.
 *
 * The page is the real Tasks tab in tests/helpers/mini-dom.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeStepParser, type LogStep } from "../src/log-steps.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let p: AppPage;
let app: any, nav: any, fleet: any, flow: any, run: any, act: any, activity: any, i18n: any;
const calls: Array<{ method: string; path: string }> = [];
const handlers: Record<string, Array<(d: unknown) => void>> = {};
const emit = (name: string, data: unknown) => { for (const fn of handlers[name] ?? []) fn(data); };
let CARDS: any[] = [];
let DETAILS: Record<string, any> = {};
let steps: unknown = null;
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  calls.push({ method, path });
  let out: any = {};
  if (path.startsWith("/ui/tasks/board")) out = { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
  else if (path.startsWith("/ui/tasks/unread")) out = { enabled: true, total: 0, cards: {} };
  else if (path.startsWith("/ui/steps")) out = steps ?? { __status: 403, error: "admin_only" };
  else { const m = /^\/ui\/tasks\/cards\/([^/?]+)$/.exec(path); if (m && DETAILS[decodeURIComponent(m[1]!)]) out = DETAILS[decodeURIComponent(m[1]!)]; }
  const status = out && typeof out === "object" && "__status" in out ? out.__status : 200;
  return { ok: status < 400, status, json: async () => out };
};

const REAL_NOW = Date.now();
let NOW = REAL_NOW;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "open",
  assignee: null, dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: false, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 4, createdAt: ago(10 * HOUR), updatedAt: ago(HOUR), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Game", description: "", archived: false, sort: 1, createdAt: ago(30 * HOUR) };
const ANN = { name: "Ann", kind: "person" };

/** M-2 "RPG shooter" with S-1 (done, game-designer), S-2 (game-dev) and S-3 (game-qa, after S-2). The states of S-2 and S-3 are set per test. */
const sub = (id: string, over: Record<string, unknown>) => card({ id, kind: "sub", parentId: "M-2", sort: Number(id.slice(2)), ...over });
let main: any, S1: any, S2: any, S3: any;
function plan(s2: Record<string, unknown> = {}, s3: Record<string, unknown> = {}, over: { main?: Record<string, unknown> } = {}) {
  S1 = sub("S-1", { title: "Game design doc", status: "done", assignee: "game-designer", doneAt: ago(10 * MIN) });
  S2 = sub("S-2", { title: "Playable prototype", status: "claimed", assignee: "game-dev", dependsOn: ["S-1"], ...s2 });
  S3 = sub("S-3", { title: "QA and balance pass", status: "open", assignee: "game-qa", dependsOn: ["S-2"], unmetDeps: ["S-2"], ...s3 });
  const subs = [S1, S2, S3];
  const done = subs.filter((c) => c.status === "done").length, claimed = subs.filter((c) => c.status === "claimed").length;
  main = card({ id: "M-2", title: "RPG shooter", status: "claimed", assignee: "test", sort: 2, progress: { total: 3, open: subs.filter((c) => c.status === "open").length, claimed, blocked: subs.filter((c) => c.status === "blocked").length, review: 0, done }, ...over.main });
  CARDS = [main, ...subs];
  setDetails();
}
const history = () => [{ id: 1, actor: "Ann", actorKind: "person", type: "created", data: {}, at: ago(3 * HOUR) }];
function setDetails(extra: { main?: Record<string, unknown>; sub?: Record<string, Record<string, unknown>> } = {}) {
  DETAILS = {
    "M-2": { card: main, parent: null, children: [S1, S2, S3], comments: [], logs: [], history: history(), subEvents: [], viewer: ANN, watchers: [], inheritedWatchers: [], leader: null, ...extra.main },
    ...Object.fromEntries([S1, S2, S3].map((c) => [c.id, { card: c, parent: { id: "M-2", title: main.title, status: main.status }, children: [], comments: [], logs: [], history: history(), viewer: ANN, watchers: [], inheritedWatchers: [], leader: null, ...(extra.sub ?? {})[c.id] }])),
  };
}
const ho = (card: string, to: string, state: string, extra: Record<string, unknown> = {}) => ({ id: Math.floor(Math.random() * 1e6), card, to, why: "ready", after: "S-1", at: ago(2 * MIN), state, ...extra });
const mv = (id: number, card: string, actor: string, from: string, to: string, ago_: number, extra: Record<string, unknown> = {}) => ({ id, at: ago(ago_), actor, actorKind: "instance", card, title: card === "S-1" ? "Game design doc" : "Playable prototype", data: { from, to, ...extra } });

const toolLine = (ms: number, name: string, input: Record<string, unknown>) => JSON.stringify({ type: "assistant", uuid: `a${ms}`, timestamp: new Date(ms).toISOString(),
  message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${ms}`, name, input }] } });
const stepsOf = (lines: string[]): LogStep[] => { const parser = new ClaudeStepParser({ thinking: false }); lines.forEach((l, i) => parser.push(l, i * 1000)); return parser.steps; };
const feedAnswer = (instance: string, over: Record<string, unknown> = {}) => ({ enabled: true, instance, backend: "claude-code", supported: true, thinking: false, level: "standard", cwd: "/w", home: "/h",
  steps: stepsOf([toolLine(Date.now() - 20_000, "Read", { file_path: "/w/src/a.ts" }), toolLine(Date.now() - 10_000, "Edit", { file_path: "/w/src/game.js", old_string: "a", new_string: "b" })]), after: 100, key: "1-2", before: null, ev: 0, ...over });

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  flow = await import("/ui/js/fleet-task-flow.js");
  run = await import("/ui/js/fleet-task-run.js");
  act = await import("/ui/js/chat-activity.js");
  activity = await import("/ui/js/fleet-task-activity.js");
  i18n = await import("/assets/app-i18n.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

const doc = () => (globalThis as any).document;
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string | null => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : null);
/** The dashboard's view of the fleet: each instance's state (`working`, `idle`, `stuck`, `awaiting_input`, `stopped`, `paused`). */
const fleetIs = (states: Record<string, string>) => app.applyStatus({ uptime: 1, instances: Object.entries(states).map(([name, state]) =>
  state === "awaiting_input" ? { name, status: "running", state, execution_state: "working", interaction_summary: "a permission" }
    : state === "stopped" ? { name, status: "stopped", state: "stopped", execution_state: "idle" }
      : state === "paused" ? { name, status: "paused", state: "paused", execution_state: "idle" }
        : { name, status: "running", state, execution_state: state }) });
const EVERYONE = { "game-designer": "idle", "game-dev": "idle", "game-qa": "idle", test: "idle" };

beforeEach(async () => {
  await p.unmount();
  act.forgetActivity();
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_assignee", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  for (const k of ["publicLink", "chatActivity", "linkMedia", "tier"]) delete doc().body.dataset[k];
  i18n.setLang("en", { store: false });
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1; (globalThis as any).history.states.length = 1; (globalThis as any).history.at = 0;
  calls.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  steps = null;
  app.appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { (handlers[name] ??= []).push(fn); return () => { handlers[name] = (handlers[name] ?? []).filter((f) => f !== fn); }; } });
  plan();
  fleetIs(EVERYONE);
});
afterEach(() => { vi.useRealTimers(); });

let mounts = 0;
async function open(card = "M-2", storage: Record<string, string> = { agend_tasks_project: "1" }) {
  await p.unmount();
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  for (const [k, v] of Object.entries(storage)) (globalThis as any).localStorage.setItem(k, v);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|flow-${++mounts}|en` }));
  await settle(8);
  fire(q(`[data-tile="${card}"] .tb-tile-title`), "click"); await settle(12);
}
const rowOf = (id: string) => qa(".tp-subs .tc-children li").find((li) => text(li)!.includes(` ${id} `) || text(li)!.includes(` ${id}`) && text(li)!.split(" ").includes(id));
const btnOf = (id: string) => rowOf(id)?.querySelector("button");
/** What the row says in full: the first line of its tooltip (the rest explains it). Null when the row says nothing. */
const lineOf = (id: string) => { const t = btnOf(id)?.getAttribute("title"); return t ? t.split("\n")[0]! : null; };
/** The short label beside a row's title, or null. */
const chipOf = (id: string) => { const el = rowOf(id)?.querySelector(".tf-chip"); return el ? text(el) : null; };
const chipEl = (id: string) => rowOf(id)!.querySelector(".tf-chip");
/** Whether the row's agent is running it: its title shimmers and the row is tinted. */
const shimmers = (id: string) => !!rowOf(id)?.querySelector(".tf-shimmer") && btnOf(id)!.className.includes("is-running");
const block = () => q(".tr-run");

// ── 1. What a line says (pure) ─────────────────────────────────────────────────────────────────────────────

describe("1. what a line says", () => {
  const states = (o: Record<string, string>) => new Map(Object.entries(o));
  const ctx = (st: Record<string, string>, over: Record<string, unknown> = {}) => ({ handoffs: [], states: states(st), doing: new Map(), live: () => "", ...over });

  it("handoffText: each state of a notice has its words; offline, paused and working are the page's inference", () => {
    const say = (state: string, st: Record<string, string> = {}, extra: Record<string, unknown> = {}) => { const r = flow.handoffText({ to: "dev", state, ...extra }, states(st)); return r ? [r.tone, r.text] : null; };
    expect(say("sending")).toEqual(["wait", "Handed to dev"]);
    expect(say("queued", { dev: "idle" })).toEqual(["wait", "Waiting for dev to take it"]);
    expect(say("queued", { dev: "stopped" })).toEqual(["wait", "dev is offline — it gets this when it is back"]);
    expect(say("queued", { dev: "paused" })).toEqual(["wait", "dev is paused — it gets this when it is resumed"]);
    expect(say("delivered", { dev: "idle" })).toEqual(["ok", "Delivered to dev — waiting for it to start"]);
    expect(say("read", { dev: "idle" })).toEqual(["ok", "dev read it — waiting for it to start"]);
    // A working instance is not "working" beside "not started": the notice's own state is what is said (the card says it is running, when it probably is).
    expect(say("read", { dev: "working" })).toEqual(["ok", "dev read it — waiting for it to start"]);
    expect(say("failed")).toEqual(["bad", "Could not hand it to dev"]);
    expect(say("uncertain")).toEqual(["bad", "Not sure dev got it"]);
    expect(say("withdrawn")?.[0]).toBe("muted");
    expect(say("skipped", {}, { skip: "board_off" })).toEqual(["bad", "dev's task board is off, so it was not told"]);
    expect(say("skipped", {}, { skip: "not_taken" })).toEqual(["bad", "The notice to dev could not be queued"]);
    expect(say("skipped", {}, { skip: "lost" })?.[1]).toContain("was lost");
    expect(say("skipped", {}, { skip: "contact_held" })).toEqual(["bad", "dev was not told"]);
    expect(say("skipped", {}, { skip: "not_waiting" }), "the card no longer waited: nothing to say").toBeNull();
    expect(say("unknown"), "no record any more: nothing to say, never a guess").toBeNull();
    expect(flow.handoffText(null, states({}))).toBeNull();
  });

  it("subLine: the card in progress says what its agent is doing, or its state; the others say where they stand", () => {
    const line = (c: any, st: Record<string, string>, over: Record<string, unknown> = {}) => { const l = flow.subLine(card({ kind: "sub", id: "S-2", ...c }), ctx(st, over)); return l ? [l.kind, l.tone, l.text, !!l.spin] : null; };
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "working" })).toEqual(["running", "busy", "dev · Running", true]);
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "working" }, { live: () => "Edit src/game.js" })).toEqual(["running", "busy", "dev · Edit src/game.js", true]);
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "working" }, { doing: new Map([["dev", 2]]) })).toEqual(["busy", "muted", "dev · busy with 2 cards", false]);
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "needs" })).toEqual(["needs", "warn", "dev · waiting for you", false]);
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "stuck" })).toEqual(["stuck", "bad", "dev · looks stuck", false]);
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "idle" })).toEqual(["idle", "muted", "dev · idle", false]);
    expect(line({ status: "claimed", assignee: "ghost" }, { dev: "working" }), "an instance the viewer does not see: nothing is said of it").toBeNull();
    expect(line({ status: "claimed", assignee: null }, {})).toBeNull();
    expect(line({ status: "blocked", assignee: "dev", blockedReason: "needs the API key" }, {})).toEqual(["blocked", "bad", "Blocked: needs the API key", false]);
    expect(line({ status: "blocked", assignee: "dev" }, {})?.[2]).toBe("Blocked");
    expect(line({ status: "done", assignee: "dev" }, { dev: "working" })).toBeNull();
    expect(line({ status: "review", assignee: "dev" }, { dev: "working" })).toBeNull();
  });

  it("subLine: an open card waits for what it depends on (a hidden one counted, never named), then is ready, then is handed on", () => {
    const line = (c: any, over: Record<string, unknown> = {}) => { const l = flow.subLine(card({ kind: "sub", id: "S-2", status: "open", ...c }), ctx({ dev: "idle" }, over)); return l ? [l.kind, l.text] : null; };
    expect(line({ assignee: "dev", dependsOn: ["S-1", "S-3"], unmetDeps: ["S-1", "S-3"] })).toEqual(["waiting", "Waits for S-1, S-3"]);
    expect(line({ assignee: "dev", dependsOn: [], unmetDeps: [], hiddenUnmet: 1 })?.[1]).toContain("Waits for");
    expect(line({ assignee: null })).toEqual(["ready", "Ready to start — nobody is assigned"]);
    expect(line({ assignee: "dev" })).toEqual(["ready", "Ready — dev has not started it yet"]);
    const handed = [{ id: 3, card: "S-2", to: "dev", state: "read", at: ago(MIN) }];
    expect(line({ assignee: "dev" }, { handoffs: handed })).toEqual(["handed", "dev read it — waiting for it to start"]);
    expect(line({ assignee: "dev" }, { handoffs: [{ id: 3, card: "S-2", to: "someone-else", state: "read", at: ago(MIN) }] }), "a hand-over to a former assignee is not the baton now").toEqual(["ready", "Ready — dev has not started it yet"]);
    expect(line({ assignee: "dev" }, { handoffs: [{ id: 1, card: "S-2", to: "dev", state: "failed", at: ago(HOUR) }, { id: 2, card: "S-2", to: "dev", state: "read", at: ago(MIN) }] })?.[1], "the newest").toBe("dev read it — waiting for it to start");
    expect(line({ assignee: "dev" }, { handoffs: [{ id: 3, card: "S-2", to: "dev", state: "skipped", skip: "not_waiting", at: ago(MIN) }] })).toEqual(["ready", "Ready — dev has not started it yet"]);
  });

  it("mainLines: the strongest first, at most four and how many more; what only waits is not listed", () => {
    const sc = (id: string, status: string, assignee: string, extra: Record<string, unknown> = {}) => card({ kind: "sub", id, status, assignee, ...extra });
    const subs = [sc("S-1", "done", "a"), sc("S-2", "open", "b", { unmetDeps: ["S-3"] }), sc("S-3", "claimed", "c"), sc("S-4", "blocked", "d", { blockedReason: "why" }), sc("S-5", "claimed", "e"), sc("S-6", "claimed", "f"), sc("S-7", "claimed", "g"), sc("S-8", "cancelled", "h")];
    const r = flow.mainLines(subs, ctx({ c: "working", e: "needs", f: "stuck", g: "idle" }, { live: (n: string) => (n === "c" ? "Edit a.ts" : "") }), 4);
    expect(r.lines.map((x: any) => [x.card.id, x.line.kind])).toEqual([["S-3", "running"], ["S-5", "needs"], ["S-6", "stuck"], ["S-4", "blocked"]]);
    expect(r.more).toBe(1);                                                // S-7 (idle)
    expect(flow.mainLines([sc("S-1", "done", "a"), sc("S-2", "open", "b", { unmetDeps: ["S-3"] }), sc("S-3", "open", "c", { unmetDeps: ["S-4"] })], ctx({})).lines, "only waiting: one quiet line instead").toEqual([]);
    expect(flow.mainLines([sc("S-2", "open", "b")], ctx({})).lines, "ready, nobody told: the row's, not the block's").toEqual([]);
    expect(flow.mainLines([], ctx({})).lines).toEqual([]);
  });

  it("a handoff as the activity says it, and its card starting settles it", () => {
    const states0 = states({ dev: "idle" });
    const ready = { id: 1, card: "S-2", to: "dev", why: "ready", after: "S-1", at: ago(MIN), state: "read" };
    expect(flow.batonOf(ready, states0, null)).toEqual({ lead: "S-1 done → handed to dev to start S-2", status: { tone: "ok", text: "dev read it — waiting for it to start" } });
    expect(flow.batonOf(ready, states0, { at: ago(30_000), by: "dev" }).status).toEqual({ tone: "done", text: "dev started S-2" });
    // Someone else moved it (a person, another instance): the page does not say the baton-holder did.
    expect(flow.batonOf(ready, states0, { at: ago(30_000), by: "Ann" }).status).toEqual({ tone: "done", text: "S-2 started" });
    expect(flow.batonOf(ready, states0, { at: ago(30_000), by: "" }).status.text, "an older event with no actor").toBe("S-2 started");
    expect(flow.batonOf({ ...ready, why: "assigned", after: null }, states0, null).lead).toBe("S-2 handed to dev");
    expect(flow.batonOf({ ...ready, after: null }, states0, null).lead).toBe("S-2 can start → handed to dev");
    expect(flow.batonOf({ ...ready, state: "unknown" }, states0, null).status).toBeNull();
  });

  it("startedAfter: the card's move to in progress at or after the handoff — a sub task's from the main task's events, its own from its history", () => {
    const h1 = { card: "S-2", at: ago(10 * MIN) };
    const d = { card: { id: "M-2" }, subEvents: [mv(1, "S-2", "dev", "open", "claimed", 20 * MIN), mv(2, "S-2", "dev", "open", "claimed", 5 * MIN), mv(3, "S-3", "qa", "open", "claimed", MIN)], history: [] };
    expect(flow.startedAfter(h1, d)).toEqual({ at: d.subEvents[1]!.at, by: "dev" });
    expect(flow.startedAfter({ card: "S-3", at: ago(10 * MIN) }, d)).toEqual({ at: d.subEvents[2]!.at, by: "qa" });
    expect(flow.startedAfter({ card: "S-2", at: ago(MIN) }, d)).toBeNull();
    expect(flow.startedAfter({ card: "S-2", at: ago(10 * MIN) }, { card: { id: "S-2" }, subEvents: [], history: [{ type: "moved", actor: "Ann", at: ago(4 * MIN), data: { to: "claimed" } }] }), "its own history names who moved it")
      .toMatchObject({ by: "Ann" });
  });

  it("which handoffs are still on their way, and the names to read the state of", () => {
    expect(flow.handoffsMoving({ handoffs: [{ state: "queued", at: ago(MIN) }] }, NOW)).toBe(true);
    expect(flow.handoffsMoving({ handoffs: [{ state: "read", at: ago(MIN) }] }, NOW)).toBe(false);
    expect(flow.handoffsMoving({ handoffs: [{ state: "queued", at: ago(30 * MIN) }] }, NOW), "stale: no polling for ever").toBe(false);
    expect(flow.handoffsMoving({}, NOW)).toBe(false);
    expect(flow.handoffNames({ handoffs: [{ to: "a" }, { to: "b" }, { to: "a" }] })).toEqual(["a", "b"]);
  });

  it("the step line of an instance, from the steps the chat's feed holds: the newest step, or the backend's phase when no call runs; nothing when steps are off", async () => {
    steps = feedAnswer("game-dev");
    const feed = act.observeActivity("game-dev", { changed: () => {}, working: () => true, polling: false, streamOn: undefined });
    feed.start(); await settle(10);
    expect(flow.liveLineOf("game-dev")).toMatch(/game\.js/);
    expect(flow.liveLineOf("someone-else"), "no feed read for it").toBe("");
    feed.stop();
    act.forgetActivity();
    steps = { enabled: true, instance: "game-dev", backend: "claude-code", supported: true, thinking: false, level: "off", steps: [], after: null, key: null, before: null, ev: 0 };
    const off = act.observeActivity("game-dev", { changed: () => {}, working: () => true, polling: false, streamOn: undefined });
    off.start(); await settle(10);
    expect(flow.liveLineOf("game-dev"), "tool progress off: the state alone").toBe("");
    off.stop();
  });
});

// ── 2. The main task's page ────────────────────────────────────────────────────────────────────────────────

describe("2. the main task's page: who is really working", () => {
  it("a sub task whose agent is working: its title shimmers (the state is the row's tooltip), the block lists it with a turning ring and Running sits beside the status; the others say where they stand", async () => {
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-1"), "done: nothing").toBeNull();
    expect(lineOf("S-2")).toBe("game-dev · Running");
    expect(shimmers("S-2"), "the title shimmers").toBe(true);
    expect(chipOf("S-2"), "a running row has no label: the shimmer says it").toBeNull();
    expect(lineOf("S-3")).toBe("Waits for S-2");
    expect(chipOf("S-3")).toBe("Waits for S-2");
    expect(shimmers("S-3")).toBe(false);
    expect(rowOf("S-2")!.querySelector(".tc-child-line, .out-spin"), "no second line, no ring in the row").toBeNull();
    expect(text(q(".tp-idrow .tr-mark")), "beside the status, as on the board").toBe("Running");
    expect(block().className).not.toContain("is-strip");
    expect(text(block().querySelector(".tf-lines"))).toBe("game-dev · Running S-2");
    expect(block().querySelector(".tf-lines .out-spin")).toBeTruthy();
    expect(block().querySelector("a.tr-open"), "a main task has no conversation of its own").toBeNull();
  });

  it("the board's tile says it too: a main task is Running while a sub task's agent is", async () => {
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open("M-2");
    fire(q(".tp-back, .tp-bar .tp-back"), "click"); await settle(8);
    expect(q('[data-tile="M-2"]').className).toContain("running");
    expect(text(q('[data-tile="M-2"] .tr-mark'))).toBe("Running");
  });

  it("with steps offered (an admin, tool progress on): the step is the row's tooltip and the block's line, and not a second line under the row — read once, for the instance that runs", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = feedAnswer("game-dev");
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    await settle(14);
    expect(lineOf("S-2")).toMatch(/^game-dev · .*game\.js/);
    expect(text(rowOf("S-2")), "the row itself does not repeat the step: the block above lists it").not.toContain("game.js");
    expect(shimmers("S-2")).toBe(true);
    expect(text(block().querySelector(".tf-lines"))).toMatch(/^game-dev · .*game\.js S-2$/);
    const reads = calls.filter((c) => c.path.startsWith("/ui/steps"));
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads.map((c) => /instance=([^&]+)/.exec(c.path)![1])), "only the instance that runs a sub task").toEqual(new Set(["game-dev"]));
  });

  it("tool progress off: the state alone, and no step is read into the line", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = { enabled: true, instance: "game-dev", backend: "claude-code", supported: true, thinking: false, level: "off", steps: [], after: null, key: null, before: null, ev: 0 };
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    await settle(14);
    expect(lineOf("S-2")).toBe("game-dev · Running");
    expect(JSON.stringify(calls)).not.toContain("game.js");
  });

  it("a viewer who is not an admin (no steps offered): the state alone, and nothing is asked of the steps' route", async () => {
    steps = feedAnswer("game-dev");
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    await settle(10);
    expect(lineOf("S-2")).toBe("game-dev · Running");
    expect(calls.filter((c) => c.path.startsWith("/ui/steps"))).toEqual([]);
  });

  it("Show activity switched off in this browser: the state alone, nothing read", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = feedAnswer("game-dev");
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    act.setActivityOn(false);
    try {
      await open();
      await settle(10);
      expect(lineOf("S-2")).toBe("game-dev · Running");
      expect(calls.filter((c) => c.path.startsWith("/ui/steps"))).toEqual([]);
    } finally { act.setActivityOn(true); }
  });

  it("an agent that is idle, waiting for you, stuck or busy with another card: each has its own look, and a busy agent is not called Running", async () => {
    await open();
    expect(lineOf("S-2")).toBe("game-dev · idle");
    expect(text(block().querySelector(".tf-lines"))).toBe("game-dev · idle S-2");
    expect(q(".tp-idrow .tr-mark"), "idle is not running").toBeNull();
    fleetIs({ ...EVERYONE, "game-dev": "awaiting_input" }); await settle(8);
    expect(lineOf("S-2")).toBe("game-dev · waiting for you");
    expect(chipEl("S-2")!.className).toContain("tf-warn");
    expect(text(q(".tp-idrow .tr-mark"))).toBe("Needs you");
    fleetIs({ ...EVERYONE, "game-dev": "stuck" }); await settle(8);
    expect(lineOf("S-2")).toBe("game-dev · looks stuck");
    expect(chipEl("S-2")!.className).toContain("tf-bad");
    CARDS = [...CARDS, sub("S-9", { status: "claimed", assignee: "game-dev", title: "Another" })]; DETAILS["M-2"].children = [S1, S2, S3, CARDS.at(-1)];
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-2")).toBe("game-dev · busy with 2 cards");
    expect(shimmers("S-2"), "not called running: no shimmer").toBe(false);
  });

  it("a blocked sub task says why, in the danger colour", async () => {
    plan({ status: "blocked", blockedReason: "needs the API key" });
    await open();
    expect(lineOf("S-2")).toBe("Blocked: needs the API key");
    expect(chipEl("S-2")!.className).toContain("tf-bad");
    expect(text(block().querySelector(".tf-lines"))).toContain("Blocked: needs the API key");
  });

  it("nothing is going on (only waiting, or ready with nobody told): the block is its one quiet line, as before", async () => {
    plan({ status: "open", unmetDeps: [] }, { status: "open", unmetDeps: ["S-2"] });
    await open();
    expect(block().className).toContain("is-strip");
    expect(text(q(".tp-agent-note"))).toBe("The work is in its sub tasks: each one's agent updates its own card");
    expect(lineOf("S-2")).toBe("Ready — game-dev has not started it yet");
    expect(lineOf("S-3")).toBe("Waits for S-2");
  });
});

describe("2b. the baton: S-1 done, S-2 handed on", () => {
  const handed = (state: string, extra: Record<string, unknown> = {}) => { plan({ status: "open", unmetDeps: [], assignee: "game-dev" }, { status: "open", unmetDeps: ["S-2"] }); setDetails({ main: { handoffs: [ho("S-2", "game-dev", state, extra)], subEvents: [mv(1, "S-1", "game-designer", "claimed", "done", 10 * MIN)] } }); };

  it("sending, taken, read: the row and the block say who has the baton, in words", async () => {
    handed("sending");
    await open();
    expect(lineOf("S-2")).toBe("Handed to game-dev");
    expect(btnOf("S-2")!.getAttribute("data-line")).toBe("handed");
    expect(text(block().querySelector(".tf-lines"))).toBe("Handed to game-dev S-2");
    handed("read"); emit("task_wakes", { ids: ["M-2"] });
    await new Promise((r) => setTimeout(r, 400)); await settle(10);
    expect(lineOf("S-2")).toBe("game-dev read it — waiting for it to start");
    expect(lineOf("S-3")).toBe("Waits for S-2");
  });

  it("offline or paused: it says when the agent will get it; a failure says it did not arrive, and why", async () => {
    handed("queued"); fleetIs({ ...EVERYONE, "game-dev": "stopped" });
    await open();
    expect(lineOf("S-2")).toBe("game-dev is offline — it gets this when it is back");
    fleetIs({ ...EVERYONE, "game-dev": "paused" }); await settle(8);
    expect(lineOf("S-2")).toBe("game-dev is paused — it gets this when it is resumed");
    fleetIs(EVERYONE);
    for (const [state, skip, want] of [["failed", undefined, "Could not hand it to game-dev"], ["uncertain", undefined, "Not sure game-dev got it"], ["skipped", "board_off", "game-dev's task board is off, so it was not told"], ["skipped", "not_taken", "The notice to game-dev could not be queued"]] as const) {
      handed(state, skip ? { skip } : {});
      await open();
      expect([state, skip, lineOf("S-2")]).toEqual([state, skip, want]);
      expect(chipEl("S-2")!.className).toContain("tf-bad");
    }
  });

  it("a read-only session has no record of the notice: the row says only that it is ready", async () => {
    plan({ status: "open", unmetDeps: [], assignee: "game-dev" }, { status: "open", unmetDeps: ["S-2"] });
    await open();
    expect(lineOf("S-2")).toBe("Ready — game-dev has not started it yet");
  });

  it("the sub task's own page says where its hand-over stands (and where it waits)", async () => {
    handed("read");
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read")], subEvents: [] }, sub: { "S-2": { handoffs: [ho("S-2", "game-dev", "read")] } } });
    await open("M-2");
    fire(rowOf("S-2")!.querySelector("button"), "click"); await settle(12);
    expect(q('[data-card="S-2"]')).toBeTruthy();
    expect(text(q(".tp-agent-note"))).toBe("game-dev read it — waiting for it to start");
    await open("M-2");
    fire(rowOf("S-3")!.querySelector("button"), "click"); await settle(12);
    expect(q('[data-card="S-3"]')).toBeTruthy();
    expect(text(q(".tp-agent-note"))).toBe("Waits for S-2");
  });
});

// ── 3. The activity ────────────────────────────────────────────────────────────────────────────────────────

describe("3. the main task's activity", () => {
  // The stream draws a day separator when its lines span two calendar days, and a run of history lines never crosses it. The tests run in
  // UTC, so with "now" taken from the clock the card's "created 3 hours ago" line falls on yesterday between 00:00 and 03:00 and splits a run:
  // pin the clock to the middle of a day.
  beforeEach(() => { NOW = REAL_NOW - (REAL_NOW % (24 * HOUR)) + 12 * HOUR; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
  afterEach(() => { NOW = REAL_NOW; });

  const events = () => [mv(1, "S-1", "game-designer", "open", "claimed", 40 * MIN), mv(2, "S-1", "game-designer", "claimed", "done", 10 * MIN), mv(3, "S-2", "game-dev", "open", "claimed", 3 * MIN)];

  it("the sub tasks' moves are lines of the activity, with the sub task's number; a handoff is a row of its own that is not folded away", async () => {
    plan({ status: "claimed", unmetDeps: [] });
    setDetails({ main: { subEvents: events(), handoffs: [ho("S-2", "game-dev", "read", { at: ago(9 * MIN) })] } });
    await open();
    const baton = q(".tl-baton");
    expect(baton, "visible without opening a run").toBeTruthy();
    expect(text(baton.querySelector(".tl-sentence"))).toBe("S-1 done → handed to game-dev to start S-2");
    expect(text(baton.querySelector(".tl-wake"))).toBe("game-dev started S-2");
    expect(baton.querySelector(".tl-wake").className).toContain("wk-done");
    // The moves are history lines, folded into "N activities" like any history; opened they name the sub task.
    const runs = qa(".tl-more").filter((b) => /activit/.test(text(b)!));
    expect(runs, "the history lines are runs on either side of the handoff row: it splits them, so it is never inside one").toHaveLength(2);
    for (const run of runs) { fire(run, "click"); await settle(4); }
    const lines = qa(".tl-event .tl-sentence").map((el) => text(el));
    expect(lines.some((l) => l!.includes("game-designer") && l!.includes("S-1 · changed status from To do to In progress"))).toBe(true);
    expect(lines.some((l) => l!.includes("game-designer") && l!.includes("S-1 · changed status from In progress to Done"))).toBe(true);
    expect(lines.some((l) => l!.includes("game-dev") && l!.includes("S-2 · changed status from To do to In progress"))).toBe(true);
  });

  it("the card started by someone other than the instance it was handed to (a person, another instance): the row says it started, not who", async () => {
    plan({ status: "claimed", unmetDeps: [] });
    const byPerson = { ...mv(3, "S-2", "Ann", "open", "claimed", 3 * MIN), actorKind: "person" };
    setDetails({ main: { subEvents: [events()[1]!, byPerson], handoffs: [ho("S-2", "game-dev", "read", { at: ago(9 * MIN) })] } });
    await open();
    expect(text(q(".tl-baton .tl-wake"))).toBe("S-2 started");
    setDetails({ main: { subEvents: [events()[1]!, mv(3, "S-2", "game-dev", "open", "claimed", 3 * MIN)], handoffs: [ho("S-2", "game-dev", "read", { at: ago(9 * MIN) })] } });
    await open();
    expect(text(q(".tl-baton .tl-wake")), "the instance it was handed to started it: it is named").toBe("game-dev started S-2");
  });

  it("a hand-over that names no predecessor (a card kept out of sight, or none) reads \"S-2 can start\", not \"S-1 done\"", async () => {
    plan({ status: "open", unmetDeps: [] }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read", { after: null })], subEvents: [] } });
    await open();
    expect(text(q(".tl-baton .tl-sentence"))).toBe("S-2 can start → handed to game-dev");
  });

  it("not started yet: the handoff row says where it stands, and follows the instance's state", async () => {
    handedState("queued");
    fleetIs({ ...EVERYONE, "game-dev": "stopped" });
    await open();
    expect(text(q(".tl-baton .tl-wake"))).toBe("game-dev is offline — it gets this when it is back");
    fleetIs(EVERYONE); await settle(8);
    expect(text(q(".tl-baton .tl-wake"))).toBe("Waiting for game-dev to take it");
    function handedState(state: string) { plan({ status: "open", unmetDeps: [] }, { status: "open", unmetDeps: ["S-2"] }); setDetails({ main: { subEvents: [events()[1]!], handoffs: [ho("S-2", "game-dev", state)] } }); }
  });

  it("the History filter has them; Comments does not", async () => {
    plan({ status: "claimed", unmetDeps: [] });
    setDetails({ main: { subEvents: events(), handoffs: [ho("S-2", "game-dev", "read", { at: ago(9 * MIN) })] } });
    await open();
    const filter = (name: string) => qa(".tl-filter button").find((b) => text(b)!.startsWith(name));
    fire(filter("History"), "click"); await settle(6);
    expect(q(".tl-baton")).toBeTruthy();
    expect(qa(".tl-event")).toHaveLength(4);                                     // the card's creation and the three moves, each open
    fire(filter("Comments"), "click"); await settle(6);
    expect(q(".tl-baton")).toBeNull();
  });

  it("a session that cannot write has the moves and no handoff row", async () => {
    plan({ status: "claimed", unmetDeps: [] });
    setDetails({ main: { subEvents: events(), viewer: undefined } });
    await open();
    expect(q(".tl-baton")).toBeNull();
    expect(qa(".tl-more").some((b) => /activit/.test(text(b)!)), "the moves are there").toBe(true);
  });

  it("an instance's name and a card's title are text — never markup", async () => {
    const nasty = "<img src=x onerror=alert(1)>";
    plan({ status: "open", unmetDeps: [], assignee: nasty }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [ho("S-2", nasty, "read")], subEvents: [] } });
    await open();
    expect(qa(".tl-baton img, .tc-children img, .tf-lines img")).toHaveLength(0);
    expect(text(q(".tl-baton .tl-sentence"))).toContain(nasty);
  });
});

// ── 4. Live ────────────────────────────────────────────────────────────────────────────────────────────────

describe("4. live", () => {
  it("a ping for this main task reads it again — and one for a card that is not on this page does not", async () => {
    await open();
    const reads = () => calls.filter((c) => c.method === "GET" && /^\/ui\/tasks\/cards\/M-2$/.test(c.path)).length;
    const before = reads();
    emit("task_wakes", { ids: ["M-9"] });
    await new Promise((r) => setTimeout(r, 400)); await settle(6);
    expect(reads()).toBe(before);
    emit("task_wakes", { ids: ["M-2", "S-2"] });
    await new Promise((r) => setTimeout(r, 400)); await settle(10);
    expect(reads()).toBe(before + 1);
  });

  it("a hand-over on its way is read again by itself; once settled it is not", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    plan({ status: "open", unmetDeps: [] }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "queued")], subEvents: [] } });
    await open();
    const reads = () => calls.filter((c) => c.method === "GET" && /^\/ui\/tasks\/cards\/M-2$/.test(c.path)).length;
    const before = reads();
    await vi.advanceTimersByTimeAsync(5_100); await settle(6);
    expect(reads()).toBeGreaterThan(before);
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read")], subEvents: [] } });
    await vi.advanceTimersByTimeAsync(5_100); await settle(10);
    const settled = reads();
    await vi.advanceTimersByTimeAsync(20_000); await settle(6);
    expect(reads()).toBe(settled);
  });

  it("the agent's state moves the line with the dashboard's own status frames; the step line moves with the feed's steps_tick", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = feedAnswer("game-dev");
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    await settle(14);
    expect(lineOf("S-2")).toMatch(/game\.js/);
    steps = feedAnswer("game-dev", { steps: stepsOf([toolLine(Date.now() - 2_000, "Bash", { command: "npm test" })]), after: 200, key: "1-3" });
    emit("steps_tick", { instance: "game-dev" });
    await new Promise((r) => setTimeout(r, 50)); await settle(14);
    expect(lineOf("S-2")).toMatch(/npm test/);
    fleetIs({ ...EVERYONE, "game-dev": "idle" }); await settle(8);
    expect(lineOf("S-2")).toBe("game-dev · idle");
    expect(shimmers("S-2")).toBe(false);
  });
});

// ── 4b. The agent is working on the card it was given, but has not claimed it ─────────────────────────────────

describe("4b. working on a card it has not claimed (an agent that used twelve tools over six minutes, S-11 still To do)", () => {
  const states = (o: Record<string, string>) => new Map(Object.entries(o));
  // An open card the board handed to its assignee a minute ago has `handedAt` (the server's: only a card it told the assignee about).
  const sc = (id: string, status: string, assignee: string | null, extra: Record<string, unknown> = {}) => card({ kind: "sub", id, status, assignee, ...(status === "open" ? { handedAt: ago(MIN) } : {}), ...extra });
  const ctx = (st: Record<string, string>, cards: any[], over: Record<string, unknown> = {}) => ({ handoffs: [], states: states(st), doing: run.inProgressBy(cards), ready: run.readyOpenBy(cards), live: () => "", now: NOW, workStart: new Map(), ...over });

  it("readyOpenBy: the open cards an instance could start, by name — not a claimed one, not one that waits (one it cannot see too), not a main task that follows its sub tasks", () => {
    const cards = [sc("S-1", "open", "dev"), sc("S-2", "open", "dev", { unmetDeps: ["S-1"] }), sc("S-3", "open", "ops", { hiddenUnmet: 1 }), sc("S-4", "claimed", "ops"), sc("S-5", "open", null),
      card({ id: "M-1", status: "open", assignee: "lead", progress: { total: 2, open: 2, claimed: 0, blocked: 0, review: 0, done: 0 } }), card({ id: "M-2", status: "open", assignee: "lead" })];
    expect([...run.readyOpenBy(cards)]).toEqual([["dev", ["S-1"]], ["lead", ["M-2"]]]);
    expect([...run.readyOpenBy(undefined)]).toEqual([]);
  });

  it("runUnclaimed: it is working, it was given this card, can start it, has nothing in progress and no other open card — so it is probably on this one", () => {
    const cards = [sc("S-11", "open", "dev")];
    expect(run.runUnclaimed(cards[0], ctx({ dev: "working" }, cards))).toEqual({ instance: "dev", state: "working", shared: 0, unclaimed: true });
    expect(run.runUnclaimed(cards[0], ctx({ dev: "idle" }, cards)), "not working").toBeNull();
    expect(run.runUnclaimed(cards[0], ctx({ dev: "needs" }, cards)), "waiting for the person is not running").toBeNull();
    expect(run.runUnclaimed(cards[0], ctx({}, cards)), "an instance the viewer does not see").toBeNull();
    const more = [...cards, sc("S-12", "open", "dev")];
    expect(run.runUnclaimed(more[0], ctx({ dev: "working" }, more)), "two open cards: nothing says which").toBeNull();
    const busy = [...cards, sc("S-13", "claimed", "dev")];
    expect(run.runUnclaimed(busy[0], ctx({ dev: "working" }, busy)), "a card in progress is its work").toBeNull();
    expect(run.runUnclaimed(sc("S-11", "open", "dev", { unmetDeps: ["S-10"] }), ctx({ dev: "working" }, [sc("S-11", "open", "dev", { unmetDeps: ["S-10"] })])), "it waits for another").toBeNull();
    expect(run.runUnclaimed(cards[0], { states: states({ dev: "working" }), doing: new Map() }), "a caller from before has no `ready`: no such run").toBeNull();
    expect(run.runUnclaimed(sc("S-11", "claimed", "dev"), ctx({ dev: "working" }, cards)), "a claimed card is runOf's").toBeNull();
  });

  it("runOf: an open card has the run; a claimed card's is as before; a main task takes its sub tasks' — a claimed one first, and while it is still open itself", () => {
    const open = sc("S-2", "open", "dev"), mine = sc("S-3", "claimed", "qa");
    const c = ctx({ dev: "working", qa: "working" }, [open, mine]);
    expect(run.runOf(open, c)).toMatchObject({ instance: "dev", unclaimed: true });
    expect(run.runOf(mine, c)).toEqual({ instance: "qa", state: "working", shared: 0 });
    const main = card({ id: "M-2", status: "claimed", progress: { total: 2, open: 1, claimed: 1, blocked: 0, review: 0, done: 0 } });
    expect(run.runOf(main, c, [open, mine])?.instance, "the claimed one is the stronger").toBe("qa");
    expect(run.runOf({ ...main, status: "open" }, ctx({ dev: "working" }, [open]), [open])).toMatchObject({ instance: "dev", unclaimed: true });
    expect(run.runOf({ ...main, status: "review" }, c, [open]), "a main task waiting for confirmation is not running").toBeNull();
  });

  it("subLine: a running line with the step and 'not claimed yet'; flagged once it has gone on; only while the notice reached it", () => {
    const cards = [sc("S-11", "open", "dev", { updatedAt: ago(HOUR), handedAt: ago(10_000) })];
    const line = (over: Record<string, unknown> = {}, st: Record<string, string> = { dev: "working" }) => { const l = flow.subLine(cards[0], ctx(st, cards, over)); return l ? [l.kind, l.tone, l.text, !!l.spin, !!l.unclaimed] : null; };
    const read = (at: number, state = "read", extra: Record<string, unknown> = {}) => ({ handoffs: [{ id: 1, card: "S-11", to: "dev", state, at: ago(at), ...extra }] });
    expect(line(read(10_000))).toEqual(["running", "busy", "dev · Running (not claimed yet)", true, true]);
    expect(line({ ...read(10_000), live: () => "Run python3 game.html" })).toEqual(["running", "busy", "dev · Run python3 game.html (not claimed yet)", true, true]);
    const gone = [sc("S-11", "open", "dev", { updatedAt: ago(HOUR), handedAt: ago(5 * MIN) })];
    const late = flow.subLine(gone[0], ctx({ dev: "working" }, gone, read(5 * MIN)));
    expect([late.tone, late.text, late.late]).toEqual(["warn", "dev · Running (still not claimed)", true]);
    expect(late.tip).toContain("Ask it to claim it");
    expect(line(read(10_000, "delivered"))![0], "delivered is enough").toBe("running");
    expect(line({ handoffs: [] })![0], "a session with no record of the notice (read-only): the inference stands").toBe("running");
    expect(line(read(10_000, "skipped", { skip: "not_waiting" }))![0]).toBe("running");
    for (const state of ["sending", "queued", "failed", "uncertain", "withdrawn"]) expect([state, line(read(10_000, state))![0]], "the notice has not reached it: it is not on this card").toEqual([state, "handed"]);
    expect(line(read(10_000), { dev: "idle" }), "it stopped: the notice's state again — no 'working' beside 'not started'").toEqual(["handed", "ok", "dev read it — waiting for it to start", false, false]);
    expect(flow.subLine(sc("S-11", "claimed", "dev"), ctx({ dev: "working" }, cards))).toMatchObject({ kind: "running", text: "dev · Running" });
    expect(flow.subLine(sc("S-11", "claimed", "dev"), ctx({ dev: "working" }, cards))!.unclaimed, "after the claim: the plain running line").toBeUndefined();
  });

  it("with several cards it could be on, or one in progress: the notice's state, and never a claim of 'working'", () => {
    const two = [sc("S-11", "open", "dev"), sc("S-12", "open", "dev")];
    expect(flow.subLine(two[0], ctx({ dev: "working" }, two, { handoffs: [{ id: 1, card: "S-11", to: "dev", state: "read", at: ago(MIN) }] }))).toMatchObject({ kind: "handed", text: "dev read it — waiting for it to start" });
    const one = [sc("S-11", "open", "dev"), sc("S-13", "claimed", "dev")];
    expect(flow.subLine(one[0], ctx({ dev: "working" }, one))).toMatchObject({ kind: "ready" });
  });

  it("an agent that is only chatting (no hand-over of this card, or work that began before it) is not on the card: nothing is shown as running", () => {
    const handed = [sc("S-11", "open", "dev")];                                      // handed a minute ago
    const never = [sc("S-11", "open", "dev", { handedAt: undefined })];              // the board never told it about this card
    expect(run.runUnclaimed(never[0], ctx({ dev: "working" }, never)), "no hand-over: not evidence").toBeNull();
    expect(run.runOf(never[0], ctx({ dev: "working" }, never))).toBeNull();
    expect(flow.subLine(never[0], ctx({ dev: "working" }, never, { handoffs: [{ id: 1, card: "S-11", to: "dev", state: "read", at: ago(MIN) }] })), "the notice's state, not 'running'")
      .toMatchObject({ kind: "handed", text: "dev read it — waiting for it to start" });
    expect(flow.subLine(never[0], ctx({ dev: "working" }, never))).toMatchObject({ kind: "ready" });
    const began = (ms: number | undefined) => ctx({ dev: "working" }, handed, { workStart: new Map(ms === undefined ? [] : [["dev", ms]]) });
    expect(run.runUnclaimed(handed[0], began(NOW - 20 * MIN)), "it was at work twenty minutes before the card was handed over: that is something else").toBeNull();
    expect(run.runUnclaimed(handed[0], began(NOW - 5 * MIN)), "or five minutes before").toBeNull();
    expect(run.runUnclaimed(handed[0], began(NOW - 30_000)), "it began after the hand-over (a minute ago)").toMatchObject({ unclaimed: true });
    expect(run.runUnclaimed(handed[0], began(NOW - MIN - 5_000)), "a few seconds' clock slack").toMatchObject({ unclaimed: true });
    expect(run.runUnclaimed(handed[0], began(undefined)), "this page did not see it begin: it cannot say, and does not hold it against the card").toMatchObject({ unclaimed: true });
    expect(run.runUnclaimed(sc("S-11", "open", "dev", { handedAt: "not a time" }), ctx({ dev: "working" }, handed))).toBeNull();
  });

  it("the page's own observation: it saw the instance start working (idle, then working) — or it was working when first seen and nothing is known", () => {
    const store = (state: string) => ({ instances: [{ name: "obs", status: "running", state }], exec: { obs: state }, awaiting: {} });
    run.forgetWorkStarts();
    run.instanceStates(store("working"), ["obs"]);
    expect(run.workStartOf("obs"), "first seen already working").toBeUndefined();
    run.instanceStates(store("idle"), ["obs"]);
    run.instanceStates(store("working"), ["obs"]);
    const at = run.workStartOf("obs");
    expect(at).toBeGreaterThan(Date.now() - 5_000);
    run.instanceStates(store("working"), ["obs"]);
    expect(run.workStartOf("obs"), "still the same start").toBe(at);
    run.instanceStates(store("idle"), ["obs"]);
    expect(run.workStartOf("obs"), "it stopped: no start").toBeUndefined();
    run.forgetWorkStarts();
  });

  it("the board: an agent that is only chatting does not light up its main task's tile or row; one handed the card does", async () => {
    plan({ status: "open", unmetDeps: [], assignee: "game-dev", handedAt: undefined }, { status: "open", unmetDeps: ["S-2"] });
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await p.unmount();
    (globalThis as any).localStorage.setItem("agend_tasks_project", "1");
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|flow-${++mounts}|en` }));
    await settle(8);
    expect(q('[data-tile="M-2"]').className, "chatting, nothing handed: no light").not.toContain("running");
    expect(q('[data-tile="M-2"] .tr-mark')).toBeNull();
    plan({ status: "open", unmetDeps: [], assignee: "game-dev", handedAt: ago(10_000) }, { status: "open", unmetDeps: ["S-2"] });
    await p.unmount();
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|flow-${++mounts}|en` }));
    await settle(8);
    expect(q('[data-tile="M-2"]').className, "handed the card, working, nothing in progress").toContain("running");
    expect(text(q('[data-tile="M-2"] .tr-mark'))).toBe("Running · not claimed");
  });

  it("the card page of a card the board never handed it: the notice's state, not 'running' — the agent may just be chatting", async () => {
    unclaimed({ handedAt: undefined });
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-2")).toBe("game-dev read it — waiting for it to start");
    expect(q(".tp-idrow .tr-mark")).toBeNull();
    expect(q(".tf-lines .out-spin")).toBeNull();
  });

  const unclaimed = (over: Record<string, unknown> = {}, at = 10_000) => {
    plan({ status: "open", unmetDeps: [], assignee: "game-dev", updatedAt: ago(HOUR), handedAt: ago(at), ...over }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read", { at: ago(at) })], subEvents: [mv(1, "S-1", "game-designer", "claimed", "done", 10 * MIN)] } });
  };

  it("the page: the row, the block, the handoff row and the status all say it is running — with the ring, and 'not claimed yet'; never 'working' and 'not started' together", async () => {
    unclaimed();
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-2")).toBe("game-dev · Running (not claimed yet)");
    expect(shimmers("S-2"), "the title shimmers").toBe(true);
    expect(text(block().querySelector(".tf-lines"))).toBe("game-dev · Running (not claimed yet) S-2");
    expect(block().querySelector(".tf-lines .out-spin")).toBeTruthy();
    expect(text(q(".tl-baton .tl-wake")), "the handoff row").toBe("game-dev · Running (not claimed yet)");
    expect(q(".tl-baton .tl-wake .out-spin")).toBeTruthy();
    expect(text(q(".tp-idrow .tr-mark")), "beside the status").toBe("Running · not claimed");
    expect(q(".tp-idrow .tr-mark").className).toContain("unclaimed");
    expect(text(q(".tp")), "the two sentences that contradicted each other").not.toMatch(/not started yet|is working…/);
  });

  it("the board's tile and row say it too — the main task is Running while the agent it handed a sub task to is working on it", async () => {
    unclaimed();
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open("M-2");
    fire(q(".tp-back, .tp-bar .tp-back"), "click"); await settle(8);
    expect(q('[data-tile="M-2"]').className).toContain("running");
    expect(text(q('[data-tile="M-2"] .tr-mark'))).toBe("Running · not claimed");
    await p.unmount();
    (globalThis as any).localStorage.setItem("agend_tasks_display", JSON.stringify({ view: "list" }));
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|flow-${++mounts}|en` }));
    await settle(8);
    expect(q('[data-row="M-2"]').className, "the list's row").toContain("running");
    expect(text(q('[data-row="M-2"] .tr-mark'))).toBe("Running · not claimed");
  });

  it("with steps offered (an admin, tool progress on) the line says what it is doing, everywhere; without them the state alone", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = feedAnswer("game-dev");
    unclaimed();
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    await settle(14);
    expect(lineOf("S-2")).toMatch(/^game-dev · .*game\.js.* \(not claimed yet\)$/);
    expect(text(block().querySelector(".tf-lines"))).toMatch(/game\.js.*\(not claimed yet\) S-2$/);
    expect(text(q(".tl-baton .tl-wake"))).toMatch(/game\.js.*\(not claimed yet\)$/);
    act.forgetActivity();
    steps = { enabled: true, instance: "game-dev", backend: "claude-code", supported: true, thinking: false, level: "off", steps: [], after: null, key: null, before: null, ev: 0 };
    await open();
    await settle(14);
    expect(lineOf("S-2"), "tool progress off").toBe("game-dev · Running (not claimed yet)");
    expect(JSON.stringify(calls.filter((c) => c.path.startsWith("/ui/steps")).slice(-1))).not.toContain("game.js");
  });

  it("not an admin (no steps offered): the state alone, and the steps' route is not asked", async () => {
    steps = feedAnswer("game-dev");
    unclaimed();
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    await settle(10);
    expect(lineOf("S-2")).toBe("game-dev · Running (not claimed yet)");
    expect(calls.filter((c) => c.path.startsWith("/ui/steps"))).toEqual([]);
  });

  it("it has gone on for a while without claiming: the line is flagged, and says what to do (the board never moves the card itself)", async () => {
    unclaimed({}, 6 * MIN);
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-2")).toBe("game-dev · Running (still not claimed)");
    expect(chipEl("S-2")!.className).toContain("tf-warn");
    expect(q(".tl-baton .tl-wake").className).toContain("wk-warn");
    expect(btnOf("S-2")!.getAttribute("title")).toContain("Ask it to claim it");
    expect(calls.filter((c) => c.method === "POST"), "nothing moved the card").toEqual([]);
  });

  it("a 'not claimed yet' line turns into the flagged one by itself — a 30 s clock runs only while such a line is on the page", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    unclaimed({ handedAt: new Date(NOW - 60_000).toISOString() }, 60_000);
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-2"), "a minute: not yet").toBe("game-dev · Running (not claimed yet)");
    const withClock = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(30_000); await settle(6);
    expect(lineOf("S-2"), "90 s on the dot: not past it yet").toBe("game-dev · Running (not claimed yet)");
    await vi.advanceTimersByTimeAsync(31_000); await settle(6);
    expect(lineOf("S-2"), "past 90 s: flagged on the next look, with no store change and no click").toBe("game-dev · Running (still not claimed)");
    expect(chipEl("S-2")!.className).toContain("tf-warn");
    expect(q(".tl-baton .tl-wake").className).toContain("wk-warn");
    const flagged = vi.getTimerCount();
    expect(flagged, "flagged: nothing left to turn, the clocks are gone").toBeLessThan(withClock);
    // A claimed card has no such line: no clock of its own.
    plan({ status: "claimed", unmetDeps: [], assignee: "game-dev" }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [], subEvents: [] } });
    await open();
    expect(lineOf("S-2")).toBe("game-dev · Running");
    expect(vi.getTimerCount(), "a plain running line needs no clock of its own").toBeLessThanOrEqual(flagged);
  });

  it("after it claims: the plain running line (no 'not claimed'), the same ring; when it stops: the notice's state, no contradiction", async () => {
    unclaimed();
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-2")).toMatch(/not claimed yet/);
    plan({ status: "claimed", unmetDeps: [], assignee: "game-dev" }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read", { at: ago(10_000) })], subEvents: [mv(1, "S-1", "game-designer", "claimed", "done", 10 * MIN), mv(2, "S-2", "game-dev", "open", "claimed", 1000)] } });
    emit("tasks", { rev: 2, ids: ["M-2"] });
    await open();
    expect(lineOf("S-2")).toBe("game-dev · Running");
    expect(shimmers("S-2")).toBe(true);
    expect(text(q(".tp-idrow .tr-mark"))).toBe("Running");
    expect(text(q(".tl-baton .tl-wake")), "started: the handoff row says who started it").toBe("game-dev started S-2");
    unclaimed();
    fleetIs({ ...EVERYONE, "game-dev": "idle" });
    await open();
    expect(lineOf("S-2"), "it stopped without claiming: the notice's state").toBe("game-dev read it — waiting for it to start");
    expect(q(".tp-idrow .tr-mark")).toBeNull();
  });

  it("it could be on more than one card: nothing is said of 'running', and the notice's state stands", async () => {
    unclaimed();
    CARDS = [...CARDS, sub("S-9", { status: "open", assignee: "game-dev", title: "Another", unmetDeps: [] })];
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-2")).toBe("game-dev read it — waiting for it to start");
    expect(q(".tp-idrow .tr-mark")).toBeNull();
  });

  it("the sub task's own page: Running, the way to its conversation, and a note that it has not claimed the card", async () => {
    unclaimed();
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read", { at: ago(10_000) })], subEvents: [] }, sub: { "S-2": { handoffs: [ho("S-2", "game-dev", "read", { at: ago(10_000) })] } } });
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open("M-2");
    fire(rowOf("S-2")!.querySelector("button"), "click"); await settle(12);
    expect(q('[data-card="S-2"]')).toBeTruthy();
    expect(text(q(".tr-state"))).toBe("Running");
    expect(text(q(".tr-unclaimed"))).toBe("game-dev is working and has this card, but has not claimed it — the board shows work only once a card is in progress.");
    expect(text(q(".tp-idrow .tr-mark"))).toBe("Running · not claimed");
    expect(q("a.tr-open").getAttribute("href")).toBe("/ui/chat/game-dev");
  });

  it("in Traditional Chinese", async () => {
    i18n.setLang("zh-TW", { store: false });
    unclaimed();
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-2")).toBe("game-dev · 執行中 (尚未認領)");
    expect(text(q(".tp-idrow .tr-mark"))).toBe("執行中・尚未認領");
  });
});

// ── 5. Both languages ──────────────────────────────────────────────────────────────────────────────────────

describe("5. both languages", () => {
  it("every string the lines use is in English and Traditional Chinese, with the same holes", () => {
    const keys = ["running", "needs", "stuck", "idle", "busyN", "busyTip", "runningTip", "waitsFor", "readyNobody", "readyFor", "blocked", "blockedOn", "sending", "queued", "offline", "paused", "delivered",
      "read", "unclaimed", "unclaimedLate", "unclaimedTip", "unclaimedLateTip", "failed", "uncertain", "withdrawn", "skip.board_off", "skip.not_taken", "skip.lost", "skip.other", "handedAfter", "handedReady", "handedAssigned", "started", "startedNeutral", "handoffLabel", "linesLabel", "openCard", "more"]
      .map((k) => `taskflow.${k}`).concat(["runningUnclaimed", "unclaimedTip", "unclaimedNote"].map((k) => `taskrun.${k}`));
    const holes = (s: string) => [...new Set(s.match(/\{\d\}/g) ?? [])].sort().join();
    for (const key of keys) {
      const en = i18n.tIn("en", key), zh = i18n.tIn("zh-TW", key);
      expect(en, key).not.toBe(key);
      expect(zh, key).not.toBe(key);
      expect(zh, `${key} is translated`).not.toBe(en);
      expect(holes(zh), `${key} placeholders`).toBe(holes(en));
    }
  });

  it("in Traditional Chinese: the rows, the block, the handoff", async () => {
    i18n.setLang("zh-TW", { store: false });
    plan({ status: "open", unmetDeps: [], assignee: "game-dev" }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read")], subEvents: [mv(1, "S-1", "game-designer", "claimed", "done", 10 * MIN)] } });
    await open();
    expect(lineOf("S-2")).toBe("game-dev 已讀，等它開始");
    expect(lineOf("S-3")).toBe("等 S-2");
    expect(text(q(".tl-baton .tl-sentence"))).toBe("S-1 完成 → 已交給 game-dev 開始 S-2");
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    plan({ status: "claimed", unmetDeps: [] });
    await open();
    expect(lineOf("S-2")).toBe("game-dev · 執行中");
    expect(text(q(".tp-idrow .tr-mark"))).toBe("執行中");
  });
});

// keep the imports honest: the modules the page is made of
void run; void activity;

// ── 6. A sub task's row says it itself ─────────────────────────────────────────────────────────────────────

describe("6. a sub task's row: a shimmering title or a short label — no second line, and the step is not drawn twice", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/ui/shared/task-board.css", import.meta.url)), "utf8");
  const rule = (sel: string) => { const m = new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css); return m ? m[1]!.replace(/\s+/g, " ").trim() : null; };

  it("a row is the status, the number, the title (with its label) and who: nothing is added to it, whatever the state", async () => {
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    for (const id of ["S-1", "S-2", "S-3"]) expect([...btnOf(id)!.children].map((c: any) => c.className.split(" ")[0]), id).toEqual(["tb-pill", "tb-code", "tc-child-title", "tb-who"]);
    expect(qa(".tp-subs .tc-child-line, .tp-subs .tc-children .out-spin")).toHaveLength(0);
  });

  it("the labels: each state of a sub task has a short one, the sentence is the tooltip, and a running row has none", async () => {
    const chips: Array<[string, () => Promise<void> | void, string | null, string]> = [
      ["waiting", () => { fleetIs(EVERYONE); }, "Waits for S-2", "Waits for S-2"],
      ["idle", () => { fleetIs(EVERYONE); }, "Idle", "game-dev · idle"],
      ["needs you", () => { fleetIs({ ...EVERYONE, "game-dev": "awaiting_input" }); }, "Waiting for you", "game-dev · waiting for you"],
      ["stuck", () => { fleetIs({ ...EVERYONE, "game-dev": "stuck" }); }, "Looks stuck", "game-dev · looks stuck"],
      ["running", () => { fleetIs({ ...EVERYONE, "game-dev": "working" }); }, null, "game-dev · Running"],
    ];
    for (const [name, set, chip, sentence] of chips) {
      plan({ status: "claimed" });
      set();
      await open();
      const id = name === "waiting" ? "S-3" : "S-2";
      expect([name, chipOf(id), lineOf(id)]).toEqual([name, chip, sentence]);
    }
    plan({ status: "blocked", blockedReason: "needs the API key" }); await open();
    expect([chipOf("S-2"), lineOf("S-2")]).toEqual(["Blocked", "Blocked: needs the API key"]);
    plan({ status: "open", unmetDeps: [], assignee: "game-dev" }, { status: "open", unmetDeps: ["S-2"] }); await open();
    expect([chipOf("S-2"), lineOf("S-2")]).toEqual(["Ready", "Ready — game-dev has not started it yet"]);
    plan({ status: "claimed" }); CARDS = [...CARDS, sub("S-9", { status: "claimed", assignee: "game-dev", title: "Another" })]; DETAILS["M-2"].children = [S1, S2, S3, CARDS.at(-1)];
    fleetIs({ ...EVERYONE, "game-dev": "working" }); await open();
    expect([chipOf("S-2"), lineOf("S-2"), shimmers("S-2")]).toEqual(["Busy · 2 cards", "game-dev · busy with 2 cards", false]);
  });

  it("the hand-over: its label says how far it got, and the sentence is the tooltip", async () => {
    const handed = (state: string, extra: Record<string, unknown> = {}) => { plan({ status: "open", unmetDeps: [], assignee: "game-dev" }, { status: "open", unmetDeps: ["S-2"] }); setDetails({ main: { handoffs: [ho("S-2", "game-dev", state, extra)], subEvents: [] } }); };
    const cases: Array<[string, Record<string, unknown>, string, string, string]> = [
      ["sending", {}, "Handed to game-dev", "Handed to game-dev", "tf-wait"],
      ["delivered", {}, "Delivered", "Delivered to game-dev — waiting for it to start", "tf-ok"],
      ["read", {}, "Read", "game-dev read it — waiting for it to start", "tf-ok"],
      ["failed", {}, "Not sent", "Could not hand it to game-dev", "tf-bad"],
      ["uncertain", {}, "Not sure it arrived", "Not sure game-dev got it", "tf-bad"],
      ["skipped", { skip: "board_off" }, "Not told", "game-dev's task board is off, so it was not told", "tf-bad"],
      ["withdrawn", {}, "Withdrawn", "The notice to game-dev was withdrawn: the card changed again, and game-dev hears its new state", "tf-muted"],
    ];
    for (const [state, extra, chip, sentence, tone] of cases) {
      handed(state, extra); fleetIs(EVERYONE); await open();
      expect([state, chipOf("S-2"), lineOf("S-2")]).toEqual([state, chip, sentence]);
      expect(chipEl("S-2")!.className, state).toContain(tone);
    }
    handed("queued"); fleetIs({ ...EVERYONE, "game-dev": "stopped" }); await open();
    expect([chipOf("S-2"), lineOf("S-2")]).toEqual(["game-dev offline", "game-dev is offline — it gets this when it is back"]);
    fleetIs({ ...EVERYONE, "game-dev": "paused" }); await settle(8);
    expect(chipOf("S-2")).toBe("game-dev paused");
    fleetIs(EVERYONE); await settle(8);
    expect(chipOf("S-2")).toBe("Waiting");
  });

  it("an agent working on a card it has not claimed: the title shimmers and the label says so, and flags itself when it goes on", async () => {
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    plan({ status: "open", unmetDeps: [], assignee: "game-dev", updatedAt: ago(HOUR), handedAt: new Date(NOW - 60_000).toISOString() }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read", { at: new Date(NOW - 60_000).toISOString() })], subEvents: [] } });
    await open();
    expect([shimmers("S-2"), chipOf("S-2")]).toEqual([true, "Not claimed yet"]);
    expect(chipEl("S-2")!.className).toContain("tf-busy");
    await vi.advanceTimersByTimeAsync(60_000); await settle(6);
    expect([shimmers("S-2"), chipOf("S-2")]).toEqual([true, "Still not claimed"]);
    expect(chipEl("S-2")!.className).toContain("tf-warn");
  });

  it("zh-TW: the labels and the tooltips are in the page's language", async () => {
    i18n.setLang("zh-TW", { store: false });
    plan({ status: "claimed" }); fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect([chipOf("S-2"), lineOf("S-2"), shimmers("S-2")]).toEqual([null, "game-dev · 執行中", true]);
    expect([chipOf("S-3"), lineOf("S-3")]).toEqual(["等 S-2", "等 S-2"]);
  });

  it("the sub task's number in the main task's block, which opens it, is a 44px box on a touch screen or a phone", () => {
    const at = css.indexOf("@media (pointer: coarse), (max-width: 899px) { .tf-item .tf-card");
    expect(at).toBeGreaterThan(0);
    expect(css.slice(at, css.indexOf("}\n", css.indexOf("}", at) + 1))).toMatch(/\.tf-item \.tf-card \{[^}]*min-height: var\(--tap\)[^}]*min-width: var\(--tap\)/);
  });

  it("the shimmer is in the page's own colours, moves only when motion is allowed, and the row is tinted either way", () => {
    expect(css).toContain("@keyframes tf-shimmer");
    const at = css.indexOf("@media (prefers-reduced-motion: no-preference) {\n  @supports");
    expect(at, "the sweep is inside prefers-reduced-motion: no-preference").toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf("\n}\n", css.indexOf(".tf-shimmer", at)) + 3);
    expect(block).toMatch(/animation: tf-shimmer/);
    expect(block, "tokens only").not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(block).toMatch(/var\(--text\)/);
    expect(block).toMatch(/var\(--accent\)/);
    expect(rule(".tp-subs .tc-children button.is-running"), "the tint is outside the media query: still with reduced motion").toMatch(/background: color-mix\(in srgb, var\(--accent\) 6%, transparent\)/);
    expect(css.slice(0, at).includes(".tf-shimmer {"), "nothing animates outside the media query").toBe(false);
    expect(rule(".tf-chip")).toMatch(/border-radius: var\(--r-full\)/);
    expect(rule(".tf-chip"), "tokens only").not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
