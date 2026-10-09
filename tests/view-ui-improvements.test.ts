/**
 * View's roster and card, as the app shell renders them (#1408 step 2; ported from view.html's UI-improvement checks):
 * the backend icon after the context figure, 0% shown as 0% (not hidden), the backend labels in tooltips and icons, the
 * sidebar order saved in this browser only, the usage providers reordered with no token, the localized failure text,
 * and the classic-to-configured wording in tooltips.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

type View = typeof import("/assets/panel-view.js");
const g = globalThis as any;
const appCss = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf-8");
const viewStrings = readFileSync(join(process.cwd(), "src", "ui", "shared", "view-strings.js"), "utf-8");

let p: AppPage;
let view: View;
let shell: typeof import("/assets/app-shell.js");
let nav: typeof import("/assets/instance-nav.js");
let i18n: typeof import("/assets/app-i18n.js");
let useStore: typeof import("/assets/app-store.js")["useStore"];
let roster: Array<Record<string, unknown>> = [];
let ai: unknown = { providers: [], fetchedAt: 0 };
let aiStatus = 200;
let paneStatus = 200;
let requests: Array<{ url: string; method: string; body?: string }> = [];

const BACKENDS = ["claude-code", "kiro-cli", "codex", "grok", "antigravity", "opencode"];
const base = (over: Record<string, unknown>) => ({ instance_name: "alpha", display_name: null, status: "running", context_pct: 40, model: "m1",
  backend: "codex", tags: ["AgEnD"], has_avatar: false, role: null, description: "", ...over });

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/view/alpha", storage: { agend_tour_done: "1" } });
  g.fetch = async (u: string, init: { method?: string; body?: string } = {}) => {
    requests.push({ url: u, method: init.method ?? "GET", body: init.body });
    if (u === "/api/profiles") return { ok: true, status: 200, json: async () => roster };
    if (u.startsWith("/api/pane/")) return { ok: paneStatus === 200, status: paneStatus, headers: { get: () => null }, text: async () => "" };
    if (u.startsWith("/api/ai-usage")) return { ok: aiStatus === 200, status: aiStatus, json: async () => ai };
    if (u.startsWith("/api/profile/")) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  g.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0", fontFamily: "monospace", fontSize: "1px", lineHeight: "1.2" });
  view = await import("/assets/panel-view.js");
  shell = await import("/assets/app-shell.js");
  nav = await import("/assets/instance-nav.js");
  i18n = await import("/assets/app-i18n.js");
  useStore = (await import("/assets/app-store.js")).useStore;
});
afterAll(async () => { await p.unmount(); p.restore(); i18n.setLang("en"); for (const k of ["fetch", "getComputedStyle"]) delete g[k]; });
afterEach(async () => {
  await p.unmount();
  // The roster store is the page's own singleton: each test starts from a page that has just loaded.
  view.viewStore.set({ loaded: false, error: null, roster: [], current: null });
  nav.navStore.set({ order: { groups: new Map(), insts: new Map() }, collapsed: new Set(), filter: { q: "", status: [], cli: [] } });
  p.storage.clear(); i18n.setLang("en");
  roster = []; ai = { providers: [], fetchedAt: 0 }; aiStatus = 200; paneStatus = 200; requests = [];
  p.document.body.innerHTML = ""; p.root = p.document.createElement("div"); p.root.id = "app"; p.document.body.appendChild(p.root);
});

/** The sidebar's list as the page shows it with View open (alpha.2, N1: one list on every page), fed by View's roster. */
function Slot() {
  return h(nav.RosterNav, {});
}
const mountView = (name = "alpha") => p.mount(h("div", {}, h(view.ViewPanel, { route: { panel: "view", instance: name }, navKey: `view:${name}|1|en` }), h(Slot, {})));
const rows = () => p.root.querySelectorAll("a.v-inst");
const rowName = (a: any) => a.querySelector(".inst-name").textContent;
const rowOf = (name: string) => rows().find((a: any) => rowName(a) === name)!;
const card = () => p.root.querySelector(".v-card")!;
const usageButton = () => p.root.querySelectorAll(".panel-actions .btn").find((b: any) => b.textContent.includes("Usage"))!;

