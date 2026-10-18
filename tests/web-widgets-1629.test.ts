/**
 * #1629 r4-4 (option A, the user's choice 2026-10-16): declarative widgets, drawn by the page's own components.
 * - The spec and data are closed and checked whole (web-widget.ts); the page checks them again with the same rules —
 *   one table runs through both.
 * - The tools: no target; chat_header and details only (sidebar → owner_slot); a spec is a change, data alone has its
 *   own budget; a person's placement takes the agent's values but is never replaced or removed by it; lock and the
 *   fleet switch refuse; a refused or invalid call costs nothing; what is stored is checked again on load.
 * - The routes: GET /ui/themes carries the widgets (the public link views them); a person's removal from an admin
 *   session only, refused over the public link by the handler on its own.
 * - The person's sidebar widget is a synced preference with the fleet's counts as its only binds; never on the public
 *   link or in safe mode.
 * - The page: text nodes only, no style or handler attribute, the ✦ chip always, a failing value shows "—".
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`widgets: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});
// #1778 shape: a real FleetManager's pino transport opens <AGEND_HOME>/daemon.log late, racing the scratch home's removal (ENOTEMPTY).
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});

const W = await import("../src/web-widget.js");
const { ThemeStore } = await import("../src/web-theme-store.js");
const { WebAppearance } = await import("../src/web-appearance.js");
const { AppearanceLimiter } = await import("../src/web-appearance-policy.js");
const { parseWebPrefsPatch } = await import("../src/web-prefs.js");

const dirs: string[] = [];
let pg: AppPage | null = null;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); if (pg) { pg.restore(); pg = null; } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-widgets-")); dirs.push(d); return d; };

const SPEC = { v: 1, title: "Build", items: [
  { type: "progress", label: "Tests", key: "tests" },
  { type: "badge", label: "State", bind: "state", tones: { working: "info", needs: "warn" } },
  { type: "stat", label: "Cost", bind: "cost_usd" },
  { type: "text", key: "note" },
] };
const DETAILS = { v: 1, title: "Today", items: [
  { type: "list", label: "Done", key: "done" },
  { type: "spark", label: "Tokens", key: "tokens" },
  { type: "stat", label: "PRs", key: "prs", unit: "open" },
] };

/** [description, slot, spec, ok] — run through the host's checker and the page's alike. */
const SPEC_TABLE: Array<[string, "chat_header" | "details" | "sidebar", unknown, boolean]> = [
  ["a valid header spec", "chat_header", SPEC, true],
  ["a valid details spec", "details", DETAILS, true],
  ["an unknown top-level key", "details", { ...DETAILS, html: "<b>x</b>" }, false],
  ["v 2", "details", { ...DETAILS, v: 2 }, false],
  ["no title", "details", { v: 1, items: DETAILS.items }, false],
  ["a 25-character title", "details", { ...DETAILS, title: "x".repeat(25) }, false],
  ["a bidi override in the title", "details", { ...DETAILS, title: "Bu‮ild" }, false],
  ["no items", "details", { ...DETAILS, items: [] }, false],
  ["9 items in details", "details", { ...DETAILS, items: Array.from({ length: 9 }, (_, i) => ({ type: "stat", label: `s${i}`, key: `k${i}` })) }, false],
  ["8 items in details", "details", { ...DETAILS, items: Array.from({ length: 8 }, (_, i) => ({ type: "stat", label: `s${i}`, key: `k${i}` })) }, true],
  ["5 items in the chat header", "chat_header", { ...SPEC, items: Array.from({ length: 5 }, (_, i) => ({ type: "stat", label: `s${i}`, key: `k${i}` })) }, false],
  ["a list in the chat header", "chat_header", { ...SPEC, items: [{ type: "list", key: "a" }] }, false],
  ["a spark in the chat header", "chat_header", { ...SPEC, items: [{ type: "spark", label: "x", key: "a" }] }, false],
  ["an unknown item type", "details", { ...DETAILS, items: [{ type: "html", key: "a" }] }, false],
  ["an unknown item key (onclick)", "details", { ...DETAILS, items: [{ type: "stat", label: "x", key: "a", onclick: "alert(1)" }] }, false],
  ["a style key", "details", { ...DETAILS, items: [{ type: "stat", label: "x", key: "a", style: "color:red" }] }, false],
  ["a unit on a text", "details", { ...DETAILS, items: [{ type: "text", key: "a", unit: "x" }] }, false],
  ["key and bind both", "details", { ...DETAILS, items: [{ type: "stat", label: "x", key: "a", bind: "cost_usd" }] }, false],
  ["neither key nor bind", "details", { ...DETAILS, items: [{ type: "stat", label: "x" }] }, false],
  ["a stat with no label", "details", { ...DETAILS, items: [{ type: "stat", key: "a" }] }, false],
  ["a text with no label", "details", { ...DETAILS, items: [{ type: "text", key: "a" }] }, true],
  ["a key with a capital", "details", { ...DETAILS, items: [{ type: "text", key: "Abc" }] }, false],
  ["the key __proto__", "details", { ...DETAILS, items: [{ type: "text", key: "__proto__" }] }, false],
  ["a fleet bind in details", "details", { ...DETAILS, items: [{ type: "stat", label: "x", bind: "fleet.working" }] }, false],
  ["a fleet bind in the sidebar", "sidebar", { ...DETAILS, items: [{ type: "stat", label: "x", bind: "fleet.working" }] }, true],
  ["the instance's cost in the sidebar", "sidebar", { ...DETAILS, items: [{ type: "stat", label: "x", bind: "cost_usd" }] }, false],
  ["state on a progress", "details", { ...DETAILS, items: [{ type: "progress", label: "x", bind: "state" }] }, false],
  ["an unknown bind", "details", { ...DETAILS, items: [{ type: "stat", label: "x", bind: "other.cost" }] }, false],
  ["a 9-character unit", "details", { ...DETAILS, items: [{ type: "stat", label: "x", key: "a", unit: "x".repeat(9) }] }, false],
  ["max 0", "details", { ...DETAILS, items: [{ type: "progress", label: "x", key: "a", max: 0 }] }, false],
  ["max 50", "details", { ...DETAILS, items: [{ type: "progress", label: "x", key: "a", max: 50 }] }, true],
  ["an unknown tone", "details", { ...DETAILS, items: [{ type: "badge", key: "a", tone: "red" }] }, false],
  ["a tone colour value", "details", { ...DETAILS, items: [{ type: "badge", key: "a", tones: { ok: "#ff0000" } }] }, false],
  ["9 tones", "details", { ...DETAILS, items: [{ type: "badge", key: "a", tones: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`v${i}`, "ok"])) }] }, false],
  ["empty tones", "details", { ...DETAILS, items: [{ type: "badge", key: "a", tones: {} }] }, false],
  ["items not a list", "details", { ...DETAILS, items: { 0: DETAILS.items[0] } }, false],
  ["a slot that does not exist", "details", null, false],
];

