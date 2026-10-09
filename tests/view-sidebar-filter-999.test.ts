/**
 * #999: /view sidebar filter. The pure filter (normalizeFilter, instanceMatchesFilter, filterSidebar) is the public
 * module's own; the wiring is checked by mounting View, rendering its roster in the shell's sidebar slot, and typing
 * into the filter the way a user does. Ported from view.html's pure block and renderList (#1408 step 2).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

type View = typeof import("/assets/panel-view.js");
type Store = typeof import("/assets/app-store.js");
let p: AppPage;
let view: View;
let shell: typeof import("/assets/app-shell.js");
let i18n: typeof import("/assets/app-i18n.js");
let useStore: Store["useStore"];
const g = globalThis as any;
let roster: Array<Record<string, unknown>> = [];

const ROSTER = [
  { instance_name: "agend-dev-claude", display_name: "Sentinel", model: "claude-opus-5-5", backend: "claude-code", tags: ["AgEnD"], status: "running", context_pct: 12 },
  { instance_name: "doupo-server-codex", display_name: null, model: "gpt-5.6-sol", backend: "codex", tags: ["DouPo"], status: "running", context_pct: null },
  { instance_name: "leader", display_name: "Captain", model: "", backend: "kiro-cli", tags: ["AgEnD"], status: "stopped", context_pct: null },
  { instance_name: "grok-scout", model: null, backend: "grok", tags: [], status: "running", context_pct: null },
];

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/view/agend-dev-claude", storage: { agend_tour_done: "1" } });
  g.fetch = async (u: string) => {
    if (u === "/api/profiles") return { ok: true, status: 200, json: async () => roster };
    if (u.startsWith("/api/pane/")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
    if (u.startsWith("/api/ai-usage")) return { ok: true, status: 200, json: async () => ({ providers: [], fetchedAt: Date.now() }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  view = await import("/assets/panel-view.js");
  shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js");
  useStore = (await import("/assets/app-store.js")).useStore;
  roster = ROSTER;
});
afterAll(async () => { await p.unmount(); p.restore(); i18n.setLang("en"); delete g.fetch; });
afterEach(async () => { await p.unmount(); p.storage.clear(); roster = ROSTER; i18n.setLang("en"); });

/** The shell's sidebar slot: whatever section the mounted panel has set (View's roster), re-read from the store. */
function Slot() {
  const s = useStore(shell.shellStore);
  return s.side ? h(s.side.Component, {}) : null;
}
const mountView = () => p.mount(h("div", {}, h(view.ViewPanel, { route: { panel: "view", instance: "agend-dev-claude" }, navKey: "view:x|1|en" }), h(Slot, {})));
const rowNames = () => p.root.querySelectorAll(".v-inst").map((a: any) => a.querySelector(".inst-name")!.textContent);
const groupHeads = () => p.root.querySelectorAll(".v-group-head").map((b: any) => b.querySelector(".grow")!.textContent);
const input = () => p.root.querySelector("#filterInput")!;
const typeInto = async (value: string) => { input().value = value; fire(input(), "input"); await settle(); };
const count = () => p.root.querySelector(".v-filter .note")!.textContent;

// The pure part: the same fixtures as the wiring, with the public labels.
const byName = new Map(ROSTER.map(r => [r.instance_name as string, r as Record<string, unknown>]));
const groups = ["AgEnD", "DouPo", "Other"];
const byGroup = new Map([
  ["AgEnD", ["agend-dev-claude", "leader"]],
  ["DouPo", ["doupo-server-codex", "gone-from-roster"]],
  ["Other", ["grok-scout"]],
]);
const shownNames = (query: string) => view.filterSidebar(groups, byGroup, byName, query, view.backendLabel).groups.flatMap((g: any) => g.names);

