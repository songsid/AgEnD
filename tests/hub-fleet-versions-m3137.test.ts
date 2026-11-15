/**
 * M-3137 (docs/design/hub-fleet-versions.md, phase 1): Administration → Connected fleets says each Fleet's AgEnD version,
 * when it last connected and one state tag, with a summary line and a "Needs update" filter (§2.2); a signed-in person
 * whose own Fleet is behind sees one banner, closed for that sign-in (§2.3). No red badges or counts (the user's rule):
 * plain tags. An overview without the version fields (an older Hub) draws what it drew before.
 * The real Hub panel and the module, a stub client (the shape M-3136 serves).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let panel: any, clients: any, words: any, v: any; const pages: AppPage[] = [];
const until = async (fn: () => unknown) => { for (let i = 0; i < 100 && !fn(); i++) await settle(5); expect(fn()).toBeTruthy(); };
beforeAll(async () => { const p = page(); panel = await import("/ui/js/panel-hub.js"); clients = await import("/ui/js/hub-client.js"); words = await import("/assets/app-i18n.js"); v = await import("/ui/js/hub-fleet-versions.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } panel.resetHubSession(); clients.setHubClient(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const NOW = Date.now(), DAY = 86_400_000;
const own = (name: string) => ({ realm: "example", objectId: name.toLowerCase(), name, login: name.toLowerCase() });
const FLEETS = [
  { id: "a", status: "active", label: "build-box", owner: own("Carol"), version: "2.4.0-beta.3", connected: true, lastConnectedAt: NOW, versionState: "current" },
  { id: "b", status: "active", label: "old-box", owner: own("Dave"), version: "2.3.4", connected: false, lastConnectedAt: NOW - 3 * DAY, versionState: "too-old-rooms" },
  { id: "c", status: "active", label: "mystery", owner: own("Erin"), version: null, connected: false, lastConnectedAt: null, versionState: "unknown" },
  { id: "r", status: "revoked", label: "gone", owner: own("Bob"), version: "2.0.0", connected: false, lastConnectedAt: NOW - 30 * DAY, versionState: "needs-update" },
];

const KEY = "agend_hub_versions_banner_closed";
async function fixture(o: { lang?: string; tab?: string; fleets?: any[]; recommended?: string | null; mine?: any[]; csrf?: string; closedMark?: string } = {}) {
  const p = page({ url: `https://hub.example.test/ui/hub/${o.tab === "ask" ? "" : "admin"}`, storage: { agend_lang: o.lang ?? "en", agend_tour_done: "1" } }); pages.push(p); words.setLang(o.lang ?? "en");
  if (o.closedMark) (globalThis as any).sessionStorage.setItem(KEY, o.closedMark);   // this tab's session, as a reload keeps it
  const session = { ok: true, signedIn: true, displayName: "Ada", login: "ada", admin: true, csrf: o.csrf ?? "csrf-1", features: [] };
  const c = { stub: false, web: true, onSignedOut: () => () => {}, session: vi.fn(async () => session), rooms: async () => ({ ok: true, rooms: [] }), catalog: async () => ({ ok: true, askable: [] }),
    pairings: async () => ({ ok: true, pairings: [] }),
    adminOverview: vi.fn(async () => ({ ok: true, fleets: o.fleets ?? FLEETS, pairings: [], ...(o.recommended !== undefined ? { recommendedVersion: o.recommended } : {}) })),
    myFleets: vi.fn(async () => ({ ok: true, fleets: o.mine ?? [] })) };
  clients.setHubClient(c);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
  await p.mount(h(panel.HubPanel, { route: { panel: "hub", tab: o.tab ?? "admin" } })); await settle(30);
  return { p, c };
}
const rows = (p: AppPage) => [...p.root.querySelectorAll(".hub-fleet-list .hub-rows > [data-fleet]")].filter((r: any) => !r.closest("details")) as any[];

describe("the words (pure)", () => {
  it("the summary: no recommendation (phase 1), some behind, all current — over the active rows only", () => {
    words.setLang("en");
    expect(v.summaryText(FLEETS, null)).toBe("3 active Fleets.");
    expect(v.summaryText(FLEETS, "2.4.0")).toBe("2 of 3 Fleets need an update.");
    expect(v.summaryText([FLEETS[0]], "2.4.0")).toBe("All 1 Fleets are on the recommended version or newer.");
    words.setLang("zh-TW");
    expect(v.summaryText(FLEETS, "2.4.0")).toBe("3 個 Fleet 當中有 2 個需要更新。");
    expect(v.versionCounts(FLEETS)).toEqual({ total: 3, needs: 2 });
  });
  it("last connected: Now, a relative time, Never", () => {
    words.setLang("en");
    expect([v.lastConnectedText(FLEETS[0], NOW), v.lastConnectedText(FLEETS[1], NOW), v.lastConnectedText(FLEETS[2], NOW)]).toEqual(["Now", "3 days ago", "Never"]);
    words.setLang("zh-TW");
    expect([v.lastConnectedText(FLEETS[0], NOW), v.lastConnectedText(FLEETS[1], NOW), v.lastConnectedText(FLEETS[2], NOW)]).toEqual(["目前已連接", "3 天前", "從未連接"]);
  });
  it("a warn tag's sentence; Up to date has none", () => {
    words.setLang("en");
    expect([v.tagWhy(FLEETS[1]), v.tagWhy(FLEETS[2]), v.tagWhy({ ...FLEETS[3] }, "2.4.0"), v.tagWhy(FLEETS[0])]).toEqual([
      "This Fleet's agents cannot answer in rooms until it is updated.",
      "This Fleet is too old to report its version. Ask its owner to update it.",
      "This Fleet runs 2.0.0; the recommended version is 2.4.0.", ""]);
    expect(v.tagWhy(FLEETS[3], null), "no recommendation known: never an empty \"is .\"").toBe("This Fleet runs 2.0.0, older than the recommended version.");
  });
});

describe("Administration → Connected fleets", () => {
  it("each active row: its tag first, AgEnD version, last connected; a warn tag's sentence under it; plain tags, no badge", async () => {
    const { p } = await fixture();
    await until(() => p.root.querySelector(".hub-fleet-summary"));
    expect(p.root.querySelector(".hub-fleet-summary .note").textContent).toBe("3 active Fleets.");
    const facts = rows(p).map((r) => [r.getAttribute("data-fleet"), r.querySelector(".hub-fleet-tag").textContent, r.querySelector(".hub-fleet-tag").className,
      r.querySelector(".hub-fleet-ver span").textContent, r.querySelector(".hub-fleet-last").textContent.replace(/\s+/g, " ").trim(), r.querySelector(".hub-fleet-why")?.textContent ?? null]);
    expect(facts).toEqual([
      ["a", "Up to date", "tag hub-fleet-tag", "2.4.0-beta.3", "Last connected Now", null],
      ["b", "Too old for rooms", "tag hub-fleet-tag warn", "2.3.4", "Last connected 3 days ago", "This Fleet's agents cannot answer in rooms until it is updated."],
      ["c", "Version unknown", "tag hub-fleet-tag warn", "Unknown", "Last connected Never", "This Fleet is too old to report its version. Ask its owner to update it."],
    ]);
    expect(rows(p)[0].querySelector(".hub-fleet-last .dot.ok"), "Now: the green dot").toBeTruthy();
    expect(p.root.querySelector(".hub-fleet-list .nav-count, .hub-fleet-list .badge"), "no badge").toBeNull();
    expect(p.root.querySelector('details.hub-fleets-revoked [data-fleet="r"] .hub-fleet-version'), "a revoked row: none").toBeNull();
  });

  it("Needs update filters the list to those that need one, and back", async () => {
    const { p } = await fixture();
    await until(() => p.root.querySelector(".hub-fleet-filter"));
    const chip = p.root.querySelector(".hub-fleet-filter") as any;
    expect([chip.textContent, chip.getAttribute("aria-pressed")]).toEqual(["Needs update", "false"]);
    fire(chip, "click"); await settle(5);
    expect([rows(p).map((r) => r.getAttribute("data-fleet")), (p.root.querySelector(".hub-fleet-filter") as any).getAttribute("aria-pressed")]).toEqual([["b", "c"], "true"]);
    fire(p.root.querySelector(".hub-fleet-filter") as any, "click"); await settle(5);
    expect(rows(p).map((r) => r.getAttribute("data-fleet"))).toEqual(["a", "b", "c"]);
  });

  it("pressed, the filter stays once nothing needs an update any more (the last one updated meanwhile), so the list can come back", async () => {
    const pg = page({ url: "https://hub.example.test/ui/hub/admin", storage: { agend_lang: "en" } }); pages.push(pg); words.setLang("en");
    const allCurrent = FLEETS.map((f) => ({ ...f, versionState: "current" })), clicks: boolean[] = [];
    await pg.mount(h("div", {}, h(v.FleetVersionsSummary, { fleets: allCurrent, recommended: "2.4.0", filtered: true, onFilter: (x: boolean) => clicks.push(x) }),
      h("div", { class: "unpressed" }, h(v.FleetVersionsSummary, { fleets: allCurrent, recommended: "2.4.0", filtered: false }))));
    await settle(3);
    const [pressed, unpressed] = [pg.root.querySelector(".hub-fleet-filter") as any, pg.root.querySelector(".unpressed .hub-fleet-filter")];
    expect([pressed?.getAttribute("aria-pressed"), unpressed]).toEqual(["true", null]);
    fire(pressed, "click");
    expect(clicks).toEqual([false]);
  });

  it("every Fleet current: the all-current line and no filter (zh-TW)", async () => {
    const { p } = await fixture({ lang: "zh-TW", fleets: [FLEETS[0]], recommended: "2.4.0" });
    await until(() => p.root.querySelector(".hub-fleet-summary"));
    expect([p.root.querySelector(".hub-fleet-summary .note").textContent, p.root.querySelector(".hub-fleet-filter")]).toEqual(["1 個 Fleet 都是建議版本或更新的版本。", null]);
  });

  it("an older Hub (no version fields): the list as before — no summary, no columns", async () => {
    const plain = FLEETS.map(({ version: _v, connected: _c, lastConnectedAt: _l, versionState: _s, ...f }) => f);
    const { p } = await fixture({ fleets: plain });
    await until(() => rows(p).length === 3);
    expect([p.root.querySelector(".hub-fleet-summary"), p.root.querySelector(".hub-fleet-version")]).toEqual([null, null]);
  });
});

describe("the signed-in person's own Fleet is behind (§2.3)", () => {
  it("one Fleet: named with its version; unknown: without it; several: counted; none behind: nothing", async () => {
    for (const [mine, text] of [
      [[{ id: "x", label: "laptop", version: "2.3.4", versionState: "too-old-rooms" }], "Your Fleet “laptop” runs an older AgEnD (2.3.4). Some features here will not work until you update it. Open your AgEnD dashboard and press Update."],
      [[{ id: "x", label: "laptop", version: null, versionState: "unknown" }], "Your Fleet “laptop” runs an older AgEnD. Some features here will not work until you update it. Open your AgEnD dashboard and press Update."],
      [[{ id: "x", label: null, version: null, versionState: "unknown" }], "One of your Fleets runs an older AgEnD. Some features here will not work until you update it. Open your AgEnD dashboard and press Update."],
      [[{ id: "x", label: "a", version: "2.3.4", versionState: "needs-update" }, { id: "y", label: "b", version: null, versionState: "unknown" }, { id: "z", label: "c", version: "2.4.0", versionState: "current" }], "2 of your Fleets run an older AgEnD. Some features here will not work until you update them. Open your AgEnD dashboard and press Update."],
      [[{ id: "z", label: "c", version: "2.4.0", versionState: "current" }], null],
    ] as const) {
      const { p } = await fixture({ tab: "ask", mine: mine as any });
      await settle(10);
      expect(p.root.querySelector(".hub-versions-banner span")?.textContent ?? null).toBe(text);
      for (const x of pages.splice(0)) { await x.unmount(); x.restore(); } panel.resetHubSession();
    }
  });

  it("closed: gone for this sign-in (a fresh page of it too); a new sign-in shows it again — and the token is never stored", async () => {
    const mine = [{ id: "x", label: "laptop", version: "2.3.4", versionState: "needs-update" }];
    let f = await fixture({ tab: "ask", mine, csrf: "csrf-A" });
    await until(() => f.p.root.querySelector(".hub-versions-banner"));
    fire(f.p.root.querySelector(".hub-versions-banner button") as any, "click"); await settle(5);
    expect(f.p.root.querySelector(".hub-versions-banner")).toBeNull();
    const stored = (globalThis as any).sessionStorage.getItem(KEY) as string;
    expect([typeof stored, stored === "csrf-A", String(stored).includes("csrf")]).toEqual(["string", false, false]);
    for (const x of pages.splice(0)) { await x.unmount(); x.restore(); } panel.resetHubSession();
    f = await fixture({ tab: "ask", mine, csrf: "csrf-A", closedMark: stored }); await settle(10);
    expect(f.p.root.querySelector(".hub-versions-banner"), "the same sign-in: still closed").toBeNull();
    for (const x of pages.splice(0)) { await x.unmount(); x.restore(); } panel.resetHubSession();
    f = await fixture({ tab: "ask", mine, csrf: "csrf-B", closedMark: stored });
    await until(() => f.p.root.querySelector(".hub-versions-banner"));
  });
});

it("the module is the Hub's own (served by the Hub listener) and its stylesheet rules are there", () => {
  const compose = readFileSync(join(process.cwd(), "src/hub/http/compose.ts"), "utf8");
  expect(compose).toContain('"hub-fleet-versions.js"');
  const css = readFileSync(join(process.cwd(), "src/ui/shared/hub-owner.css"), "utf8");
  for (const rule of [".hub-fleet-version .hub-fleet-why { flex: 1 1 100%; white-space: normal; }",
    ".hub-fleet-list .hub-fleet-version { flex: 1 1 100%; flex-direction: column; align-items: flex-start; gap: 2px; }"]) expect(css).toContain(rule);
});