describe("the spec and data (web-widget.ts)", () => {
  it.each(SPEC_TABLE)("%s", (_d, slot, spec, ok) => {
    expect(W.checkWidgetSpec(spec, slot).ok).toBe(ok);
  });
  it("a spec over 2048 bytes is refused; the canonical spec keeps only known fields, NFC", () => {
    const big = { v: 1, title: "x", items: Array.from({ length: 8 }, (_, i) => ({ type: "badge", key: `k${i}`, tones: Object.fromEntries(Array.from({ length: 8 }, (_, j) => [`${"y".repeat(20)}${j}`, "ok"])) })) };
    expect(W.checkWidgetSpec(big, "details")).toMatchObject({ ok: false, errors: [{ path: "spec", problem: "at most 2048 bytes" }] });
    const r = W.checkWidgetSpec({ v: 1, title: "Café", items: [{ type: "text", key: "a" }] }, "details");
    expect(r).toEqual({ ok: true, value: { v: 1, title: "Café", items: [{ type: "text", key: "a" }] } });
  });
  it("data: closed to the spec's keys, each value fitting every item that shows it", () => {
    const spec = (W.checkWidgetSpec(DETAILS, "details") as { value: any }).value;
    const ok = (d: unknown) => W.checkWidgetData(d, spec).ok;
    expect(ok({ done: ["a", "b"], tokens: [1, 2, 3], prs: 2 })).toBe(true);
    expect(ok({ prs: "two" })).toBe(true);                                      // a stat shows a short word too
    expect(ok({ other: 1 })).toBe(false);                                       // no item shows it
    expect(ok({ done: Array(7).fill("x") })).toBe(false);
    expect(ok({ done: ["x".repeat(61)] })).toBe(false);
    expect(ok({ done: [] })).toBe(false);
    expect(ok({ tokens: [1] })).toBe(false);
    expect(ok({ tokens: Array(49).fill(1) })).toBe(false);
    expect(ok({ prs: Number.NaN })).toBe(false);
    expect(ok({ prs: Number.POSITIVE_INFINITY })).toBe(false);
    expect(ok({ prs: 1e16 })).toBe(false);
    expect(ok({ prs: "x".repeat(25) })).toBe(false);
    expect(ok({ prs: "<img src=x onerror=alert(1)>" })).toBe(false);            // over 24 characters
    expect(ok({ prs: { toString: "x" } })).toBe(false);
    expect(ok(JSON.parse('{"__proto__": 1}'))).toBe(false);
    expect(ok([1])).toBe(false);
    const header = (W.checkWidgetSpec(SPEC, "chat_header") as { value: any }).value;
    expect(W.checkWidgetData({ tests: "50%" }, header).ok, "a progress takes a number only").toBe(false);
    expect(W.checkWidgetData({ note: "x".repeat(121) }, header).ok).toBe(false);
    expect(W.checkWidgetData({ note: "line\nbreak" }, header).ok).toBe(false);
  });
  it("data over 4096 bytes is refused", () => {
    const spec = (W.checkWidgetSpec({ v: 1, title: "x", items: Array.from({ length: 8 }, (_, i) => ({ type: "list", key: `k${i}` })) }, "details") as { value: any }).value;
    const data = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, Array(6).fill("🙂".repeat(30))]));
    expect(W.checkWidgetData(data, spec)).toMatchObject({ ok: false, errors: [{ path: "data", problem: "at most 4096 bytes" }] });
  });
  it("merge: null removes a key, the rest is checked whole; carry keeps what still fits a new spec", () => {
    const spec = (W.checkWidgetSpec(DETAILS, "details") as { value: any }).value;
    const merged = W.mergeWidgetData({ prs: 2, done: ["a"] }, { prs: null, tokens: [1, 2] }, spec);
    expect(merged.ok && { ...merged.value }).toEqual({ done: ["a"], tokens: [1, 2] });
    expect(W.mergeWidgetData({ prs: 2 }, { prs: [1] }, spec).ok).toBe(false);
    const next = (W.checkWidgetSpec({ v: 1, title: "x", items: [{ type: "list", key: "prs" }, { type: "text", key: "done" }] }, "details") as { value: any }).value;
    expect({ ...W.carryWidgetData({ prs: 2, done: "a" }, next) }).toEqual({ done: "a" });
  });
});

function tools(opts: { agentEdit?: boolean } = {}) {
  const dir = tmp();
  let now = 1_000_000;
  const clock = () => now;
  const store = new ThemeStore(dir);
  let changed = 0;
  const web = { themes: { agent_edit: opts.agentEdit ?? true } };
  const app = new WebAppearance(store, () => web, () => { changed++; }, new AppearanceLimiter(clock), clock);
  return { dir, store, app, web, changed: () => changed, tick: (ms: number) => { now += ms; } };
}

async function pageLoad(opts: { url?: string; storage?: Record<string, string> } = {}) {
  vi.resetModules();
  if (pg) { pg.restore(); pg = null; }
  pg = page({ url: opts.url ?? "http://127.0.0.1:19280/ui/chat/alpha", storage: opts.storage ?? {} });
  await import("/ui/js/chat-strings.js");
  const widget = await import("/assets/agent-widget.js");
  const P = await import("/assets/app-html.js");
  return { widget, P };
}

