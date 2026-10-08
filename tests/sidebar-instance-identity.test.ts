import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const viewHtml = readFileSync(new URL("../src/ui/view.html", import.meta.url), "utf8");
const appCss = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");

function sourceBetween(html: string, startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Could not find ${startMarker} in UI source`);
  return html.slice(start, end).trim();
}

// The app's sidebar, mounted with the real Shell, the real store and the real router (tests/helpers/app-harness.ts).
const mounted: AppPage[] = [];
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } });
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
const rows = (pg: AppPage) => pg.root.querySelectorAll("a.inst");

/** The view's sidebar, unchanged by #1408 step 1: rendered from view.html's own renderList. */
function renderViewSidebar(instances: Array<Record<string, unknown>>): string[] {
  const rendered: Array<{ className: string; innerHTML: string }> = [];
  const list = {
    innerHTML: "",
    appendChild: (element: { className: string; innerHTML: string }) => {
      if (element.className.startsWith("inst")) rendered.push(element);
    },
  };
  const names = instances.map((instance) => String(instance.instance_name));
  const context = {
    q: () => list,
    groupNames: ["Classic"],
    instByGroup: new Map([["Classic", names]]),
    collapsed: new Set(),
    rosterByName: new Map(instances.map((instance) => [instance.instance_name, instance])),
    current: null,
    document: {
      createElement: () => ({ className: "", innerHTML: "", draggable: false }),
    },
    esc: (value: unknown) => String(value),
    sidebarAlias: vm.runInNewContext(`(${sourceBetween(viewHtml, "function sidebarAlias(", "const BACKEND_LABELS")})`),
    backendIconHtml: () => "",
    instanceTooltip: () => "tooltip",
    select: () => undefined,
    wireDrag: () => undefined,
    // #999: renderList renders through the sidebar filter (empty query here).
    filterQuery: "",
    backendLabel: (backend: string) => backend,
    renderFilterStatus: () => undefined,
    T: (key: string) => key,
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween(viewHtml, "// ── sidebar filter (#999) — pure; tests execute this block ──", "// ── end sidebar filter ──"), context);
  const renderList = vm.runInContext(`(${sourceBetween(viewHtml, "function renderList(", "// ── Drag & drop")})`, context) as () => void;
  renderList();
  return rendered.map((element) => element.innerHTML);
}

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

  it("renders raw view identity first and display_name as the optional subtitle", () => {
    const [html] = renderViewSidebar([viewPayload]);
    expect(html).toContain('<span class="nm">classic-rd1web-miraculous-agent</span>');
    expect(html).toContain('<span class="alias">Mira｜奇蹟網頁企劃</span>');
    expect(html.indexOf("classic-rd1web-miraculous-agent")).toBeLessThan(html.indexOf("Mira｜奇蹟網頁企劃"));
  });

  it("renders no view subtitle when display_name is missing or equals the raw identity", () => {
    const rows = renderViewSidebar([
      { ...viewPayload, display_name: undefined },
      { ...viewPayload, instance_name: "same-name", display_name: "same-name" },
    ]);
    expect(rows.join("\n")).not.toContain('class="alias"');
    expect(rows[1]).toContain('<span class="nm">same-name</span>');
  });

  it("keeps both identity lines ellipsized on both sidebars", () => {
    expect(appCss).toMatch(/\.inst-name \{[^}]*text-overflow: ellipsis/);
    expect(appCss).toMatch(/\.inst-alias \{[^}]*text-overflow: ellipsis/);
    expect(viewHtml).toMatch(/\.inst \.nm \{[^}]*text-overflow: ellipsis/);
    expect(viewHtml).toMatch(/\.inst \.alias \{[^}]*text-overflow: ellipsis/);
  });
});
