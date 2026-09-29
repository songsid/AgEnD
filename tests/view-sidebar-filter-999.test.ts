/**
 * #999: /view sidebar filter. The filter logic is executed from view.html
 * itself (the marked pure block), not re-implemented here; the wiring checks
 * pin that the roster refresh renders through the filter rather than around it.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(process.cwd(), "src", "ui", "view.html"), "utf-8");

function loadFilterBlock() {
  const start = html.indexOf("// ── sidebar filter (#999) — pure; tests execute this block ──");
  const end = html.indexOf("// ── end sidebar filter ──");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const source = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${source}\nreturn { normalizeFilter, instanceMatchesFilter, filterSidebar };`)() as {
    normalizeFilter(q: unknown): string;
    instanceMatchesFilter(it: Record<string, unknown>, needle: string, labelOf?: (b: string) => string): boolean;
    filterSidebar(groups: string[], byGroup: Map<string, string[]>, byName: Map<string, Record<string, unknown>>, query: string, labelOf?: (b: string) => string): {
      groups: Array<{ group: string; names: string[] }>; shown: number; total: number; active: boolean;
    };
  };
}

const { normalizeFilter, instanceMatchesFilter, filterSidebar } = loadFilterBlock();
const LABELS: Record<string, string> = { "claude-code": "Claude Code", "kiro-cli": "Kiro CLI", grok: "Grok Build" };
const labelOf = (b: string) => LABELS[b] ?? b;

const ROSTER = [
  { instance_name: "agend-dev-claude", display_name: "Sentinel", model: "claude-opus-5-5", backend: "claude-code" },
  { instance_name: "doupo-server-codex", display_name: null, model: "gpt-5.6-sol", backend: "codex" },
  { instance_name: "leader", display_name: "Captain", model: "", backend: "kiro-cli" },
  { instance_name: "grok-scout", model: null, backend: "grok" },
];
const byName = new Map(ROSTER.map(r => [r.instance_name, r as Record<string, unknown>]));
const groups = ["AgEnD", "DouPo", "Other"];
const byGroup = new Map([
  ["AgEnD", ["agend-dev-claude", "leader"]],
  ["DouPo", ["doupo-server-codex", "gone-from-roster"]],
  ["Other", ["grok-scout"]],
]);
const shownNames = (query: string) => filterSidebar(groups, byGroup, byName, query, labelOf).groups.flatMap(g => g.names);

describe("sidebar filter logic (#999)", () => {
  it("shows every instance, with the full count, for an empty or blank query", () => {
    for (const query of ["", "   ", "\t"]) {
      const view = filterSidebar(groups, byGroup, byName, query, labelOf);
      expect(view).toMatchObject({ shown: 4, total: 4, active: false });
      expect(view.groups.map(g => g.group)).toEqual(["AgEnD", "DouPo", "Other"]);
    }
  });

  it("matches name, display name, model and backend (id or label), case-insensitively", () => {
    expect(shownNames("DOUPO")).toEqual(["doupo-server-codex"]);             // name
    expect(shownNames("captain")).toEqual(["leader"]);                        // display name
    expect(shownNames("opus")).toEqual(["agend-dev-claude"]);                 // model
    expect(shownNames("codex")).toEqual(["doupo-server-codex"]);              // backend id (and name)
    expect(shownNames("kiro")).toEqual(["leader"]);                           // backend id
    expect(shownNames("kiro-cli")).toEqual(["leader"]);                       // backend id only (label is "Kiro CLI")
    expect(shownNames("claude-code")).toEqual(["agend-dev-claude"]);          // backend id only (label is "Claude Code")
    expect(shownNames("build")).toEqual(["grok-scout"]);                      // backend label only
    expect(shownNames("  Sol  ")).toEqual(["doupo-server-codex"]);            // trimmed
  });

  it("is a substring match, and a miss hides everything", () => {
    expect(shownNames("dev-cl")).toEqual(["agend-dev-claude"]);
    const none = filterSidebar(groups, byGroup, byName, "no-such-thing", labelOf);
    expect(none).toMatchObject({ groups: [], shown: 0, total: 4, active: true });
  });

  it("drops groups with no match, keeps display order, and counts N / M over live roster rows", () => {
    const view = filterSidebar(groups, byGroup, byName, "o", labelOf);
    expect(view.groups.map(g => g.group)).toEqual(["AgEnD", "DouPo", "Other"]);
    const claude = filterSidebar(groups, byGroup, byName, "claude", labelOf);
    expect(claude.groups).toEqual([{ group: "AgEnD", names: ["agend-dev-claude"] }]);
    // "gone-from-roster" is in the saved order but not the roster: never counted.
    expect(claude).toMatchObject({ shown: 1, total: 4, active: true });
  });

  it("tolerates missing fields", () => {
    expect(instanceMatchesFilter({ instance_name: "x" }, "x")).toBe(true);
    expect(instanceMatchesFilter({ instance_name: "x", model: null, backend: undefined }, "y")).toBe(false);
    expect(normalizeFilter(undefined)).toBe("");
  });
});

describe("sidebar filter wiring (#999)", () => {
  it("sits at the bottom of the sidebar, after the scrolling list", () => {
    const sidebar = html.slice(html.indexOf('<div id="sidebar">'), html.indexOf('<div id="main">'));
    expect(sidebar.indexOf('<div id="list">')).toBeLessThan(sidebar.indexOf('id="filterBar"'));
    expect(sidebar).toContain('id="filterInput"');
    expect(sidebar).toContain('id="filterClear"');
    expect(sidebar).toContain('id="filterCount"');
    expect(html).toContain("#list { flex: 1 1 auto; min-height: 0; overflow-y: auto; }");
  });

  it("renders the list through the filter and filters on every keystroke", () => {
    expect(html).toContain("const view = filterSidebar(groupNames, instByGroup, rosterByName, filterQuery, backendLabel);");
    expect(html).toContain("for (const { group: g, names } of view.groups)");
    expect(html).toContain('q("filterInput").addEventListener("input", (e) => setFilter(e.target.value));');
  });

  it("keeps the query across the 5-second roster refresh: only the input and clear change it", () => {
    const assignments = [...html.matchAll(/\bfilterQuery\s*=(?!=)/g)].length;
    expect(assignments).toBe(2); // the declaration and setFilter
    expect(html).toContain('let filterQuery = "";');
    expect(html).toContain("const setFilter = (value) => { filterQuery = value; renderList(); };");
    const loadRoster = html.slice(html.indexOf("async function loadRoster()"), html.indexOf("// ── Terminal"));
    expect(loadRoster).toContain("renderList()");
    expect(loadRoster).not.toContain("filterQuery");
  });

  it("keeps click-to-select on every visible row and localizes the new strings", () => {
    expect(html).toContain("el.onclick = () => select(name);");
    for (const key of ["filterPh", "filterClear", "filterNone", "filterShown"]) {
      expect(html.match(new RegExp(`\\b${key}: "`, "g"))?.length).toBe(2); // en + zh-TW
    }
  });
});

describe("the real renderList renders through the filter (#999)", () => {
  const between = (a: string, b: string) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));
  /** view.html's own renderList + filter block, with a recording DOM stub. */
  function harness(initial: typeof ROSTER) {
    const rows: string[] = [];
    const list = { innerHTML: "", appendChild: (el: { className: string; innerHTML: string }) => { if (el.className.startsWith("inst")) rows.push(el.innerHTML); } };
    const status: Array<{ shown: number; total: number; active: boolean }> = [];
    const ctx: Record<string, unknown> = {
      q: () => list,
      groupNames: ["All"],
      instByGroup: new Map([["All", initial.map(r => r.instance_name)]]),
      collapsed: new Set(),
      rosterByName: new Map(initial.map(r => [r.instance_name, r])),
      current: null,
      document: { createElement: () => ({ className: "", innerHTML: "", draggable: false }) },
      esc: (v: unknown) => String(v),
      sidebarAlias: () => "",
      backendIconHtml: () => "",
      instanceTooltip: () => "",
      select: () => undefined,
      wireDrag: () => undefined,
      backendLabel: (b: string) => LABELS[b] ?? b,
      renderFilterStatus: (view: { shown: number; total: number; active: boolean }) => status.push(view),
      T: (k: string) => k,
      filterQuery: "",
    };
    vm.createContext(ctx);
    vm.runInContext(between("// ── sidebar filter (#999) — pure; tests execute this block ──", "// ── end sidebar filter ──"), ctx);
    const render = vm.runInContext(`(${between("function renderList(", "// ── Drag & drop")})`, ctx) as () => void;
    return {
      ctx, status,
      render: () => { rows.length = 0; list.innerHTML = ""; render(); return rows.map(r => r.match(/class="nm">([^<]+)</)?.[1]); },
      listHtml: () => list.innerHTML,
    };
  }

  it("shows only matching rows, and a roster refresh keeps the filter", () => {
    const h = harness(ROSTER);
    h.ctx.filterQuery = "codex";
    expect(h.render()).toEqual(["doupo-server-codex"]);
    // The 5-second refresh swaps in a new roster and calls renderList again.
    const refreshed = [...ROSTER, { instance_name: "new-claude", display_name: null, model: "claude", backend: "claude-code" },
      { instance_name: "new-codex", display_name: null, model: "gpt", backend: "codex" }];
    h.ctx.rosterByName = new Map(refreshed.map(r => [r.instance_name, r]));
    h.ctx.instByGroup = new Map([["All", refreshed.map(r => r.instance_name)]]);
    expect(h.render()).toEqual(["doupo-server-codex", "new-codex"]);
    expect(h.status.at(-1)).toMatchObject({ shown: 2, total: 6, active: true });
  });

  it("shows everything for an empty query and an empty state for a miss", () => {
    const h = harness(ROSTER);
    expect(h.render()).toHaveLength(4);
    expect(h.status.at(-1)).toMatchObject({ shown: 4, total: 4, active: false });
    h.ctx.filterQuery = "zzz";
    expect(h.render()).toEqual([]);
    expect(h.listHtml()).toContain('class="filter-empty"');
  });
});