describe("set_web_widget / remove_web_widget", () => {
  it("places a spec with data in its own slot: stored, listed for the page, in get_web_theme; one change", () => {
    const t = tools();
    const r = t.app.handleTool("alpha", "set_web_widget", { slot: "chat_header", spec: SPEC, data: { tests: 40, note: "Running unit tests" } });
    expect(r).toMatchObject({ slot: "chat_header", widget: { by: "agent", data: { tests: 40, note: "Running unit tests" } } });
    expect(t.store.widgets()).toEqual({ alpha: { chat_header: { spec: SPEC, data: { tests: 40, note: "Running unit tests" }, by: "agent" } } });
    expect((t.app.getTheme("alpha") as any).widgets).toEqual({ chat_header: { spec: SPEC, data: { tests: 40, note: "Running unit tests" }, by: "agent" } });
    expect((t.app.getTheme("alpha") as any).limits).toMatchObject({ changes: 9, widget_data: 180 });
    expect(t.changed()).toBe(1);
    expect(t.store.get("beta").placements.widgets).toEqual({});
  });
  it("sidebar is the person's: owner_slot; an unknown slot: slot — and neither costs anything", () => {
    const t = tools();
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "sidebar", spec: SPEC })).toMatchObject({ error: "owner_slot" });
    expect(t.app.handleTool("alpha", "remove_web_widget", { slot: "sidebar" })).toMatchObject({ error: "owner_slot" });
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "header", spec: SPEC })).toMatchObject({ error: "slot" });
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "details" })).toMatchObject({ error: "args" });
    expect((t.app.getTheme("alpha") as any).limits.changes).toBe(10);
    expect(t.changed()).toBe(0);
  });
  it("an invalid spec or data: errors, nothing stored, nothing counted", () => {
    const t = tools();
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "chat_header", spec: { ...SPEC, items: [{ type: "list", key: "a" }] } })).toHaveProperty("errors");
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "chat_header", spec: SPEC, data: { tests: "lots" } })).toHaveProperty("errors");
    expect([t.store.widgets(), (t.app.getTheme("alpha") as any).limits.changes]).toEqual([{}, 10]);
  });
  it("data alone: merged into the placed widget, its own budget (10 s apart), never the theme's changes", () => {
    const t = tools();
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "details", data: { prs: 1 } })).toMatchObject({ error: "no_widget" });
    t.app.handleTool("alpha", "set_web_widget", { slot: "details", spec: DETAILS, data: { prs: 1, done: ["a"] } });
    const r = t.app.handleTool("alpha", "set_web_widget", { slot: "details", data: { prs: 2, done: null } });
    expect(r).toMatchObject({ widget: { data: { prs: 2 } } });
    expect((r as any).widget.data).toEqual({ prs: 2 });
    const limits = (t.app.getTheme("alpha") as any).limits;
    expect([limits.changes, limits.widget_data, limits.widget_data_retry_after_s]).toEqual([9, 179, 10]);
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "details", data: { prs: 3 } })).toMatchObject({ error: "rate_limited", retry_after_s: 10 });
    t.tick(10_000);
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "details", data: { prs: [1] } }), "checked against the placed spec").toHaveProperty("errors");
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "details", data: { prs: 3 } }), "an invalid call cost nothing").toMatchObject({ widget: { data: { prs: 3 } } });
    t.tick(10_000);
    expect((t.app.handleTool("alpha", "set_web_widget", { slot: "details", data: { tokens: [1, 2] } }) as any).widget.data, "a key not named stays").toEqual({ prs: 3, tokens: [1, 2] });
  });
  it("a new spec keeps the values that still fit; the same spec again keeps its first placement", () => {
    const t = tools();
    t.app.handleTool("alpha", "set_web_widget", { slot: "details", spec: DETAILS, data: { prs: 4, done: ["a"] } });
    const at = t.store.get("alpha").placements.widgets.details!.at;
    t.tick(31_000);
    const r = t.app.handleTool("alpha", "set_web_widget", { slot: "details", spec: { v: 1, title: "Now", items: [{ type: "stat", label: "PRs", key: "prs" }, { type: "text", key: "done" }] } });
    expect((r as any).widget.data).toEqual({ prs: 4 });
    t.tick(31_000);
    t.app.handleTool("alpha", "set_web_widget", { slot: "details", spec: DETAILS });
    const again = t.store.get("alpha").placements.widgets.details!;
    expect(again.at, "a different spec in between: a new placement").not.toBe(at);
    t.tick(31_000);
    t.app.handleTool("alpha", "set_web_widget", { slot: "details", spec: DETAILS, data: { prs: 9 } });
    const same = t.store.get("alpha").placements.widgets.details!;
    expect([same.id, same.at, same.data]).toEqual([again.id, again.at, { prs: 9 }]);
  });
  it("a person's placement: the agent may give it values, never replace or remove it", () => {
    const t = tools();
    const spec = (W.checkWidgetSpec(DETAILS, "details") as { value: any }).value;
    expect(t.store.setWidget("alpha", "details", spec, {}, "human").ok).toBe(true);
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "details", spec: SPEC })).toMatchObject({ error: "person_placed" });
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "details", data: { prs: 5 } })).toMatchObject({ widget: { by: "human", data: { prs: 5 } } });
    expect(t.app.handleTool("alpha", "remove_web_widget", { slot: "details" })).toMatchObject({ error: "person_placed" });
    t.app.handleTool("alpha", "set_web_widget", { slot: "chat_header", spec: SPEC });
    t.tick(31_000);
    expect(t.app.handleTool("alpha", "remove_web_widget", {})).toMatchObject({ removed: ["chat_header"], kept: ["details"] });
    expect(Object.keys(t.store.get("alpha").placements.widgets)).toEqual(["details"]);
    expect(t.app.humanRemoveWidget("alpha", "details")).toMatchObject({ ok: true, removed: ["details"] });
    expect(t.store.get("alpha").placements.widgets).toEqual({});
    expect(t.app.humanRemoveWidget("alpha", "sidebar")).toMatchObject({ error: "slot", status: 400 });
  });
  it("remove with nothing placed: removed [] and nothing counted", () => {
    const t = tools();
    expect(t.app.handleTool("alpha", "remove_web_widget", {})).toEqual({ removed: [] });
    expect([(t.app.getTheme("alpha") as any).limits.changes, t.changed()]).toEqual([10, 0]);
  });
  it("a person's lock and the fleet switch refuse every widget write (data too)", () => {
    const t = tools();
    t.app.handleTool("alpha", "set_web_widget", { slot: "details", spec: DETAILS });
    t.store.setLocked("alpha", true);
    t.tick(31_000);
    for (const [tool, args] of [["set_web_widget", { slot: "details", spec: DETAILS }], ["set_web_widget", { slot: "details", data: { prs: 1 } }], ["remove_web_widget", {}]] as const) {
      expect(t.app.handleTool("alpha", tool, args), tool).toMatchObject({ error: "locked" });
    }
    t.store.setLocked("alpha", false);
    t.web.themes.agent_edit = false;
    expect(t.app.handleTool("alpha", "set_web_widget", { slot: "details", data: { prs: 1 } })).toMatchObject({ error: "theme_editing_off" });
  });
  it("stored widgets are checked again on load: a tampered spec, data or id is dropped; a person's reset clears them, the agent's keeps them", () => {
    const t = tools();
    t.app.handleTool("alpha", "set_web_widget", { slot: "details", spec: DETAILS, data: { prs: 1 } });
    t.tick(31_000);
    t.app.handleTool("alpha", "set_web_widget", { slot: "chat_header", spec: SPEC });
    expect(Object.keys(new ThemeStore(t.dir).widgets().alpha!)).toEqual(["chat_header", "details"]);
    const path = join(t.dir, "web-themes.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.instances.alpha.placements.widgets.details.data.prs = [1];
    doc.instances.alpha.placements.widgets.chat_header.spec.title = "Tampered";
    writeFileSync(path, JSON.stringify(doc));
    expect(new ThemeStore(t.dir).widgets()).toEqual({});
    doc.instances.alpha.placements.widgets.details.data.prs = 2;
    doc.instances.alpha.placements.widgets.chat_header.spec.title = SPEC.title;
    writeFileSync(path, JSON.stringify(doc));
    const fresh = new ThemeStore(t.dir);
    expect(Object.keys(fresh.widgets().alpha!)).toEqual(["chat_header", "details"]);
    fresh.reset("alpha", "agent");
    expect(Object.keys(fresh.widgets().alpha!)).toEqual(["chat_header", "details"]);
    fresh.reset("alpha", "human");
    expect(fresh.widgets()).toEqual({});
  });
});