describe("sidebar filter logic (#999)", () => {
  it("shows every instance, with the full count, for an empty or blank query", () => {
    for (const query of ["", "   ", "\t"]) {
      const v = view.filterSidebar(groups, byGroup, byName, query, view.backendLabel);
      expect(v).toMatchObject({ shown: 4, total: 4, active: false });
      expect(v.groups.map((g: any) => g.group)).toEqual(["AgEnD", "DouPo", "Other"]);
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
    const none = view.filterSidebar(groups, byGroup, byName, "no-such-thing", view.backendLabel);
    expect(none).toMatchObject({ groups: [], shown: 0, total: 4, active: true });
  });

  it("drops groups with no match, keeps display order, and counts N / M over live roster rows", () => {
    const v = view.filterSidebar(groups, byGroup, byName, "o", view.backendLabel);
    expect(v.groups.map((g: any) => g.group)).toEqual(["AgEnD", "DouPo", "Other"]);
    const claude = view.filterSidebar(groups, byGroup, byName, "claude", view.backendLabel);
    expect(claude.groups).toEqual([{ group: "AgEnD", names: ["agend-dev-claude"] }]);
    // "gone-from-roster" is in the saved order but not the roster: never counted.
    expect(claude).toMatchObject({ shown: 1, total: 4, active: true });
  });

  it("tolerates missing fields", () => {
    expect(view.instanceMatchesFilter({ instance_name: "x" }, "x")).toBe(true);
    expect(view.instanceMatchesFilter({ instance_name: "x", model: null, backend: undefined }, "y")).toBe(false);
    expect(view.normalizeFilter(undefined)).toBe("");
  });
});

describe("sidebar filter wiring (#999)", () => {
  it("lists the groups and their instances, each linking to its own View page", async () => {
    await mountView();
    expect(groupHeads()).toEqual(["AgEnD", "DouPo", "Other"]);
    expect(rowNames()).toEqual(["agend-dev-claude", "leader", "doupo-server-codex", "grok-scout"]);
    expect(p.root.querySelectorAll(".v-inst").map((a: any) => a.getAttribute("href"))).toContain("/view/leader");
    expect(count()).toBe("4 / 4");
  });

  it("the filter sits after the groups, inside the roster, with its input, clear button and count", async () => {
    await mountView();
    const roster = p.root.querySelector(".view-roster")!;
    const kids = roster.children.map((c: any) => c.className);
    expect(kids).toEqual(["side-section", "v-filter"]);                 // the list first, the filter under it
    expect(roster.querySelector(".side-section .v-group")).not.toBeNull();
    expect(input()).not.toBeNull();
    expect(p.root.querySelector(".v-filter-clear")).toBeNull();      // no clear button until there is a query
    await typeInto("x");
    expect(p.root.querySelector(".v-filter-clear")).not.toBeNull();
  });

  // Intent (#999, view.html): the filter stays put under the scrolling list, so a long list scrolls past the groups
  // while the box stays in view. The scroller is .side-section (app.css overflow-y: auto); the filter is its sibling.
  it("the filter is pinned under the scrolling list, outside its scroll area", async () => {
    await mountView();
    const roster = p.root.querySelector(".view-roster")!;
    expect(roster.classList.contains("side-section")).toBe(false);
    expect(p.root.querySelector(".side-section .v-filter")).toBeNull();
    expect(p.root.querySelector(".side-section #filterInput")).toBeNull();
  });

  it("filters on every keystroke, through the roster's render", async () => {
    await mountView();
    await typeInto("codex");
    expect(rowNames()).toEqual(["doupo-server-codex"]);
    expect(groupHeads()).toEqual(["DouPo"]);
    expect(count()).toBe("1 / 4 shown");
    await typeInto("");
    expect(rowNames()).toHaveLength(4);
    expect(count()).toBe("4 / 4");
  });

  it("keeps the query across the roster's 5-second refresh: a new roster renders through the same filter", async () => {
    await mountView();
    await typeInto("codex");
    roster = [...ROSTER,
      { instance_name: "new-claude", display_name: null, model: "claude", backend: "claude-code", tags: ["AgEnD"], status: "running", context_pct: null },
      { instance_name: "new-codex", display_name: null, model: "gpt", backend: "codex", tags: ["DouPo"], status: "running", context_pct: null }];
    // The refresh runs on a visible tab's focus change (visibilitychange), the same load() the 5-second timer calls.
    fire(p.document as any, "visibilitychange");
    await settle(8);
    expect(input().value).toBe("codex");
    expect(rowNames()).toEqual(["doupo-server-codex", "new-codex"]);
    expect(count()).toBe("2 / 6 shown");
  });

  it("a miss shows the empty state, and clearing the query brings everything back", async () => {
    await mountView();
    await typeInto("zzz");
    expect(rowNames()).toEqual([]);
    expect(p.root.querySelector(".side-empty")!.textContent).toBe("No instance matches");
    fire(p.root.querySelector(".v-filter-clear")!, "click");
    await settle();
    expect(input().value).toBe("");
    expect(rowNames()).toHaveLength(4);
  });

  it("Escape in the filter clears it", async () => {
    await mountView();
    await typeInto("codex");
    fire(input(), "keydown", { key: "Escape" });
    await settle();
    expect(input().value).toBe("");
    expect(count()).toBe("4 / 4");
  });

  it("while a filter hides rows, groups and rows are not draggable (a filtered reorder is ambiguous)", async () => {
    await mountView();
    expect(p.root.querySelector(".v-group-head")!.getAttribute("draggable")).toBe("true");
    await typeInto("a");
    expect(p.root.querySelector(".v-group-head")!.getAttribute("draggable")).toBeNull();
    expect(p.root.querySelector(".v-inst")!.getAttribute("draggable")).toBeNull();
  });

  it("the new strings exist in English and Traditional Chinese", () => {
    for (const key of ["filterPh", "filterClear", "filterNone", "filterShown"]) {
      i18n.setLang("en");
      const en = i18n.t(`view.${key}`);
      i18n.setLang("zh-TW");
      const zh = i18n.t(`view.${key}`);
      expect(en, key).not.toBe(`view.${key}`);
      expect(zh, key).not.toBe(`view.${key}`);
      expect(zh, key).not.toBe(en);
    }
  });
});
