/**
 * #2299: the task board's looks, after the #2246 acceptance run (shots before and after are on the PR).
 *  1. A 0 % project's bar never looks full: only done work fills it (the percentage); what is blocked or waiting is
 *     named by the card's chips.
 *  2. The waiting row: the pill and the card's number and title in one line (.tb-wait-main), the reason under the title,
 *     the assignee and buttons together after them (.tb-wait-actions).
 *  3. Over the public link a card's details are text, not disabled controls that look usable.
 *  4. The toasts are a manual popover (the top layer: an open dialog's backdrop does not dim them), shown when there is one.
 *  5. The CSS: five columns fit beside the sidebar from 1280 px; a phone's gutter 16 px and header targets 44 px; the
 *     board's toasts above the tabs on a phone (not over its title and search), older confirmations giving way to two
 *     newer toasts (an error never hidden); the actions' buttons wide.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let app: any, nav: any, fleet: any, toastMod: any;
let handler: (path: string) => unknown = () => ({});
const fetchFake = async (path: string) => { const body: any = await handler(path); return { ok: true, status: 200, json: async () => body }; };
const CSS = readFileSync(join(import.meta.dirname, "..", "src", "ui", "shared", "app.css"), "utf8");

const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: "2026-10-20T00:00:00.000Z" };
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: "u1", kind: "main", projectId: 1, parentId: null, title: "Serve the weekly leaderboard", status: "blocked",
  assignee: "alpha", priority: "high", size: "M", needsReview: true, dependsOn: [], goal: "", scope: "", acceptance: [], context: "", state: "",
  blockedReason: "Which scores count: ranked games only?", result: "", sort: 1, createdBy: "Ann", version: 3, createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z", startedAt: null, submittedAt: null, doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 },
  unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const BLOCKED = card({});
const STATS = { 1: { mains: 1, waiting: 0, blocked: 1, percent: 0, units: { total: 1, open: 0, claimed: 0, blocked: 1, review: 0, done: 0 }, lastActivity: "2026-10-20T00:00:00.000Z" } };

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  toastMod = await import("/assets/ui-toast.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  (globalThis as any).localStorage.removeItem("agend_tasks_project");
  delete (globalThis as any).document.body.dataset.publicLink;
  handler = (path) => path === "/ui/tasks/board" ? { rev: 1, projects: [PROJECT], cards: [BLOCKED], stats: STATS } : path.startsWith("/ui/tasks/cards/") ? { card: BLOCKED, parent: null, children: [], comments: [], logs: [], history: [] } : {};
  app.applyStatus({ uptime: 1, instances: [{ name: "alpha", status: "running", state: "idle", execution_state: "idle" }] });
});
const mount = async (key: string) => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|${key}|en` })); await settle(8); };

describe("#2299 the task board's looks", () => {
  it("1. a project at 0 % with its only card blocked: the bar is the empty track — the chips say blocked", async () => {
    await mount("bar");
    expect([...p.root.querySelectorAll(".tb-project .tb-bar rect")].map((r: any) => r.getAttribute("class"))).toEqual(["tb-bar-track"]);
    expect(p.root.querySelector(".tb-project .tb-pct").textContent).toBe("0%");
    expect(p.root.querySelector(".tb-project .tb-flag.st-blocked")).toBeTruthy();
  });
  it("1b. done fills the bar as far as the percentage", async () => {
    handler = (path) => path === "/ui/tasks/board" ? { rev: 1, projects: [PROJECT], cards: [BLOCKED],
      stats: { 1: { ...STATS[1], percent: 50, units: { total: 4, open: 0, claimed: 1, blocked: 0, review: 1, done: 2 } } } } : {};
    await mount("half");
    expect([...p.root.querySelectorAll(".tb-project .tb-bar rect")].map((r: any) => `${r.getAttribute("class")}:${r.getAttribute("width")}`)).toEqual(["tb-bar-track:100", "tb-seg st-done:50"]);
  });

  it("2. the waiting row: pill, number and title in one line; the reason under the title; assignee and Answer after them", async () => {
    await mount("wait");
    const row = p.root.querySelector(".tb-wait-row");
    const main = row.querySelector(".tb-wait-main"), actions = row.querySelector(".tb-wait-actions");
    expect([...main.children].map((c: any) => c.className)).toEqual(["tb-pill st-blocked", "tb-wait-title"]);
    expect(main.querySelector(".tb-wait-title .tb-code").textContent).toBe("M-1");
    expect(main.querySelector(".tb-wait-title .tb-wait-reason").textContent).toBe(BLOCKED.blockedReason);
    expect([...actions.children].map((c: any) => c.className)).toEqual(["muted", "btn btn-primary btn-sm"]);
  });

  it("3. over the public link the card's project, priority, size and review are text — no select, no checkbox", async () => {
    (globalThis as any).document.body.dataset.publicLink = "1";
    await mount("public");
    fire(p.root.querySelector(".tb-project-open"), "click");
    await settle(8);
    fire(p.root.querySelector(".tb-tile-title"), "click");
    await settle(8);
    const meta = p.root.querySelector("dialog .tc-meta") ?? (globalThis as any).document.querySelector("dialog .tc-meta");
    expect(meta, "the card is open").toBeTruthy();
    expect(meta.querySelectorAll("select, input").length).toBe(0);
    expect([...meta.querySelectorAll(".tc-value")].map((v: any) => v.textContent)).toEqual(["Leaderboard", "High", "Medium", "Stops at review for your confirmation"]);
  });

  it("4. the toasts are a manual popover, shown while there is one (into the top layer, above a dialog's backdrop)", async () => {
    await p.mount(h(toastMod.Toasts, {}));
    await settle(2);
    const box = p.root.querySelector(".toasts");
    expect(box.getAttribute("popover")).toBe("manual");
    let shown = 0, hidden = 0, open = false;
    box.showPopover = () => { shown++; open = true; }; box.hidePopover = () => { hidden++; open = false; }; box.matches = (s: string) => s === ":popover-open" ? open : false;
    toastMod.toast("one"); await settle(2);
    expect([shown, open]).toEqual([1, true]);
    toastMod.toast("two"); await settle(2);
    expect([shown, hidden, open], "shown again on a new toast: above a dialog opened meanwhile").toEqual([2, 1, true]);
  });

  it("5. the CSS: columns fit from 1280 px, a phone's gutter and targets, the board's toasts above the tabs, two at most", () => {
    expect(CSS).toMatch(/\.tb-columns \{ display: grid; grid-template-columns: repeat\(5, minmax\(176px, 1fr\)\)/);
    const phone = CSS.slice(CSS.indexOf("@media (max-width: 899px)"));
    expect(CSS).toMatch(/\n  \.col \{ padding: var\(--s-3\) var\(--s-4\) var\(--s-8\); \}/);
    expect(CSS).toMatch(/\.panel-head \.icon-btn \{ min-width: var\(--tap\); min-height: var\(--tap\); \}/);
    expect(CSS).toMatch(/\.shell:has\(\.tb-home, \.tb-board-page\) \.toasts > \.toast\.ok:nth-last-child\(n\+3\) \{ display: none; \}/);
    expect(CSS, "not every phone page: the board's own rule").not.toMatch(/\n  \.toasts > \.toast:nth-last-child/);
    expect(CSS).toMatch(/\.shell:has\(\.tb-home, \.tb-board-page\):not\(:has\(dialog\[open\]\)\) \.toasts \{ top: auto; bottom: calc\(56px/);
    expect(CSS).toMatch(/\.tb-wait-actions \.btn \{ min-width: 88px; padding: 0 var\(--s-4\); \}/);
    expect(CSS).toMatch(/:where\(\.toasts\) \{ inset: auto; margin: 0; padding: 0; border: 0; background: none;/);
    expect(phone.length).toBeGreaterThan(0);
  });
});