/** [type, value, fits] — run through the host's valueFits and the page's alike (#1894 review P3). */
const VALUE_TABLE: Array<[string, unknown, boolean]> = [
  ["stat", 3, true], ["stat", "x".repeat(24), true], ["stat", "x".repeat(25), false], ["stat", 1e15, true], ["stat", 1e15 + 2, false], ["stat", -1e15, true],
  ["progress", 50, true], ["progress", "50", false], ["progress", Number.NaN, false],
  ["text", "x".repeat(120), true], ["text", "x".repeat(121), false], ["text", " pad", false], ["text", "\u200b", false], ["text", "a\nb", false], ["text", "bi\u202edi", false],
  ["badge", "ok", true], ["badge", "x".repeat(25), false],
  ["list", ["a"], true], ["list", Array(6).fill("a"), true], ["list", Array(7).fill("a"), false], ["list", [], false], ["list", ["x".repeat(61)], false], ["list", "a", false],
  ["spark", [1, 2], true], ["spark", [1], false], ["spark", Array(48).fill(1), true], ["spark", Array(49).fill(1), false], ["spark", [1, "2"], false],
];

describe("values: one table, the host and the page (#1894 review)", () => {
  it.each(VALUE_TABLE)("host: %s %j → %s", (type, v, ok) => { expect(W.valueFits(type as never, v)).toBe(ok); });
  it("a key two items show must fit both", () => {
    const spec = (W.checkWidgetSpec({ v: 1, title: "x", items: [{ type: "stat", label: "a", key: "k" }, { type: "progress", label: "b", key: "k" }] }, "details") as { value: any }).value;
    expect([W.checkWidgetData({ k: 5 }, spec).ok, W.checkWidgetData({ k: "five" }, spec).ok]).toEqual([true, false]);
  });
  it("text arriving decomposed is stored NFC — and the page, which takes NFC only, draws it", async () => {
    const t = tools();
    const r = t.app.handleTool("alpha", "set_web_widget", { slot: "details", spec: { v: 1, title: "Cafe\u0301", items: [{ type: "text", key: "t" }] }, data: { t: "Cafe\u0301 au lait" } }) as any;
    expect([r.widget.spec.title, r.widget.data.t]).toEqual(["Caf\u00e9", "Caf\u00e9 au lait"]);
    const { widget } = await pageLoad();
    expect(widget.lineOk("Cafe\u0301", 24), "the page refuses what is not NFC").toBe(false);
    const w = widget.checkWidget("details", t.store.widgets().alpha!.details);
    expect([w?.title, w?.data.get("0")]).toEqual(["Caf\u00e9", "Caf\u00e9 au lait"]);
  });
  it.each(VALUE_TABLE)("page: %s %j → %s", async (type, v, ok) => {
    const { widget } = await pageLoad();
    expect(widget.valueFits(type, v)).toBe(ok);
  });
});

