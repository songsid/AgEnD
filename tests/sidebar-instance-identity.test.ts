import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const dashboardHtml = readFileSync(new URL("../src/ui/dashboard.html", import.meta.url), "utf8");
const viewHtml = readFileSync(new URL("../src/ui/view.html", import.meta.url), "utf8");

function functionSource(html: string, name: string, nextName: string): string {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`function ${nextName}(`, start);
  if (start < 0 || end < 0) throw new Error(`Could not find ${name} in UI source`);
  return html.slice(start, end).trim();
}

function sourceBetween(html: string, startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Could not find ${startMarker} in UI source`);
  return html.slice(start, end).trim();
}

function renderDashboardSidebar(instances: Array<Record<string, unknown>>): string {
  const list = {
    innerHTML: "",
    querySelectorAll: () => [],
  };
  const fleetEntry = { className: "" };
  const context = {
    instances,
    cur: null,
    mode: "fleet",
    esc: (value: unknown) => String(value),
    document: {
      getElementById: (id: string) => id === "instanceList" ? list : fleetEntry,
    },
  };
  const renderList = vm.runInNewContext(`(${functionSource(dashboardHtml, "renderList", "selFleet")})`, context) as () => void;
  renderList();
  return list.innerHTML;
}

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
  };
  const renderList = vm.runInNewContext(`(${sourceBetween(viewHtml, "function renderList(", "// ── Drag & drop")})`, context) as () => void;
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

describe("sidebar instance identity", () => {
  it("renders raw dashboard identity first and display_name as the optional subtitle", () => {
    const html = renderDashboardSidebar([dashboardPayload]);
    expect(html).toContain('<div class="inst-name">classic-rd1web-miraculous-agent</div>');
    expect(html).toContain('<div class="inst-alias">Mira｜奇蹟網頁企劃</div>');
    expect(html.indexOf("classic-rd1web-miraculous-agent")).toBeLessThan(html.indexOf("Mira｜奇蹟網頁企劃"));
  });

  it("renders no dashboard subtitle when display_name is empty or equals the raw identity", () => {
    const withoutAlias = renderDashboardSidebar([
      { ...dashboardPayload, display_name: "" },
      { ...dashboardPayload, name: "same-name", display_name: "same-name" },
    ]);
    expect(withoutAlias).not.toContain('class="inst-alias"');
    expect(withoutAlias).toContain('<div class="inst-name">same-name</div>');
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
    expect(dashboardHtml).toMatch(/\.inst-name \{[^}]*text-overflow: ellipsis/);
    expect(dashboardHtml).toMatch(/\.inst-alias \{[^}]*text-overflow: ellipsis/);
    expect(viewHtml).toMatch(/\.inst \.nm \{[^}]*text-overflow: ellipsis/);
    expect(viewHtml).toMatch(/\.inst \.alias \{[^}]*text-overflow: ellipsis/);
  });
});
