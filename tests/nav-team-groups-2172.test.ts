/**
 * #2172 (user, with a screenshot): with no filter, an agent in team agend-dev with the tags wiki, docs, knowledge was
 * listed under "wiki" — the sidebar grouped by the first tag and knew nothing of teams. Now:
 * - the status frame and View's roster carry each instance's teams (fleet.yaml order; instanceTeams);
 * - an agent in a team sits under its first team, one in no team under its first tag, a ClassicBot room under Classic;
 * - teams first, then tags, "Other" last (unless this browser ordered them); a team and a tag of the same name apart;
 * - each heading says what it is (a team's icon / "#" before a tag), in the sidebar and in Settings → Agents.
 * Real Shell, store and router in a mini DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { instanceTeams } from "../src/view-api.js";
import { guestStatus } from "../src/web-guest-access.js";
// @ts-expect-error — a JS module of the app, with no types
import { groupAgents } from "../src/ui/settings-model.js";

const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
  const nav = await import("/assets/instance-nav.js");
  nav.navStore.set({ order: { groups: new Map(), insts: new Map() }, collapsed: new Set(), filter: { q: "", status: [], cli: [] } });
  (await import("/assets/app-i18n.js")).setLang("en");
});

const live = (name: string, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", model: "opus", context_pct: 10, tags: [], teams: [], execution_state: "idle", ...o });
const INSTANCES = [
  live("wiki-keeper", { tags: ["wiki", "docs", "knowledge"], teams: ["platform-team"] }),      // the user's case
  live("api-builder", { tags: ["backend"], teams: ["platform-team", "release-crew"] }),       // two teams: the first
  live("release-notes", { tags: ["release-crew"], teams: ["release-crew"] }),
  live("docs-writer", { tags: ["wiki"] }),                                                   // no team: its first tag
  live("tagged-like-a-team", { tags: ["platform-team"] }),                                   // a tag named like a team
  live("loner"),
];
const Stub = (name: string) => ({ Component: () => h("div", { class: `stub-${name}` }, name) });
const PANELS = new Map([["chat", Stub("chat")], ["view", Stub("view")], ["fleet", Stub("fleet")], ["settings", Stub("settings")], ["needs", Stub("needs")]]);
async function app(lang = "en") {
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/loner", storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  (globalThis as { fetch?: unknown }).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  (await import("/assets/app-i18n.js")).setLang(lang);
  startRouter(pg.window);
  applyStatus({ instances: INSTANCES });
  (await import("/assets/instance-nav.js")).loadNavPrefs();
  await pg.mount(h(Shell, { panels: PANELS, onNewInstance() {} }));
  await settle(3);
  return pg;
}
/** The sidebar as a person reads it: each group's mark, heading and rows. */
const sidebar = (pg: AppPage) => (pg.root.querySelectorAll(".v-group:not(.v-fav)") as any[]).map((g) => ({
  mark: g.querySelector(".v-group-kind") ? (g.querySelector(".v-group-kind.team") ? "team" : "#") : "",
  head: g.querySelector(".v-group-head .grow").textContent,
  rows: (g.querySelectorAll(".inst-list li") as any[]).length,
}));

describe("#2172: with no filter, an agent sits under its team", () => {
  it("the user's case: a team member with unrelated tags is under its team; teams first, then tags, Other last; a tag named like a team apart", async () => {
    const pg = await app();
    expect(sidebar(pg)).toEqual([
      { mark: "team", head: "platform-team", rows: 2 },     // wiki-keeper and api-builder (its first team)
      { mark: "team", head: "release-crew", rows: 1 },
      { mark: "#", head: "platform-team", rows: 1 },       // the tag: its own group, marked as a tag
      { mark: "#", head: "wiki", rows: 1 },                // docs-writer, in no team
      { mark: "", head: "Other", rows: 1 },
    ]);
  });
  it("the marks say what they are, in the page's language (a title, and a screen reader's word for a team)", async () => {
    const pg = await app("zh-TW");
    const team = pg.root.querySelector(".v-group-kind.team") as any, tag = pg.root.querySelector(".v-group-kind.tag") as any;
    expect([team.getAttribute("title"), team.querySelector(".sr-only").textContent, tag.getAttribute("title"), tag.getAttribute("aria-hidden")]).toEqual(["團隊", "團隊: ", "標籤", "true"]);
  });
  it("groupOf, groupKind, groupLabel", async () => {
    const nav = await import("/assets/instance-nav.js");
    expect(nav.groupOf({ tags: ["wiki"], teams: ["agend-dev"] })).toBe(`${nav.TEAM_GROUP}agend-dev`);
    expect(nav.groupOf({ tags: ["wiki"], teams: [] })).toBe("wiki");
    expect(nav.groupOf({ tags: ["classic"], teams: ["agend-dev"] }), "a ClassicBot room stays under Classic").toBe("Classic");
    expect(nav.groupOf({ teams: [null, "", "x"] }), "strings only").toBe(`${nav.TEAM_GROUP}x`);
    expect(nav.groupOf({})).toBe("Other");
    expect([nav.groupKind(`${nav.TEAM_GROUP}agend-dev`), nav.groupKind("wiki"), nav.groupKind("Other"), nav.groupKind("Classic"), nav.groupKind("\u0000favorites")])
      .toEqual(["team", "tag", null, null, null]);
    expect(nav.groupLabel(`${nav.TEAM_GROUP}agend-dev`)).toBe("agend-dev");
  });
});

describe("where the teams come from", () => {
  it("instanceTeams: every team listing the instance, in fleet.yaml's order; a team without a members list is none", () => {
    const teams = { "release-crew": { members: ["a", "b"] }, broken: { members: "a" }, "agend-dev": { members: ["c", "a"] }, empty: {} } as any;
    expect(instanceTeams(teams, "a")).toEqual(["release-crew", "agend-dev"]);
    expect(instanceTeams(teams, "z")).toEqual([]);
    expect(instanceTeams(undefined, "a")).toEqual([]);
  });
  it("a guest's status frame keeps none of it (like the tags: the fleet's shape is the admins')", () => {
    const g = guestStatus({ instances: [{ name: "a", status: "running", tags: ["wiki"], teams: ["agend-dev"] }] }, new Set(["a"]));
    expect(g.instances).toEqual([{ name: "a", status: "running" }]);
  });
});

describe("Settings → Agents groups the same way", () => {
  it("groupAgents with the sidebar's rule: teams first, then tags, Other last; without it, the first tag as before", async () => {
    const nav = await import("/assets/instance-nav.js");
    const insts = { "wiki-keeper": { tags: ["wiki", "docs"] }, "docs-writer": { tags: ["wiki"] }, loner: {} };
    const teams: Record<string, string[]> = { "wiki-keeper": ["zeta-team"] };          // after "wiki" by name: first only as a team
    const grouped = groupAgents(insts, {}, "", (n: string) => nav.groupOf({ tags: (insts as any)[n].tags, teams: teams[n] ?? [] }), nav.groupLabel);
    expect(grouped.map((g: any) => [nav.groupLabel(g.group), g.names])).toEqual([["zeta-team", ["wiki-keeper"]], ["wiki", ["docs-writer"]], ["Other", ["loner"]]]);
    expect(groupAgents(insts, {}, "").map((g: any) => g.group)).toEqual(["wiki", "Other"]);
  });
});