describe("limits and leftovers (#1894 review)", () => {
  it("data: at most 180 an hour; an instance removed takes its counts with it", () => {
    let now = 0;
    const l = new AppearanceLimiter(() => now);
    for (let i = 0; i < 180; i++) { expect(l.check("a", ["data"]).ok, `#${i}`).toBe(true); l.record("a", ["data"]); now += 10_000; }
    expect(l.check("a", ["data"])).toMatchObject({ ok: false, error: "rate_limited" });
    l.forget("a");
    expect([l.check("a", ["data"]).ok, l.remaining("a").widget_data]).toEqual([true, 180]);
  });
  it("load keeps only what it checked: an extra stored field is dropped", () => {
    const t = tools();
    t.app.handleTool("alpha", "set_web_widget", { slot: "details", spec: DETAILS, data: { prs: 1 } });
    const path = join(t.dir, "web-themes.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.instances.alpha.placements.widgets.details.evil = "<script>";
    doc.instances.alpha.placements.widgets.details.spec.items[0].onclick = "x";
    writeFileSync(path, JSON.stringify(doc));
    const w = new ThemeStore(t.dir).get("alpha").placements.widgets;
    expect(w.details, "a spec with an unknown item key is not loaded").toBeUndefined();
    delete doc.instances.alpha.placements.widgets.details.spec.items[0].onclick;
    writeFileSync(path, JSON.stringify(doc));
    expect(Object.keys(new ThemeStore(t.dir).get("alpha").placements.widgets.details!).sort()).toEqual(["at", "by", "data", "id", "spec"]);
  });
  it("a person's removal of an empty slot writes nothing and announces nothing", () => {
    const t = tools();
    const rev = t.store.rev();
    expect(t.app.humanRemoveWidget("alpha", "details")).toMatchObject({ ok: true, removed: [], rev });
    expect([t.store.rev(), t.changed()]).toEqual([rev, 0]);
  });
});

describe("placedEffects (the effect library's reference source, for B2)", () => {
  it("every instance's placed effect ids; none when nothing is placed", () => {
    const t = tools();
    expect(t.store.placedEffects()).toEqual([]);
    const a = "a".repeat(32), b = "b".repeat(32);
    t.store.setPlacements("alpha", { effects: [a, b] }, "agent", () => null);
    t.store.setPlacements("beta", { effects: [] }, "agent", () => null);
    expect(t.store.placedEffects()).toEqual([{ name: "alpha", ids: [a, b] }]);
  });
});

describe("setPlacements: an id keeps its placement, { id, params } is an explicit apply (for B2, agreed with Sol)", () => {
  const A = "a".repeat(32), Bid = "b".repeat(32);
  it("an id keeps its entry as it was; an object stamps this call's by/at and its params, even for an id already placed", () => {
    const t = tools();
    t.store.setPlacements("alpha", { effects: [{ id: A, params: { count: 4 } }] }, "human", () => null);
    const human = t.store.get("alpha").placements.effects[0]!;
    expect(human).toMatchObject({ id: A, by: "human", params: { count: 4 } });
    t.tick(1000);
    t.store.setPlacements("alpha", { effects: [A, { id: Bid }] }, "agent", () => null);
    const [kept, added] = t.store.get("alpha").placements.effects;
    expect([kept, added]).toEqual([human, { id: Bid, by: "agent", at: expect.any(Number) }]);
    t.tick(1000);
    t.store.setPlacements("alpha", { effects: [{ id: A }] }, "agent", () => null);
    expect(t.store.get("alpha").placements.effects, "an agent re-applying a person's placement never keeps by: human").toEqual([{ id: A, by: "agent", at: expect.any(Number) }]);
  });
  it("effects no longer placed after a write that held go to effectsDropped (B2's collector); a failed write reports none", () => {
    const dir = tmp();
    const dropped: string[][] = [];
    const store = new ThemeStore(dir, { effectsDropped: ids => dropped.push(ids) });
    store.setPlacements("alpha", { effects: [A, Bid] }, "agent", () => null);
    store.setPlacements("alpha", { effects: [Bid] }, "agent", () => null);
    store.setTheme("alpha", { v: 1, font: "mono" }, "agent");
    store.reset("alpha", "human");
    expect(dropped).toEqual([[A], [Bid]]);
    store.setPlacements("alpha", { effects: [A] }, "agent", () => null);
    rmSync(join(dir, "web-themes.json")); mkdirSync(join(dir, "web-themes.json"));
    const fresh = new ThemeStore(dir, { effectsDropped: ids => dropped.push(ids) });
    expect(fresh.setPlacements("alpha", { effects: [] }, "agent", () => null).ok).toBe(false);
    expect(dropped).toHaveLength(2);
  });
  it("validate sees the params; a refusal, a bad shape or a repeat writes nothing", () => {
    const t = tools();
    const seen: unknown[] = [];
    expect(t.store.setPlacements("alpha", { effects: [{ id: A, params: { n: 99 } }] }, "agent", w => { seen.push(w); return "invalid_params"; })).toMatchObject({ ok: false, error: "invalid_params" });
    expect(seen).toEqual([{ kind: "effect", id: A, params: { n: 99 } }]);
    const bad: unknown[] = [[{ id: A, params: [1] }], [{ id: A, extra: 1 }], [{ id: "x" }], [A, { id: A }], [A, Bid, "c".repeat(32)]];
    for (const effects of bad) expect(t.store.setPlacements("alpha", { effects } as never, "agent", () => null).ok, JSON.stringify(effects)).toBe(false);
    expect(t.store.get("alpha").placements.effects).toEqual([]);
  });
});

describe("the person's sidebar widget (widget.sidebar)", () => {
  const SIDE = { v: 1, title: "Fleet", items: [{ type: "stat", label: "Working", bind: "fleet.working" }, { type: "text", key: "motto" }] };
  it("a synced preference, checked as an agent's is, with the fleet's counts as its only binds", () => {
    const r = parseWebPrefsPatch({ "widget.sidebar": { spec: SIDE, data: { motto: "Ship it" } } });
    expect(r).toMatchObject({ ok: true });
    expect((r as { patch: Map<string, unknown> }).patch.get("widget.sidebar")).toEqual({ spec: SIDE, data: { motto: "Ship it" } });
    expect(parseWebPrefsPatch({ "widget.sidebar": { spec: { ...SIDE, items: [{ type: "stat", label: "x", bind: "cost_usd" }] }, data: {} } }).ok).toBe(false);
    expect(parseWebPrefsPatch({ "widget.sidebar": { spec: SIDE, data: { other: 1 } } }).ok).toBe(false);
    expect(parseWebPrefsPatch({ "widget.sidebar": { spec: SIDE } }).ok).toBe(false);
    expect(parseWebPrefsPatch({ "widget.sidebar": { spec: SIDE, data: {}, css: "x" } }).ok).toBe(false);
    expect(parseWebPrefsPatch({ "widget.sidebar": null }).ok).toBe(true);
  });
});

interface Res { status: number; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}

describe("the routes", () => {
  async function fleet() {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
    const dir = tmp();
    const fm = new FleetManager(dir) as any;
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
    vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
    fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
    fm.initializeWebAuthTokens(); fm.startHealthServer(0);
    await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
    const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
    const session = (tier: "admin" | "read" = "admin") => {
      const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
      const cookie = `agend_session=${sessionId}`;
      return { id: sessionId, read: { cookie }, write: { cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" } };
    };
    const stop = () => new Promise<void>(r => (fm.healthServer as Server).close(() => r()));
    return { fm, port, session, stop, csrfTokenFor, tokenEpoch };
  }
  it("GET /ui/themes carries the widgets; a person removes one from an admin session only; the agent's tool goes through the fleet", async () => {
    const f = await fleet();
    try {
      expect(f.fm.handleWebThemeHttp("alpha", "set_web_widget", { slot: "details", spec: DETAILS, data: { prs: 1 } })).resolves.toMatchObject({ slot: "details" });
      await settle();
      const r = JSON.parse((await raw(f.port, "GET", "/ui/themes", f.session("read").read)).body);
      expect(r.widgets).toEqual({ alpha: { details: { spec: DETAILS, data: { prs: 1 }, by: "agent" } } });
      const post = (headers: Record<string, string>, body: unknown) => raw(f.port, "POST", "/ui/themes/alpha/widget", headers, JSON.stringify(body));
      expect((await post(f.session("read").write, { slot: "details" })).status).toBe(403);
      expect((await post(f.session("admin").write, { slot: "sidebar" })).status).toBe(400);
      expect(JSON.parse((await post(f.session("admin").write, { slot: "details" })).body)).toMatchObject({ ok: true, removed: ["details"] });
      expect(f.fm.themeStore.widgets()).toEqual({});
    } finally { await f.stop(); }
  }, 30_000);
  it("the public link: the removal is off its manifest and refused by the handler on its own", async () => {
    const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
    const { handleWebRequest } = await import("../src/web-api.js");
    const { bindGatewayRequest } = await import("../src/web-request-context.js");
    expect([isPublicWebRoute("GET", "/ui/themes"), isPublicWebRoute("POST", "/ui/themes/a/widget")]).toEqual([true, false]);
    const f = await fleet();
    try {
      f.fm.handleWebThemeHttp("alpha", "set_web_widget", { slot: "details", spec: DETAILS });
      const { sessionId } = f.fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "t", tokenEpoch: f.tokenEpoch(f.fm.webToken) });
      const status = await new Promise<number>(resolve => {
        let code = 0;
        const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { code = c; res.headersSent = true; return res; }, end() { resolve(code); } };
        const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/themes/alpha/widget", headers: { host: "x.trycloudflare.com", cookie: `__Host-agend_session=${sessionId}`, origin: "https://x.trycloudflare.com", "x-agend-csrf": f.csrfTokenFor(sessionId), "content-type": "application/json" }, destroy() {}, resume() {} });
        bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
        expect(handleWebRequest(req as never, res, new URL("https://x.trycloudflare.com/ui/themes/alpha/widget"), f.fm)).toBe(true);
      });
      expect([status, Object.keys(f.fm.themeStore.widgets().alpha ?? {})]).toEqual([403, ["details"]]);
    } finally { await f.stop(); }
  }, 30_000);
  it("the removal asks again once the body is in: a session revoked meanwhile removes nothing (#1894 review)", async () => {
    const f = await fleet();
    try {
      await f.fm.handleWebThemeHttp("alpha", "set_web_widget", { slot: "details", spec: DETAILS });
      const s = f.session("admin");
      const body = JSON.stringify({ slot: "details" });
      const status = await new Promise<number>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port: f.port, method: "POST", path: "/ui/themes/alpha/widget", headers: { ...s.write, "content-length": String(Buffer.byteLength(body)) } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
        r.on("error", reject);
        r.flushHeaders();
        setTimeout(() => { f.fm.webSessions.revokeById(s.id); r.end(body); }, 150);
      });
      expect([status, Object.keys(f.fm.themeStore.widgets().alpha ?? {})]).toEqual([401, ["details"]]);
    } finally { await f.stop(); }
  }, 30_000);
  it("get_web_appearance lists the placed widgets", async () => {
    const f = await fleet();
    try {
      await f.fm.handleWebThemeHttp("alpha", "set_web_widget", { slot: "details", spec: DETAILS, data: { prs: 1 } });
      const a = await f.fm.handleWebThemeHttp("alpha", "get_web_appearance", {});
      expect(a.widgets).toEqual([{ slot: "details", by: "agent", spec: DETAILS, data: { prs: 1 } }]);
    } finally { await f.stop(); }
  }, 30_000);
});