describe("the roster row: the backend icon, the context figure", () => {
  it("each backend has its icon class, in the stylesheet and on the row", async () => {
    roster = BACKENDS.map((b, i) => base({ instance_name: `i${i}`, backend: b, context_pct: null }));
    await mountView("i0");
    for (const backend of BACKENDS) expect(appCss, backend).toContain(`.cli-${backend}`);
    const icons = rows().map((a: any) => a.querySelector(".cli-icon").className.split(" ").find((c: string) => c !== "cli-icon"));
    expect(icons).toEqual(BACKENDS.map(b => `cli-${b}`));
  });

  it("the icon comes after the context figure, and an unknown backend gets the 'other' colour", async () => {
    roster = [base({ instance_name: "alpha", backend: "codex", context_pct: 40 }), base({ instance_name: "beta", backend: "mystery", context_pct: null })];
    await mountView();
    const alpha = rowOf("alpha");
    const kids = alpha.children.map((c: any) => c.className.split(" ")[0]);
    expect(kids.indexOf("v-meta")).toBeLessThan(kids.indexOf("cli-icon"));
    expect(alpha.querySelector(".v-meta").textContent).toBe("40%");
    expect(rowOf("beta").querySelector(".cli-icon").className).toContain("cli-other");
  });

  it("0% context shows as 0% (null means unavailable and shows nothing)", async () => {
    roster = [base({ instance_name: "alpha", context_pct: 0 }), base({ instance_name: "beta", context_pct: null })];
    await mountView();
    expect(rowOf("alpha").querySelector(".v-meta").textContent).toBe("0%");
    expect(rowOf("beta").querySelector(".v-meta").textContent).toBe("");
  });

  it("the profile card shows ctx 0% when it is 0, and no ctx part when unavailable", async () => {
    roster = [base({ instance_name: "alpha", context_pct: 0 })];
    await mountView();
    expect(card().querySelector(".v-card-meta")!.textContent).toContain("· ctx 0%");
    await p.unmount();
    roster = [base({ instance_name: "alpha", context_pct: null })];
    await mountView();
    expect(card().querySelector(".v-card-meta")!.textContent).not.toContain("ctx");
  });
});

describe("tooltips and labels", () => {
  it("the row's tooltip is the instance's tooltip, and the backend label names the icon", async () => {
    roster = [base({ instance_name: "alpha", display_name: "Sentinel", backend: "claude-code", context_pct: 12, status: "running" })];
    await mountView();
    expect(rowOf("alpha").getAttribute("title")).toBe(view.instanceTooltip(roster[0] as any));
    expect(rowOf("alpha").querySelector(".cli-icon").getAttribute("title")).toBe("Claude Code");
  });

  it("labels: the backend names in the icons (Claude Code, Kiro CLI, Grok Build), the tooltip's lines, in English", () => {
    expect(view.backendLabel("claude-code")).toBe("Claude Code");
    expect(view.backendLabel("kiro-cli")).toBe("Kiro CLI");
    expect(view.backendLabel("grok")).toBe("Grok Build");
    const tip = view.instanceTooltip({ instance_name: "a", display_name: "Sentinel", backend: "claude-code", model: "m", model_source: "instance", status: "running", context_pct: 12, effort: "high", effort_source: "instance" } as any);
    expect(tip.split("\n")).toEqual(["Sentinel", "(a)", "Backend: Claude Code", "Model: m (configured)", "Status: Running", "Context: 12%", "Effort: high (configured)"]);
  });

  it("the same lines in Traditional Chinese", () => {
    i18n.setLang("zh-TW");
    const tip = view.instanceTooltip({ instance_name: "a", backend: "claude-code", model: "", status: "running", context_pct: 12, model_source: "fleet-default" } as any);
    expect(tip.split("\n")).toEqual(["a", "後端：Claude Code", "模型：無資料 (fleet default)", "狀態：運行中", "上下文：12%"]);
    expect(tip).toContain("後端：");
  });

  it("the instance's description, if any, follows a blank line", () => {
    const tip = view.instanceTooltip({ instance_name: "a", backend: "codex", model: "m", status: "running", context_pct: null, description: "  Reviews the diffs.  " } as any);
    expect(tip.endsWith("\n\nReviews the diffs.")).toBe(true);
  });

  it("classic (and instance) configuration reads as configured in the tooltip, like instance (fix-forward)", () => {
    const classic = view.instanceTooltip({ instance_name: "a", backend: "codex", model: "m", model_source: "classic", status: "running", context_pct: null, effort: "low", effort_source: "classic" } as any);
    expect(classic).toContain("Model: m (configured)");
    expect(classic).toContain("Effort: low (configured)");
    const fleet = view.instanceTooltip({ instance_name: "a", backend: "codex", model: "m", model_source: "fleet-default", status: "running", context_pct: null } as any);
    expect(fleet).toContain("Model: m (fleet default)");
  });

  it("the tooltip's context figure is clamped to 0–100 and the status words come from the same dictionary", () => {
    expect(view.instanceTooltip({ instance_name: "a", backend: "codex", model: "m", status: "crashed", context_pct: 250 } as any)).toContain("Context: 100%");
    expect(view.instanceTooltip({ instance_name: "a", backend: "codex", model: "m", status: "crashed", context_pct: null } as any)).toContain("Status: Crashed");
    expect(viewStrings).toContain('"statusRunning": "Running"');
    expect(viewStrings).toContain('"statusRunning": "運行中"');
  });
});

