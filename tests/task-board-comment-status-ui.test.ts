/**
 * A comment's status and the person's unread as the page draws them (docs/design/task-board.md, "Comment status" and "Unread"):
 *
 *   1. What is computed (pure): the lines under a comment for each state of a notice, the instance's state (offline, paused, working), a
 *      reply, a comment too old to say; a card's mark and the strip's words; which comments are still moving.
 *   2. The card page: the status under a comment moves with the instance's state and with a stream ping (`task_wakes`), the card is read
 *      again while a notice is on its way, a read-only session sees none, and names and reasons are text, never markup.
 *   3. Unread: a dot on a tile and a row, the strip on Home and on a board, the sidebar's number on the Fleet row; opening a card tags
 *      its new comments, marks it read (one POST) and the number falls; a read-only session has none and sends nothing.
 *
 * The page is the real Tasks tab in tests/helpers/mini-dom.ts (as tests/task-board-comment-threads-ui.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let p: AppPage;
let app: any, nav: any, fleet: any, wake: any, unreadUi: any, unreadStore: any, run: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
let handler: (path: string, method: string, body: any) => unknown = () => ({});
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  const body = o.body ? JSON.parse(o.body) : null;
  calls.push({ method, path, body });
  const out: any = await handler(path, method, body);
  const status = out && typeof out === "object" && "__status" in out ? out.__status : 200;
  return { ok: status < 400, status, json: async () => out };
};

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: "M-1", kind: "main", projectId: 1, parentId: null, title: "Serve the leaderboard", status: "claimed",
  assignee: "alpha", dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 4, createdAt: ago(10 * HOUR), updatedAt: ago(HOUR), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: ago(30 * HOUR) };
const ANN = { name: "Ann", kind: "person" };
const wk = (to: string, state: string, extra: Record<string, unknown> = {}) => ({ to, why: "assignee", state, at: ago(2 * MIN), ...extra });
const c = (id: number, author: string, authorKind: string, text: string, extra: Record<string, unknown> = {}) => ({ id, author, authorKind, kind: "comment", text, at: ago((20 - id) * MIN), ...extra });
let detail: Record<string, unknown>;
const detailOf = (comments: unknown[], over: Record<string, unknown> = {}) => ({ card: card({}), parent: null, children: [], comments, logs: [], history: [], viewer: ANN, watchers: [], inheritedWatchers: [], leader: null, ...over });
let unread: Record<string, unknown>;
const UNREAD_NONE = { enabled: true, total: 0, cards: {} };

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  wake = await import("/ui/js/fleet-task-wake.js");
  unreadUi = await import("/ui/js/fleet-task-unread.js");
  unreadStore = await import("/ui/js/task-unread.js");
  run = await import("/ui/js/fleet-task-run.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

const doc = () => (globalThis as any).document;
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string | null => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : null);
const posts = () => calls.filter((x) => x.method === "POST");
const handlers: Record<string, Array<(d: unknown) => void>> = {};
const emit = (name: string, data: unknown) => { for (const fn of handlers[name] ?? []) fn(data); };
const status = (state = "idle", exec = state) => app.applyStatus({ uptime: 1, instances: ["alpha", "beta", "quiet"].map((name) => ({ name, status: "running", state, execution_state: exec })) });

beforeEach(async () => {
  await p.unmount();
  for (const k of ["publicLink", "linkMedia", "tier"]) delete doc().body.dataset[k];
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1; (globalThis as any).history.states.length = 1; (globalThis as any).history.at = 0;
  calls.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  detail = detailOf([]);
  unread = UNREAD_NONE;
  app.appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { (handlers[name] ??= []).push(fn); return () => { handlers[name] = (handlers[name] ?? []).filter((f) => f !== fn); }; }, taskUnread: undefined });
  handler = (path, method) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: [card({})], boardOff: ["quiet"] };
    if (path.startsWith("/ui/tasks/unread")) return unread;
    const m = /^\/ui\/tasks\/cards\/([^/]+)\/read$/.exec(path);
    if (m && method === "POST") { unread = UNREAD_NONE; return { ok: true, ...UNREAD_NONE }; }
    if (/^\/ui\/tasks\/cards\/([^/]+)/.test(path) && method === "POST") return { card: card({}), comment: {}, notes: [] };
    if (/^\/ui\/tasks\/cards\/([^/]+)/.test(path)) return detail;
    return {};
  };
  status();
});
afterEach(() => { vi.useRealTimers(); });

let mounts = 0;
async function open(storage: Record<string, string> = { agend_tasks_project: "1" }, opts: { card?: boolean } = { card: true }) {
  await p.unmount();
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  for (const [k, v] of Object.entries(storage)) (globalThis as any).localStorage.setItem(k, v);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|cs-${++mounts}|en` }));
  await settle(8);
  if (opts.card) { fire(q(`[data-tile="M-1"] .tb-tile-title`), "click"); await settle(10); }
}
const comment = (id: number) => q(`#c${id}`);
const lines = (id: number) => qa(`#c${id} .tl-wake`).map((el) => text(el));

describe("1. what is computed", () => {
  const entry = (wakes: unknown[], extra: Record<string, unknown> = {}) => ({ type: "comment", id: 5, at: ago(2 * MIN), who: "Ann", by: "person", wakes, ...extra });
  const states = (o: Record<string, string>) => new Map(Object.entries(o));
  const say = (e: any, o: Record<string, string> = {}, comments: any[] = []) => wake.wakeLines(e, comments, states(o), NOW).map((l: any) => [l.to, l.tone, l.text]);

  it("sent → waiting → delivered → read, each in words; read while it is working is 'working', and a later comment by it is its reply", () => {
    expect(say(entry([wk("alpha", "sending")]))).toEqual([["alpha", "wait", "Sent to alpha"]]);
    expect(say(entry([wk("alpha", "queued")]), { alpha: "idle" })).toEqual([["alpha", "wait", "Waiting for alpha to take it"]]);
    expect(say(entry([wk("alpha", "delivered")]), { alpha: "idle" })).toEqual([["alpha", "ok", "Delivered to alpha"]]);
    expect(say(entry([wk("alpha", "read")]), { alpha: "idle" })).toEqual([["alpha", "ok", "alpha read it"]]);
    expect(say(entry([wk("alpha", "read")]), { alpha: "working" })).toEqual([["alpha", "busy", "alpha is working…"]]);
    const reply = { type: "comment", id: 9, who: "alpha", by: "instance" };
    expect(say(entry([wk("alpha", "read")]), { alpha: "idle" }, [entry([]), reply])).toEqual([["alpha", "done", "alpha replied"]]);
  });

  it("waiting on an instance that is offline or paused says so", () => {
    for (const [state, word] of [["stopped", "is offline"], ["crashed", "is offline"], ["paused", "is paused"]] as const) {
      expect(say(entry([wk("alpha", "queued")]), { alpha: state })[0]![2], state).toContain(word);
    }
  });

  it("not woken keeps its reason; a failed or unconfirmed delivery says so; a withdrawn notice is quiet; an unknown state says nothing", () => {
    for (const skip of ["board_off", "contact_held", "loop_guard", "unknown", "cap", "wakes_off", "not_waiting", "not_taken", "lost"]) {
      const [line] = say(entry([wk("alpha", "skipped", { skip })]));
      expect([skip, line![1], line![2].includes("{0}"), line![2].startsWith("taskwake.")]).toEqual([skip, "bad", false, false]);
    }
    expect(say(entry([wk("alpha", "failed")]))[0]).toEqual(["alpha", "bad", "Could not deliver to alpha"]);
    expect(say(entry([wk("alpha", "uncertain")]))[0]).toEqual(["alpha", "bad", "Not sure alpha got it"]);
    expect(say(entry([wk("alpha", "withdrawn")]))[0]![1]).toBe("muted");
    expect(say(entry([wk("alpha", "unknown")]))).toEqual([]);
  });

  it("an old comment is not annotated once settled (read, replied), but a failure always is; a deleted comment or one with no wakes has none", () => {
    const old = { at: ago(2 * 24 * HOUR) };
    expect(say(entry([wk("alpha", "read")], old), { alpha: "idle" })).toEqual([]);
    expect(say(entry([wk("alpha", "failed")], old))).toHaveLength(1);
    expect(say(entry([wk("alpha", "read")], { deleted: { at: "x", by: "Ann" } }))).toEqual([]);
    expect(say({ type: "comment", id: 1, at: ago(MIN) })).toEqual([]);
  });

  it("an instance's own earlier comment is no reply to a later one, and a person's is never one", () => {
    const e = entry([wk("alpha", "read")]);
    const before = { type: "comment", id: 2, who: "alpha", by: "instance" };
    const person = { type: "comment", id: 9, who: "alpha", by: "person" };
    expect(wake.repliedBy(e, "alpha", [before, e, person])).toBeNull();
    expect(wake.repliedBy(e, "alpha", [e, { type: "comment", id: 9, who: "alpha", by: "instance", deleted: { at: "x" } }])).toBeNull();
    expect(wake.repliedBy(e, "alpha", [e, { type: "comment", id: 9, who: "alpha", by: "script" }])!.id).toBe(9);
  });

  it("which comments are still moving (the page reads the card again for them), and the instances to read the state of", () => {
    const d = { comments: [{ id: 1, at: ago(MIN), wakes: [wk("alpha", "queued")] }, { id: 2, at: ago(MIN), wakes: [wk("beta", "read")] }] };
    expect(wake.wakesMoving(d, NOW)).toBe(true);
    expect(wake.wakesMoving({ comments: [{ id: 2, at: ago(MIN), wakes: [wk("beta", "read")] }] }, NOW)).toBe(false);
    expect(wake.wakesMoving({ comments: [{ id: 1, at: ago(30 * MIN), wakes: [wk("alpha", "queued")] }] }, NOW)).toBe(false);   // stale: no polling for ever
    expect(wake.wakeNames(d).sort()).toEqual(["alpha", "beta"]);
  });

  it("a card's mark counts its own and its sub tasks' unread, strongest reason first", () => {
    const unread = { "M-1": { n: 1, reasons: ["mention"] }, "S-2": { n: 2, reasons: ["review", "reply"] }, "S-3": { n: 1, reasons: ["answer"] } };
    expect(unreadUi.markFor({ id: "M-1" }, [{ id: "S-2" }, { id: "S-3" }, { id: "S-9" }], unread)).toEqual({ n: 4, reasons: ["review", "reply", "answer", "mention"] });
    expect(unreadUi.markFor({ id: "M-7" }, [], unread)).toBeNull();
    expect(unreadUi.markFor({ id: "M-7" }, [], null)).toBeNull();
  });

  it("the reasons are said with who did it", () => {
    expect(unreadUi.reasonText({ reasons: ["answer"], by: "dev" })).toBe("dev answered you");
    expect(unreadUi.reasonText({ reasons: ["review"], by: "dev" })).toBe("Waiting for your confirmation");
  });
});

describe("2. the card page", () => {
  it("shows where a comment stands under it, and follows the instance's state: working while it works, replied once it has", async () => {
    detail = detailOf([c(11, "Ann", "person", "how is it going?", { wakes: [wk("alpha", "read")] })]);
    status("idle");
    await open();
    expect(lines(11)).toEqual(["alpha read it"]);
    status("working");
    await settle(6);
    expect(lines(11)).toEqual(["alpha is working…"]);
    detail = detailOf([c(11, "Ann", "person", "how is it going?", { wakes: [wk("alpha", "read")] }), c(12, "alpha", "instance", "going well")]);
    emit("tasks", { rev: 2, ids: ["M-1"] });
    // (the board's own ping reads the board; the card is read again by the page's own tick)
    emit("task_wakes", { ids: ["M-1"] });
    await new Promise((r) => setTimeout(r, 400)); await settle(10);
    expect(lines(11)).toEqual(["alpha replied"]);
  });

  it("a ping for this card reads it again — and one for another card does not", async () => {
    detail = detailOf([c(11, "Ann", "person", "hello", { wakes: [wk("alpha", "sending")] })]);
    await open();
    expect(lines(11)).toEqual(["Sent to alpha"]);
    const reads = () => calls.filter((x) => x.method === "GET" && /^\/ui\/tasks\/cards\/M-1$/.test(x.path)).length;
    const before = reads();
    emit("task_wakes", { ids: ["M-2"] });
    await new Promise((r) => setTimeout(r, 400)); await settle(6);
    expect(reads()).toBe(before);
    detail = detailOf([c(11, "Ann", "person", "hello", { wakes: [wk("alpha", "delivered")] })]);
    emit("task_wakes", { ids: ["M-1", "M-5"] });
    await new Promise((r) => setTimeout(r, 400)); await settle(10);
    expect(reads()).toBe(before + 1);
    expect(lines(11)).toEqual(["Delivered to alpha"]);
  });

  it("while a notice is on its way the card is read again by itself; once settled it is not", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    detail = detailOf([c(11, "Ann", "person", "hello", { at: ago(MIN), wakes: [wk("alpha", "queued")] })]);
    await open();
    const reads = () => calls.filter((x) => x.method === "GET" && /^\/ui\/tasks\/cards\/M-1$/.test(x.path)).length;
    const before = reads();
    await vi.advanceTimersByTimeAsync(5_100); await settle(6);
    expect(reads()).toBeGreaterThan(before);
    detail = detailOf([c(11, "Ann", "person", "hello", { at: ago(MIN), wakes: [wk("alpha", "read")] })]);
    await vi.advanceTimersByTimeAsync(5_100); await settle(10);
    const settled = reads();
    await vi.advanceTimersByTimeAsync(20_000); await settle(6);
    expect(reads()).toBe(settled);
  });

  it("a refusal says why in words, in the page's language, and an instance's name is text — never markup", async () => {
    const nasty = "<img src=x onerror=alert(1)>";
    detail = detailOf([
      c(11, "Ann", "person", "@quiet hi", { wakes: [wk("quiet", "skipped", { skip: "board_off" })] }),
      c(12, "Ann", "person", "x", { wakes: [wk(nasty, "skipped", { skip: "unknown" })] }),
    ]);
    await open();
    expect(lines(11)).toEqual(["quiet was not woken: its task board is off"]);
    expect(qa(`#c12 .tl-wake img`)).toHaveLength(0);
    expect(lines(12)![0]).toContain(nasty);
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("zh-TW");
    try {
      await open();
      expect(lines(11)).toEqual(["沒有叫醒 quiet：它的任務板是關閉的"]);
    } finally { setLang("en"); }
  });

  it("a comment written for nobody has no status line; a read-only page (no wakes in its read) has none", async () => {
    detail = detailOf([c(11, "Ann", "person", "a note"), c(12, "Ann", "person", "second")], { viewer: undefined });
    await open();
    expect(qa(".tl-wakes")).toHaveLength(0);
  });

  it("a reply's link scrolls to the reply (lights it)", async () => {
    detail = detailOf([c(11, "Ann", "person", "hello", { wakes: [wk("alpha", "read")] }), c(12, "alpha", "instance", "answer")]);
    await open();
    const link = q(`#c11 .tl-wake button`);
    expect(text(link)).toBe("alpha replied");
    fire(link, "click"); await settle(6);
    expect(comment(12).className).toContain("tl-flash");
  });
});

describe("3. unread", () => {
  const MINE = { "M-1": { n: 2, reasons: ["answer", "mention"], entries: [12, 13], at: ago(MIN), by: "alpha" } };

  it("a dot with the number on the card's tile, and a strip on the board that names it and why", async () => {
    unread = { enabled: true, total: 1, cards: MINE };
    await open({ agend_tasks_project: "1" }, { card: false });
    await unreadStore.refreshTaskUnread();
    await settle(8);
    const tile = q(`[data-tile="M-1"]`);
    expect(tile.className).toContain("has-unread");
    expect(text(tile.querySelector(".tb-unread"))).toBe("2");
    expect(tile.querySelector(".tb-unread").getAttribute("aria-label")).toBe("New for you: Answered");
    const strip = q(".tb-unread-strip");
    expect(text(strip)).toContain("1 task card has new replies");
    expect(text(strip.querySelector("[data-unread='M-1']"))).toContain("alpha answered you");
    expect(text(strip.querySelector("[data-unread='M-1']"))).toContain("+1 more");
  });

  it("the list's row has the dot too; Home has the strip", async () => {
    unread = { enabled: true, total: 1, cards: MINE };
    await open({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list", group: "status", order: "code", dir: "asc", done: "recent", subs: false }) }, { card: false });
    await unreadStore.refreshTaskUnread();
    await settle(8);
    expect(q(`[data-row="M-1"]`).className).toContain("has-unread");
    expect(qa(`[data-row="M-1"] .tb-unread`)).toHaveLength(1);
    await p.unmount();
    (globalThis as any).localStorage.removeItem("agend_tasks_project");
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|home-${++mounts}|en` }));
    await settle(10);
    expect(qa(".tb-unread-strip")).toHaveLength(1);
  });

  it("opening the card tags its new comments and marks it read once; the dot and the strip go", async () => {
    unread = { enabled: true, total: 1, cards: MINE };
    detail = detailOf([c(11, "Ann", "person", "how is it going?", { wakes: [wk("alpha", "read")] }), c(12, "alpha", "instance", "going well"), c(13, "beta", "instance", "@Ann also this"), c(14, "alpha", "instance", "old news")]);
    await unreadStore.refreshTaskUnread();
    await open();
    await new Promise((r) => setTimeout(r, 1400)); await settle(10);
    expect(posts().filter((x) => x.path === "/ui/tasks/cards/M-1/read")).toHaveLength(1);
    expect(qa(".tl-new").map((e) => text(e))).toEqual(["New", "New"]);
    expect(comment(12).className).toContain("tl-unread");
    expect(comment(14).className).not.toContain("tl-unread");
    expect(app.appStore.get().taskUnread.total).toBe(0);
    // Back on the board there is nothing to show: no dot, no strip.
    fire(q(".tp-back"), "click"); await settle(10);
    expect(qa(".tb-unread-strip")).toHaveLength(0);
    expect(qa(".tb-unread")).toHaveLength(0);
  });

  it("a read-only session has none: nothing is drawn, nothing is sent", async () => {
    unread = { enabled: false, total: 0, cards: {} };
    detail = detailOf([c(11, "alpha", "instance", "hello")], { viewer: undefined });
    doc().body.dataset.publicLink = "1";
    await unreadStore.refreshTaskUnread();
    await open();
    await new Promise((r) => setTimeout(r, 1400)); await settle(6);
    expect(posts()).toEqual([]);
    expect(qa(".tb-unread, .tb-unread-strip, .tl-new")).toHaveLength(0);
  });

  it("a card that is not on the board's page still opens by its number, and an unread of one the page does not carry shows its number only", async () => {
    unread = { enabled: true, total: 1, cards: { "M-77": { n: 1, reasons: ["review"], entries: [], at: ago(MIN), by: "alpha" } } };
    await open({ agend_tasks_project: "1" }, { card: false });
    await unreadStore.refreshTaskUnread();
    await settle(8);
    const row = q(".tb-unread-strip [data-unread='M-77']");
    expect(text(row)).toContain("M-77");
    expect(text(row)).toContain("Waiting for your confirmation");
  });

  it("the store takes the server's answer, and a failed read leaves what it had", async () => {
    unread = { enabled: true, total: 1, cards: MINE };
    await unreadStore.refreshTaskUnread();
    expect(app.appStore.get().taskUnread).toMatchObject({ loaded: true, enabled: true, total: 1 });
    handler = () => ({ __status: 500 });
    await unreadStore.refreshTaskUnread();
    expect(app.appStore.get().taskUnread.total).toBe(1);
  });
});

describe("4. the sidebar's number", () => {
  async function shell(taskUnread: unknown) {
    const { Shell } = await import("/assets/app-shell.js");
    app.appStore.set({ viewOnly: false, taskUnread });
    app.applyStatus({ instances: [{ name: "alpha", status: "running", backend: "claude-code", tags: ["AgEnD"] }] });
    await p.mount(h(Shell, { panels: new Map<string, unknown>([["fleet", { Component: fleet.FleetPanel }]]), onNewInstance() {}, viewOnly: false }));
    await settle(8);
    return q("#sidebar a.side-overview");
  }

  it("shows the number of cards on the Fleet row, with its words for a screen reader", async () => {
    const row = await shell({ loaded: true, enabled: true, total: 3, cards: {} });
    expect(text(q("#sidebar a.side-overview .task-unread-count"))).toBe("3");
    expect(row.getAttribute("aria-label")).toBe("Fleet (3 task cards with new replies)");
    await p.unmount();
    const one = await shell({ loaded: true, enabled: true, total: 1, cards: {} });
    expect(one.getAttribute("aria-label")).toBe("Fleet (1 task card has new replies)");
  });

  it("shows none at 0, nor for a session that cannot write", async () => {
    await shell({ loaded: true, enabled: true, total: 0, cards: {} });
    expect(qa("#sidebar .task-unread-count")).toHaveLength(0);
    await p.unmount();
    await shell({ loaded: true, enabled: false, total: 4, cards: {} });
    expect(qa("#sidebar .task-unread-count")).toHaveLength(0);
  });
});

describe("3b. a read that cannot start is a failed read", () => {
  it("with no `fetch` (a page torn down while its debounce timer was still running) the read answers false and nothing is thrown", async () => {
    const real = (globalThis as any).fetch;
    delete (globalThis as any).fetch;
    try {
      let thrown: unknown = null;
      const hear = (e: unknown) => { thrown = e; };
      process.once("uncaughtException", hear);
      expect(await unreadStore.refreshTaskUnread()).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      process.off("uncaughtException", hear);
      expect(thrown).toBeNull();
    } finally { (globalThis as any).fetch = real; }
    expect(await unreadStore.refreshTaskUnread(), "and the next read, with fetch back, works").toBe(true);
  });
});

describe("4. what a finger presses on a touch screen or a phone is a 44px box", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/ui/shared/task-board.css", import.meta.url)), "utf8");
  it("the link to an agent's reply and a card's title in the unread strip take --tap", () => {
    const at = css.indexOf("@media (pointer: coarse), (max-width: 899px) {\n  .tl-wake .tb-link");
    expect(at, "a touch / narrow block for the status line").toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf("\n}\n", at));
    expect(block).toMatch(/\.tl-wake \.tb-link \{[^}]*min-height: var\(--tap\)/);
    expect(block).toMatch(/\.tb-unread-row \.tb-wait-title \{ --grow: max\(0px, calc\(\(var\(--tap\) - 1lh\) \/ 2\)\); padding-block: var\(--grow\); margin-block: calc\(-1 \* var\(--grow\)\); \}/);
  });
});