describe("the wiring", () => {
  it("both tools: IPC, the agent endpoint, worker and standard profiles — and general (#2132); no target in either schema", async () => {
    const perms = await import("../src/tool-permissions.js");
    const schemas = await import("../src/outbound-schemas.js");
    for (const tool of ["set_web_widget", "remove_web_widget"]) {
      expect(perms.TOOL_PROFILES.worker, tool).toContain(tool);
      expect(perms.TOOL_PROFILES.standard, tool).toContain(tool);
      expect(perms.TOOL_PROFILES.general, tool).toContain(tool);
      expect(Object.values(perms.IPC_TYPE_TOOLS)).toContain(tool);
      expect(Object.values(perms.EARLY_AGENT_OP_TOOLS)).toContain(tool);
    }
    for (const s of [schemas.SetWebWidgetArgs, schemas.RemoveWebWidgetArgs]) {
      expect(Object.keys(s.shape).filter(k => /instance|target|name/.test(k))).toEqual([]);
    }
    expect(schemas.SetWebWidgetArgs.safeParse({ slot: "sidebar", spec: {} }).success).toBe(false);
    const src = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
    expect(src).toContain('set_web_widget: "fleet_set_web_widget", remove_web_widget: "fleet_remove_web_widget"');
  });
});

describe("agend-agent widget", () => {
  it("widget set / data / remove: one op (widget-set or widget-remove) each, with the slot, spec and values as JSON", async () => {
    const { createServer } = await import("node:http");
    const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { pathToFileURL } = await import("node:url");
    const t = tools();
    const seen: Array<[string, unknown]> = [];
    const server = createServer((req, res) => { let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
      const p = JSON.parse(body); seen.push([p.op, p.args]);
      res.end(JSON.stringify(t.app.handleTool("a", p.op === "widget-remove" ? "remove_web_widget" : "set_web_widget", p.args)));
    }); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const home = tmp(), ws = tmp();
    const run = (...argv: string[]) => new Promise<{ code: number; out: string }>(resolve => execFile(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href, join(process.cwd(), "src/agent-cli.ts"), ...argv], {
      cwd: ws, env: { ...process.env, AGEND_PORT: String(port), AGEND_INSTANCE_NAME: "a", AGEND_HOME: home }, timeout: 60_000 }, (e, stdout, stderr) => resolve({ code: e ? (e as { code?: number }).code ?? 1 : 0, out: stdout + stderr })));
    try {
      const set = await run("widget", "set", "details", JSON.stringify(DETAILS), JSON.stringify({ prs: 1 }));
      expect(JSON.parse(set.out)).toMatchObject({ slot: "details", widget: { data: { prs: 1 } } });
      t.tick(10_000);
      expect(JSON.parse((await run("widget", "data", "details", JSON.stringify({ prs: 2 }))).out)).toMatchObject({ widget: { data: { prs: 2 } } });
      t.tick(31_000);
      expect(JSON.parse((await run("widget", "remove")).out)).toMatchObject({ removed: ["details"] });
      const bad = await run("widget", "set", "details", "{not json");
      expect([bad.code !== 0, bad.out]).toEqual([true, expect.stringContaining("not JSON")]);
      expect(seen).toEqual([
        ["widget-set", { slot: "details", spec: DETAILS, data: { prs: 1 } }],
        ["widget-set", { slot: "details", data: { prs: 2 } }],
        ["widget-remove", {}],
      ]);
    } finally { await new Promise(r => server.close(r)); }
  }, 120_000);
});