describe("the sidebar order: saved in this browser only, never on the server", () => {
  // The mini-dom has no ondragstart/ondragend properties, so Preact binds those two in their camel-case form ("DragStart"),
  // where a browser binds "dragstart". The handlers are the same; only the test's event name has to match the binding.
  const drag = { dragstart: "DragStart", dragend: "DragEnd", dragover: "dragover", drop: "drop" } as Record<string, string>;
  const dragEvent = (el: any, type: keyof typeof drag, init: Record<string, unknown> = {}) => fire(el, drag[type]!, { dataTransfer: { effectAllowed: "", setData() {} }, ...init });

  it("dragging an instance above its neighbour re-orders the list and saves it under agend_view_sidebar_order", async () => {
    roster = [base({ instance_name: "alpha", tags: ["G"] }), base({ instance_name: "beta", tags: ["G"] })];
    await mountView();
    expect(rows().map(rowName)).toEqual(["alpha", "beta"]);
    dragEvent(rowOf("beta"), "dragstart");
    dragEvent(rowOf("alpha"), "dragover", { clientY: -1 });           // above the middle: a drop before
    dragEvent(rowOf("alpha"), "drop");
    await settle();
    expect(rows().map(rowName)).toEqual(["beta", "alpha"]);
    const saved = JSON.parse(p.storage.get("agend_view_sidebar_order")!);
    expect(saved).toContainEqual({ item_type: "instance", item_name: "beta", sort_index: 0, group_name: "G" });
    expect(saved).toContainEqual({ item_type: "group", item_name: "G", sort_index: 0, group_name: null });
  });

  it("the saved order is read at page load, and nothing was sent to the server", async () => {
    p.storage.set("agend_view_sidebar_order", JSON.stringify([
      { item_type: "group", item_name: "G", sort_index: 0, group_name: null },
      { item_type: "instance", item_name: "beta", sort_index: 0, group_name: "G" },
      { item_type: "instance", item_name: "alpha", sort_index: 1, group_name: "G" },
    ]));
    roster = [base({ instance_name: "alpha", tags: ["G"] }), base({ instance_name: "beta", tags: ["G"] })];
    // A page load: the modules are read again, and the order is taken from this browser's storage.
    vi.resetModules();
    const preact = await import("/assets/preact.module.js");
    preact.options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    const fresh = await import("/assets/panel-view.js");
    const freshNav = await import("/assets/instance-nav.js");
    const FreshSlot = () => preact.h(freshNav.RosterNav, {});
    preact.render(preact.h("div", {}, preact.h(fresh.ViewPanel, { route: { panel: "view", instance: "alpha" }, navKey: "view:alpha|9|en" }), preact.h(FreshSlot, {})), p.root);
    await settle();
    expect(rows().map(rowName)).toEqual(["beta", "alpha"]);
    expect(requests.some(r => r.method !== "GET")).toBe(false);
    expect(requests.some(r => r.url.includes("sort-order"))).toBe(false);
  });

  it("a corrupt saved order is ignored, not fatal", async () => {
    p.storage.set("agend_view_sidebar_order", "{not json");
    roster = [base({ instance_name: "alpha", tags: ["G"] }), base({ instance_name: "beta", tags: ["G"] })];
    await mountView();
    expect(rows().map(rowName)).toEqual(["alpha", "beta"]);
  });
});

