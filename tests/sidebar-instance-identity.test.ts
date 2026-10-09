import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const appCss = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");

// The app's sidebar, mounted with the real Shell, the real store and the real router (tests/helpers/app-harness.ts).
const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
});
async function sidebar(instances: Array<Record<string, unknown>>, path = "/ui") {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances });
  await pg.mount(h(Shell, { panels: new Map(), onNewInstance() {} }));
  return pg;
}
/** The View panel's roster, as the sidebar section the panel installs while it is mounted (panel-view.js ViewRoster). */
async function viewSidebar(roster: Array<Record<string, unknown>>, path = "/view") {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => (url === "/api/profiles"
    ? { ok: true, status: 200, json: async () => roster }
    : { ok: false, status: 404, json: async () => ({}) });
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  const { ViewPanel, viewStore } = await import("/assets/panel-view.js");
  viewStore.set({ loaded: false, error: null, roster: [], filter: "", collapsed: new Set(), current: null });
  startRouter(pg.window);
  applyStatus({ instances: [] });
  await pg.mount(h(Shell, { panels: new Map([["view", { Component: ViewPanel }]]), onNewInstance() {} }));
  await vi.waitFor(async () => { await settle(); expect(pg.root.querySelectorAll("a.v-inst").length).toBe(roster.length); });
  return pg;
}
const rows = (pg: AppPage) => pg.root.querySelectorAll("a.inst");

const dashboardPayload = {
  name: "classic-rd1web-miraculous-agent",
  display_name: "Mira｜奇蹟網頁企劃",
  backend: "kiro-cli",
  model: "auto (default)",
  model_source: "cli-default",
  effort: null,
  effort_source: null,
  context_pct: 0,
  status: "running",
  cost: 0,
};

const viewPayload = {
  instance_name: "classic-rd1web-miraculous-agent",
  display_name: "Mira｜奇蹟網頁企劃",
  backend: "kiro-cli",
  context_pct: 0,
  status: "running",
};

const awaiting = (name: string, summary?: string) => ({ ...dashboardPayload, name, state: "awaiting_input", ...(summary === undefined ? {} : { interaction_summary: summary }) });