describe("the page", () => {
  async function load(opts: { url?: string; publicLink?: boolean; storage?: Record<string, string> } = {}) {
    vi.resetModules();
    pg = page({ url: opts.url ?? "http://127.0.0.1:19280/ui/chat/alpha", storage: opts.storage ?? {} });
    if (opts.publicLink) pg.document.body.dataset.publicLink = "1";
    await import("/ui/js/chat-strings.js");
    const widget = await import("/assets/agent-widget.js");
    const themes = await import("/assets/app-themes.js");
    const P = await import("/assets/app-html.js");
    return { widget, themes, P };
  }
  it.each(SPEC_TABLE)("the page checks as the host does: %s", async (_d, slot, spec, ok) => {
    const { widget } = await load();
    const host = W.checkWidgetSpec(spec, slot);
    expect(!!widget.checkWidget(slot, { spec: host.ok ? host.value : spec, data: {} })).toBe(ok);
  });
  it("drawn by the page's own components: text nodes, no style or handler attribute, the ✦ chip; a failing value shows —", async () => {
    const { widget, P } = await load();
    const w = widget.checkWidget("details", { spec: { ...DETAILS, items: [...DETAILS.items, { type: "text", key: "note" }, { type: "badge", key: "st", tones: { green: "ok" } }, { type: "progress", label: "Half", key: "half", max: 50 }] },
      data: { done: ["<b>bold</b>", "two"], tokens: [1, 5, 3], prs: "x".repeat(30), note: "<img src=x onerror=alert(1)>", st: "green", half: 25 } });
    P.render(P.h(widget.AgentWidget, { slot: "details", widget: w, binds: {} }), pg!.root); await settle();
    const root = pg!.root;
    expect(root.querySelector(".aw-chip")!.textContent).toBe("✦ Today");
    expect([...root.querySelectorAll(".aw-list li")].map((li: any) => li.textContent)).toEqual(["<b>bold</b>", "two"]);
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".aw-text .aw-value")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(root.querySelector(".aw-stat .aw-value")!.textContent, "a value that fails shows —").toBe("—");
    expect(root.querySelector(".aw-badge")!.className).toBe("aw-badge aw-tone-ok");
    const bar = root.querySelector("progress") as any;
    expect([String(bar.value ?? bar.getAttribute("value")), String(bar.max ?? bar.getAttribute("max"))]).toEqual(["25", "50"]);
    expect(root.querySelector("polyline")!.getAttribute("points")).toBe(widget.sparkPoints([1, 5, 3]));
    const all = [root, ...root.querySelectorAll("*")] as any[];
    for (const el of all) for (const a of el.attributes ?? []) expect(/^(style|on)/i.test(a.name), `${el.tagName} ${a.name}`).toBe(false);
  });
  it("binds: the instance's own state, context and cost; the fleet's counts for the sidebar", async () => {
    const { widget, P } = await load();
    const w = widget.checkWidget("chat_header", { spec: SPEC, data: { tests: 30 } });
    const binds = widget.instanceBinds({ name: "alpha", status: "running", context_pct: 41.6, cost: 1.5 }, "working", null);
    expect(binds).toEqual({ state: "working", context_pct: 42, cost_usd: 1.5 });
    P.render(P.h(widget.AgentWidget, { slot: "chat_header", widget: w, binds }), pg!.root); await settle();
    expect(pg!.root.querySelector(".aw-badge")!.className).toBe("aw-badge aw-tone-info");
    expect([...pg!.root.querySelectorAll(".aw-value")].map((e: any) => e.textContent)).toEqual(["30%", "$1.50", "—"]);
    expect(pg!.root.querySelector(".aw-badge")!.textContent).toBe("working");
    const none = widget.checkWidget("details", { spec: { v: 1, title: "x", items: [{ type: "progress", label: "Ctx", bind: "context_pct" }] }, data: {} });
    P.render(P.h(widget.AgentWidget, { slot: "details", widget: none, binds: {} }), pg!.root); await settle();
    expect([pg!.root.querySelector("progress"), pg!.root.querySelector(".aw-progress .aw-value")!.textContent], "no value: no (animated) bar, only —").toEqual([null, "—"]);
    const counts = widget.fleetBinds([{ name: "a", status: "running" }, { name: "b", status: "running" }, { name: "c", status: "stopped" }, { name: "d", status: "crashed" }, { name: "e", status: "running" }],
      { a: "working" }, { e: { kind: "permission" } });
    expect(counts).toEqual({ "fleet.idle": 1, "fleet.working": 1, "fleet.needs_you": 1, "fleet.stopped": 2 });
  });
  it("the page clamps what it draws: a progress past its max is 100%, context 0..100; an unknown `by` is the agent's (#1894 review)", async () => {
    const { widget, P } = await load();
    const w = widget.checkWidget("details", { spec: { v: 1, title: "x", items: [{ type: "progress", label: "p", key: "p", max: 50 }] }, data: { p: 75 }, by: "robot" });
    expect(w.by).toBe("agent");
    P.render(P.h(widget.AgentWidget, { slot: "details", widget: w, binds: {} }), pg!.root); await settle();
    expect(pg!.root.querySelector(".aw-progress .aw-value")!.textContent).toBe("100%");
    expect(pg!.root.querySelector(".aw-by")).toBeNull();
    expect(widget.instanceBinds({ name: "a", status: "running", context_pct: 140 }, null, null).context_pct).toBe(100);
    expect(widget.instanceBinds({ name: "a", status: "running", context_pct: -3 }, null, null).context_pct).toBe(0);
    expect(widget.checkWidget("details", { spec: { v: 1, title: "x", items: [{ type: "text", key: "t" }] }, data: {}, by: "human" }).by).toBe("human");
  });
  it("the editor's own check: exactly { spec, data }, and the 4096-byte data bound (#1894 review)", async () => {
    const { widget } = await load();
    const spec = { v: 1, title: "F", items: ["l", "m", "n"].map(key => ({ type: "list", key })) };
    expect(widget.widgetProblem("sidebar", { spec, data: {}, extra: 1 })).toBe('{ "spec": …, "data": … }');
    const lines = Array(6).fill("🙂".repeat(60));                   // 1440 bytes a list: three are over 4096
    expect(widget.widgetProblem("sidebar", { spec, data: { l: lines, m: lines } })).toBeNull();
    expect(widget.widgetProblem("sidebar", { spec, data: { l: lines, m: lines, n: lines } })).toBe("data: at most 4096 bytes");
    expect(widget.widgetProblem("sidebar", { spec, data: { l: ["ok"] } })).toBeNull();
  });
  it("an agent's widget is shown only with agents' looks shown: not with the switch off, not in safe mode", async () => {
    let { widget, themes } = await load();
    themes.themesStore.set({ widgets: { alpha: { details: { spec: DETAILS, data: {}, by: "agent" } } }, shown: true });
    expect(widget.widgetFor("alpha", "details")?.title).toBe("Today");
    expect(widget.widgetFor("alpha", "chat_header")).toBeNull();
    expect(widget.widgetFor("beta", "details")).toBeNull();
    ({ widget, themes } = await load({ storage: { agend_fx_show: "off" } }));
    themes.themesStore.set({ widgets: { alpha: { details: { spec: DETAILS, data: {}, by: "agent" } } }, shown: true });
    expect(widget.widgetFor("alpha", "details")).toBeNull();
    ({ widget, themes } = await load({ url: "http://127.0.0.1:19280/ui/chat/alpha?safe=1" }));
    themes.themesStore.set({ widgets: { alpha: { details: { spec: DETAILS, data: {}, by: "agent" } } }, shown: true });
    expect(widget.widgetFor("alpha", "details")).toBeNull();
  });
  it("the sidebar widget: the person's; never on the public link or in safe mode; the editor says why before saving", async () => {
    const SIDE = { spec: { v: 1, title: "Fleet", items: [{ type: "stat", label: "Working", bind: "fleet.working" }] }, data: {} };
    let { widget } = await load({ storage: { agend_widget_sidebar: JSON.stringify(SIDE) } });
    expect(widget.sidebarWidget()?.title).toBe("Fleet");
    ({ widget } = await load({ publicLink: true, storage: { agend_widget_sidebar: JSON.stringify(SIDE) } }));
    expect(widget.sidebarWidget()).toBeNull();
    ({ widget } = await load({ url: "http://127.0.0.1:19280/ui?safe=1", storage: { agend_widget_sidebar: JSON.stringify(SIDE) } }));
    expect(widget.sidebarWidget()).toBeNull();
    expect(widget.widgetProblem("sidebar", SIDE)).toBeNull();
    expect(widget.widgetProblem("sidebar", { ...SIDE, data: { other: 1 } })).toBe("data.other: no item shows this key");
    expect(widget.widgetProblem("sidebar", { spec: { ...SIDE.spec, items: [{ type: "stat", label: "x", bind: "cost_usd" }] }, data: {} })).toBe("spec.items.0.bind: fleet.idle, fleet.working, fleet.needs_you, fleet.stopped");
    expect(widget.widgetProblem("sidebar", { spec: SIDE.spec })).toContain("spec");
  });
  it("a person's Remove for each placed widget, in the theme menu — none over the public link", async () => {
    let { themes } = await load();
    themes.themesStore.set({ widgets: { alpha: { chat_header: { spec: SPEC, data: {}, by: "agent" } } } });
    expect(themes.themeMenuItems("alpha").map((i: { key: string }) => i.key)).toEqual(["widget-remove-chat_header", "theme-lock", "theme-reset"]);
    const calls: Array<[string, string]> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => { calls.push([url, init.body ?? ""]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; });
    await themes.themeMenuItems("alpha")[0].onSelect();
    expect(calls).toEqual([["/ui/themes/alpha/widget", JSON.stringify({ slot: "chat_header" })]]);
    ({ themes } = await load({ publicLink: true }));
    themes.themesStore.set({ widgets: { alpha: { chat_header: { spec: SPEC, data: {}, by: "agent" } } } });
    expect(themes.themeMenuItems("alpha")).toEqual([]);
  });
});