describe("the AI usage providers are reordered in this browser, with no token", () => {
  it("move down swaps two providers, saves the order under agend_view_usage_order, and sends no write", async () => {
    ai = { fetchedAt: Date.parse("2026-10-06T00:00:00Z"), providers: [
      { id: "codex", name: "Codex", status: "ok", metrics: [] },
      { id: "kiro", name: "Kiro", status: "ok", metrics: [] },
    ] };
    roster = [base({ instance_name: "alpha" })];
    await mountView();
    usageButton().click(); await settle();
    const names = () => p.root.querySelectorAll(".u-provider strong").map((s: any) => s.textContent);
    expect(names()).toEqual(["Codex", "Kiro"]);
    const before = requests.length;
    const down = p.root.querySelectorAll(".u-provider button").find((b: any) => b.getAttribute("title") === "Move down")!;
    down.click(); await settle();
    expect(names()).toEqual(["Kiro", "Codex"]);
    expect(p.storage.get("agend_view_usage_order")).toBe(JSON.stringify(["kiro", "codex"]));
    expect(requests.slice(before).every(r => r.method === "GET" && !/token/i.test(JSON.stringify(r)))).toBe(true);
  });
});

describe("failures and controls are localized", () => {
  it("the pane's failure line names the instance and the status, in the app's text", async () => {
    paneStatus = 500;
    roster = [base({ instance_name: "alpha" })];
    await mountView();
    await settle(8);
    expect(p.root.querySelector(".v-term-note")!.textContent).toBe("⚠ Could not load pane for alpha (HTTP 500).");
  });

  it("the Chinese pane and roster failure lines keep their placeholders", () => {
    i18n.setLang("zh-TW");
    expect(i18n.t("view.paneFailed")).toBe("⚠ 無法載入 {name} 的 pane（HTTP {status}）。");
    expect(i18n.t("view.rosterFailedShort")).toBe("無法載入 instance 清單。");
  });

  it("a roster that cannot load shows the panel's error state, not a raw message", async () => {
    const fetchFake = g.fetch;
    g.fetch = async (u: string) => (u === "/api/profiles" ? { ok: false, status: 500, json: async () => ({}) } : fetchFake(u));
    try {
      await mountView();
      await settle(4);
      expect(p.root.textContent).toContain("The instance list could not be loaded.");
    } finally { g.fetch = fetchFake; }
  });

  it("the usage and help controls are labelled in the app's text", async () => {
    roster = [base({ instance_name: "alpha" })];
    ai = { providers: [], fetchedAt: 0 };
    await mountView();
    await settle(4);
    // The label is the button's text (hidden below 900 px by .hide-narrow, so there it has no accessible name).
    expect(usageButton().textContent).toBe("Usage");
    expect(p.root.querySelector('button[aria-label="Help"]')).not.toBeNull();
  });

  it("saving without a session asks to sign in: no token box in the edit form, and the message says so", async () => {
    roster = [base({ instance_name: "alpha" })];
    await mountView();
    p.root.querySelectorAll("button").find((b: any) => b.textContent.includes("Edit profile"))!.click(); await settle();
    const dialog = p.root.querySelector("dialog")!;
    const fields = dialog.querySelectorAll("input,textarea").map((el: any) => `${el.getAttribute("type") ?? ""}:${el.getAttribute("placeholder") ?? ""}`);
    expect(fields.join("|")).not.toMatch(/token/i);
    p.root.querySelectorAll("dialog button").find((b: any) => b.textContent.includes("Save"))!.click();
    await settle(8);
    expect(dialog.querySelector(".err")!.textContent).toContain("Sign in to save");
    expect(viewStrings).not.toContain("tokenRequired");
  });
});