describe("sidebar instance identity", () => {
  it("renders raw dashboard identity first and display_name as the optional subtitle", async () => {
    const pg = await sidebar([dashboardPayload]);
    const [row] = rows(pg);
    expect(row!.querySelector(".inst-name")!.textContent).toBe("classic-rd1web-miraculous-agent");
    expect(row!.querySelector(".inst-alias")!.textContent).toBe("Mira｜奇蹟網頁企劃");
    const text = row!.textContent;
    expect(text.indexOf("classic-rd1web-miraculous-agent")).toBeLessThan(text.indexOf("Mira｜奇蹟網頁企劃"));
  });

  it("an instance waiting on a terminal prompt gets a 'needs you' badge on the second line, its summary as the tooltip (#1307)", async () => {
    const pg = await sidebar([awaiting(dashboardPayload.name, "Permission prompt for 12s")]);
    const [row] = rows(pg);
    const badge = row!.querySelector(".badge-await")!;
    expect(badge.textContent).toBe("needs you");
    expect(badge.getAttribute("title")).toBe("Permission prompt for 12s");
    // Its own line: the name keeps its line to itself, and the badge sits in the sub-line under it (#1408 rough edge 6).
    expect(row!.querySelector(".inst-name")!.querySelector(".badge-await"), "not on the name line").toBeNull();
    expect(badge.parentNode!.getAttribute("class")).toBe("inst-sub");
  });

  it("a waiting instance with no summary gets the generic note as its tooltip (#1307)", async () => {
    const pg = await sidebar([awaiting(dashboardPayload.name, "")]);
    expect(rows(pg)[0]!.querySelector(".badge-await")!.getAttribute("title")).toBe("Read from the terminal, so approximate");
  });

  it("an instance that waits on nothing gets no badge (#1307)", async () => {
    const pg = await sidebar([{ ...dashboardPayload, state: "running" }]);
    expect(rows(pg)[0]!.querySelector(".badge-await")).toBeNull();
  });

  it("renders no dashboard subtitle when display_name is empty or equals the raw identity", async () => {
    const pg = await sidebar([
      { ...dashboardPayload, display_name: "" },
      { ...dashboardPayload, name: "same-name", display_name: "same-name" },
    ]);
    const [blank, same] = rows(pg);
    expect(blank!.querySelector(".inst-alias")).toBeNull();
    expect(same!.querySelector(".inst-alias")).toBeNull();
    expect(same!.querySelector(".inst-name")!.textContent).toBe("same-name");
  });

  it.each([
    [{ model_source: "live" }, "auto (default)"],
    [{ model: "sonnet", model_source: "live" }, "sonnet"],
    [{ model: "sonnet", model_source: "cli-default" }, "sonnet"],
    [{ model: "sonnet", model_source: "unresolved" }, "sonnet"],
    [{ model: "sonnet", model_source: "instance" }, "sonnet (configured)"],
    [{ model: "sonnet", model_source: "fleet-default" }, "sonnet (fleet default)"],
  ])("the tooltip names the model's source: %j", async (patch, shown) => {
    const pg = await sidebar([{ ...dashboardPayload, ...patch, effort: null, context_pct: null, cost: 0 }]);
    expect(rows(pg)[0]!.getAttribute("title")).toBe(`classic-rd1web-miraculous-agent · kiro-cli · ${shown} · running`);
  });

  it("the tooltip carries effort (with its source, instance included), context and cost", async () => {
    const pg = await sidebar([{ ...dashboardPayload, model: "sonnet", model_source: "instance", effort: "high", effort_source: "instance", context_pct: 42.6, cost: 1.5 }]);
    expect(rows(pg)[0]!.getAttribute("title")).toBe("classic-rd1web-miraculous-agent · kiro-cli · sonnet (configured) · effort:high (configured) · ctx:43% · $1.50 · running");
  });

  it("the row is a real link to the chat, reachable with Tab and Enter, and the active one is marked for assistive tech", async () => {
    const { chatPath } = await import("/assets/app-route.js");
    const pg = await sidebar([dashboardPayload, { ...dashboardPayload, name: "other" }], `/ui/chat/${dashboardPayload.name}`);
    const [active, other] = rows(pg);
    for (const row of [active!, other!]) {
      expect(row.tagName.toLowerCase()).toBe("a");
      expect(row.getAttribute("role")).toBeNull();
    }
    expect(active!.getAttribute("href")).toBe(chatPath(dashboardPayload.name));
    expect(active!.getAttribute("aria-current")).toBe("page");
    expect(active!.getAttribute("class")).toContain("active");
    expect(other!.getAttribute("aria-current")).toBeNull();
  });

  it("a hostile name stays one name: no data-act anywhere in the sidebar, the href is encoded, the text is exact (#1303)", async () => {
    const hostile = `victim" data-act="doAction" data-arg="stop" x="`;
    const pg = await sidebar([{ ...dashboardPayload, name: hostile, display_name: "" }]);
    expect(pg.root.querySelectorAll("[data-act]")).toEqual([]);
    const [row] = rows(pg);
    expect(row!.querySelector(".inst-name")!.textContent).toBe(hostile);
    expect(row!.getAttribute("href")).not.toContain('"');
    expect(row!.getAttribute("title")!.startsWith(hostile)).toBe(true);
  });

  it("the View roster renders raw identity first and display_name as the optional subtitle", async () => {
    const pg = await viewSidebar([viewPayload]);
    const [row] = pg.root.querySelectorAll("a.v-inst");
    expect(row!.querySelector(".inst-name")!.textContent).toBe("classic-rd1web-miraculous-agent");
    expect(row!.querySelector(".inst-alias")!.textContent).toBe("Mira｜奇蹟網頁企劃");
    const text = row!.textContent;
    expect(text.indexOf("classic-rd1web-miraculous-agent")).toBeLessThan(text.indexOf("Mira｜奇蹟網頁企劃"));
  });

  it("the View roster renders no subtitle when display_name is missing or equals the raw identity", async () => {
    const pg = await viewSidebar([
      { ...viewPayload, display_name: undefined },
      { ...viewPayload, instance_name: "same-name", display_name: "same-name" },
    ]);
    const [blank, same] = pg.root.querySelectorAll("a.v-inst");
    expect(blank!.querySelector(".inst-alias")).toBeNull();
    expect(same!.querySelector(".inst-alias")).toBeNull();
    expect(same!.querySelector(".inst-name")!.textContent).toBe("same-name");
  });

  it("the View roster row is a link to /view/<name>, its tooltip leads with the identity, and the open one is the active row", async () => {
    const { viewPath } = await import("/assets/app-route.js");
    const pg = await viewSidebar([viewPayload, { ...viewPayload, instance_name: "other", display_name: "" }], `/view/${viewPayload.instance_name}`);
    const [active, other] = pg.root.querySelectorAll("a.v-inst");
    expect(active!.tagName.toLowerCase()).toBe("a");
    expect(active!.getAttribute("href")).toBe(viewPath(viewPayload.instance_name));
    expect(active!.getAttribute("class")).toContain("active");
    expect(active!.getAttribute("aria-current")).toBe("page");
    expect(other!.getAttribute("class")).not.toContain("active");
    expect(other!.getAttribute("aria-current")).toBeNull();
    expect(active!.getAttribute("title")!.split("\n").slice(0, 2)).toEqual(["Mira｜奇蹟網頁企劃", "(classic-rd1web-miraculous-agent)"]);
    expect(active!.getAttribute("title")).toContain("Backend: Kiro CLI");
  });

  it("a hostile View roster name stays one name: no data-act, the href is encoded, the text is exact (#1303)", async () => {
    const hostile = `victim" data-act="doAction" data-arg="stop" x="`;
    const pg = await viewSidebar([{ ...viewPayload, instance_name: hostile, display_name: "" }]);
    expect(pg.root.querySelectorAll("[data-act]")).toEqual([]);
    const [row] = pg.root.querySelectorAll("a.v-inst");
    expect(row!.querySelector(".inst-name")!.textContent).toBe(hostile);
    expect(row!.getAttribute("href")).not.toContain('"');
    expect(row!.getAttribute("title")!.startsWith(hostile)).toBe(true);
  });

  // The View roster reuses the sidebar's identity classes, so one rule per line covers both sidebars.
  it("keeps both identity lines ellipsized on both sidebars", () => {
    expect(appCss).toMatch(/\.inst-name \{[^}]*text-overflow: ellipsis/);
    expect(appCss).toMatch(/\.inst-alias \{[^}]*text-overflow: ellipsis/);
  });
});
