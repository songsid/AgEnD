/**
 * #2347 regrouping: the Settings sections in two groups — You (Preferences, Look) and Fleet (Agents, Agent defaults,
 * Chat & connections, Web dashboard, Access & security, Advanced) — each card where the person looks for it (#2347 §3),
 * the old addresses leading to the new sections (ClassicBot's to its place: /settings/chat#classicbot), and a split
 * form (the defaults, Web) still one form with one draft.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { shellRoute } from "../src/web-shell-routes.js";

const schema = buildSettingsImpactSchema();
let p: AppPage;
const realFetch = (globalThis as any).fetch;
const sent: Array<{ method: string; path: string; body: any }> = [];
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  const body = (() => {
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/schema") return { ...schema, provider_secrets: true };
    if (path === "/api/settings/fleet/raw") return { defaults: { locale: "en" }, instances: {}, channels: [{ id: "main", type: "discord", bot_token_env: "T", group_id: "1" }], web: {}, project_roots: ["/srv/projects"] };
    if (path === "/api/settings/classic") return { defaults: {}, channels: { "c1": { name: "ops", instanceName: "ops-t1", channelId: "1" } } };
    if (path === "/api/settings/provider-secrets") return [{ id: "openai", display_name: "OpenAI", verifier: "available", token_present: false }];
    if (path === "/api/settings/connections") return [{ id: "main", token_present: true }];
    if (path === "/api/fleet") return { version: "2.4.0", instances: [] };
    if (path === "/ui/owner-css/state") return { active: null, pending: null, text: "", versions: [], assets: [], limits: { maxAssets: 16 } };
    if (path === "/api/settings/guests") return { enabled: false, chat: true, instances: [], connections: [], guests: [] };
    if (path.startsWith("/ui/")) return {};
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
let nav: any, route: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19283/settings", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  nav = await import("/assets/app-nav.js");
  route = await import("/assets/app-route.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { (globalThis as any).confirm = () => true; });
afterEach(async () => { await p.unmount(); });

const open = async (section: string) => {
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}` }));
  await settle(14);
};
const has = (sel: string) => !!p.root.querySelector(sel);

describe("#2347: the sections in two groups, and the old addresses", () => {
  it("You: Preferences, Look; Fleet: Agents … Advanced — the nav shows both groups with their names, in that order", async () => {
    await open("agents");
    const groups = p.root.querySelectorAll(".s-nav .s-nav-group").map((g: any) => [g.querySelector(".s-nav-head").textContent,
      g.querySelectorAll(".seg-item").map((a: any) => a.textContent.trim())]);
    expect(groups).toEqual([["You", ["Preferences", "Look"]],
      ["Fleet", ["Agents", "Agent defaults", "Chat & connections", "Web dashboard", "Access & security", "Advanced"]]]);
    expect(p.root.querySelector(".s-nav .seg-item[aria-current=page]").textContent.trim()).toBe("Agents");
  });
  it("each old address names its new section, on the page and on the server; ClassicBot's carries its place", () => {
    const want = { device: "preferences", appearance: "look", general: "agent-defaults", bots: "chat", classic: "chat", web: "access" };
    for (const [old, section] of Object.entries(want)) {
      expect([route.parseRoute(`/settings/${old}`), shellRoute("GET", `/settings/${old}`)], old)
        .toEqual([{ panel: "settings", section }, { kind: "shell", route: { panel: "settings", section } }]);
    }
    expect([route.legacySettingsTarget("/settings/classic"), route.legacySettingsTarget("/settings/general"), route.legacySettingsTarget("/settings/chat"),
      route.settingsPath("classic"), route.settingsPath("bots"), route.settingsPath("agents")])
      .toEqual(["/settings/chat#classicbot", "/settings/agent-defaults", null, "/settings/chat#classicbot", "/settings/chat", "/settings"]);
  });
  it("#2382 review: only the names of the table are old names — constructor, __proto__, toString are no section", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect([route.parseRoute(`/settings/${name}`), shellRoute("GET", `/settings/${name}`), route.legacySettingsTarget(`/settings/${name}`), route.settingsPath(name)], name)
        .toEqual([null, null, null, `/settings/${name}`]);
    }
  });
  it("#2382 review: an old address with a place of its own keeps it (its new one names none)", () => {
    nav.navigate("/settings/web#guests");
    expect([p.window.location.pathname, p.window.location.hash]).toEqual(["/settings/access", "#guests"]);
    nav.navigate("/settings/classic#other");                             // a new one with its own place keeps that
    expect([p.window.location.pathname, p.window.location.hash]).toEqual(["/settings/chat", "#classicbot"]);
    nav.navigate("/settings");
  });
  it("going to an old address lands on the new one (the address bar too), with the place in it", () => {
    nav.navigate("/settings/general");
    expect([p.window.location.pathname, nav.navStore.get().route]).toEqual(["/settings/agent-defaults", { panel: "settings", section: "agent-defaults" }]);
    nav.navigate("/settings/classic");
    expect([p.window.location.pathname, p.window.location.hash, nav.navStore.get().route.section]).toEqual(["/settings/chat", "#classicbot", "chat"]);
    nav.navigate("/settings");
  });
});

describe("#2347: every card where it belongs", () => {
  it.each([
    ["preferences", ["#fx-follow-reduced-motion", ".s-synced"], [".s-colors-off", "#g-locale"]],
    ["look", [".s-colors-off", ".s-owner-css"], ["#fx-follow-reduced-motion", ".s-app-icon"]],
    ["agents", [".list-head", ".s-key"], [".s-conn", "#g-locale"]],           // the provider API keys moved here
    ["agent-defaults", ["#g-locale", "#g-ll"], ["#g-cbe", "#webEchoToChannel"]],
    ["chat", [".s-conn", "#webEchoToChannel", "#classicbot", "#g-cbe"], ["#g-locale", ".s-key", "#webSessionAbsolute"]],
    ["web-dashboard", ["#webLogTab", "#webUsagePublic"], ["#webSessionAbsolute", "#webEchoToChannel"]],
    ["access", ["#webSessionAbsolute", "#webTerminalEnabled", "#publicWebLink"], ["#webLogTab", ".s-web-ro"]],
    ["advanced", [".s-dev", ".s-web-ro"], ["#webSessionAbsolute"]],
  ])("%s holds what it should, and not what moved elsewhere", async (section, present, absent) => {
    await open(section as string);
    expect([(present as string[]).filter((s) => !has(s)), (absent as string[]).filter(has)]).toEqual([[], []]);
  });
  it("an old link to a place in a section goes there once it is drawn (/settings/chat#classicbot)", async () => {
    nav.navigate("/settings/classic");
    const seen: string[] = [];
    const proto = Object.getPrototypeOf(p.document.createElement("div"));
    const was = proto.scrollIntoView;
    proto.scrollIntoView = function (this: any) { seen.push(this.id); };
    (globalThis as any).location = p.window.location;
    try { await open("chat"); } finally { proto.scrollIntoView = was; }
    expect(seen).toContain("classicbot");
    nav.navigate("/settings");
  });
});

describe("#2347 §10: Fleet → Config is gone; its project folders are in Agent defaults", () => {
  it("Project folders shows what is saved; adding one is one unsaved change; Save writes it where it is written (POST /ui/config)", async () => {
    sent.length = 0;
    await open("agent-defaults");
    const box = p.root.querySelector("#project-roots");
    const shown = box.querySelectorAll(".chip").map((c: any) => c.textContent.trim());
    const input: any = box.querySelector("input[type=text]");
    input.value = "/home/me/code"; fire(input, "input"); await settle(2);
    box.querySelectorAll("button").find((b: any) => b.textContent.includes("Add")).click(); await settle(6);
    const bar = p.root.querySelector(".s-pending");
    const marked = /s-dirty/.test(p.root.querySelector("#g-roots").getAttribute("class"));
    bar.querySelectorAll("button").find((b: any) => b.textContent === "Save").click(); await settle(12);
    expect([shown, !!bar, marked, sent.filter((x) => x.method === "POST" && x.path === "/ui/config").map((x) => x.body)])
      .toEqual([["/srv/projects"], true, true, [{ project_roots: ["/srv/projects", "/home/me/code"] }]]);
  });
  it("a folder named only by digits (ChipList keeps it as a number) is sent as the path it is", async () => {
    sent.length = 0;
    await open("agent-defaults");
    const box = p.root.querySelector("#project-roots");
    const input: any = box.querySelector("input[type=text]");
    input.value = "2024"; fire(input, "input"); await settle(2);
    box.querySelectorAll("button").find((b: any) => b.textContent.includes("Add")).click(); await settle(6);
    p.root.querySelector(".s-pending").querySelectorAll("button").find((b: any) => b.textContent === "Save").click(); await settle(12);
    expect(sent.filter((x) => x.method === "POST" && x.path === "/ui/config").map((x) => x.body)).toEqual([{ project_roots: ["/srv/projects", "2024"] }]);
  });
  it("the old /ui/fleet/config leads to Agent defaults at Project folders, on the page and the server; Fleet has no Config tab", () => {
    const { FLEET_TABS } = route;
    nav.navigate("/ui/fleet/config");
    expect([FLEET_TABS.includes("config"), p.window.location.pathname, p.window.location.hash, nav.navStore.get().route,
      route.parseRoute("/ui/fleet/config"), shellRoute("GET", "/ui/fleet/config")])
      .toEqual([false, "/settings/agent-defaults", "#project-roots", { panel: "settings", section: "agent-defaults" },
        { panel: "settings", section: "agent-defaults" }, { kind: "shell", route: { panel: "settings", section: "agent-defaults" } }]);
    nav.navigate("/settings");
  });
});

// #2347 §7: on a phone /settings is the list of sections; a section has its own address (Agents too), and "‹ Settings".
describe("#2347 §7: the list of sections and a section on its own (phone)", () => {
  it("sectionPath: a section's own address, Agents included; settingsPath() stays Settings itself", () => {
    expect(["agents", "agent-defaults", "access", "classic", undefined].map((k) => route.sectionPath(k)))
      .toEqual(["/settings/agents", "/settings/agent-defaults", "/settings/access", "/settings/chat#classicbot", "/settings/agents"]);   // an old name: its place
    expect([route.settingsPath(), route.settingsPath("agents"), route.parseRoute ? route.parseRoute("/settings/agents")?.section : "agents"]).toEqual(["/settings", "/settings", "agents"]);
  });
  it("at /settings the panel is the list (data-view=index); at a section it is not; every row links to its section's own address", async () => {
    nav.navigate("/settings"); await open("agents");
    const panel = () => p.root.querySelector(".p-settings");
    const atList = [panel().getAttribute("class"), panel().getAttribute("data-view"), p.root.querySelectorAll(".s-nav .seg-item").map((a: any) => a.getAttribute("href"))];
    nav.navigate("/settings/agent-defaults"); await open("agent-defaults");
    const back = p.root.querySelector(".p-settings .panel-body .s-back");
    expect([atList, panel().getAttribute("class"), panel().getAttribute("data-view"), back?.getAttribute("href"), back?.textContent.trim()]).toEqual([
      // #1629: the root's class is the effects producer's, exactly — which view is shown is data-view.
      ["panel p-settings", "index", ["/settings/preferences", "/settings/look", "/settings/agents", "/settings/agent-defaults", "/settings/chat", "/settings/web-dashboard", "/settings/access", "/settings/advanced"]],
      "panel p-settings", "section", "/settings", "SettingsAgent defaults"]);
    nav.navigate("/settings");
  });
  it("the CSS: on a phone the list is alone at /settings, a section alone with ‹ Settings; the list marks no section", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const phone = css.slice(css.indexOf(".p-settings .s-back { display: none; }"));
    for (const rule of [/\.p-settings\[data-view="index"\] > \.panel-body\s*\{\s*display:\s*none/, /\.p-settings\[data-view="section"\] > \.s-nav\s*\{\s*display:\s*none/,
      /\.p-settings\[data-view="index"\] > \.s-nav \.seg-item\.active::before\s*\{\s*display:\s*none/, /\.p-settings > \.panel-body \.s-back\s*\{\s*display:\s*flex/,
      // #2501 review: on a short screen the list takes the room there is and scrolls (it fills a tall one).
      /\.p-settings\[data-view="index"\] > \.s-nav\s*\{\s*flex:\s*1 1 auto;\s*min-height:\s*0;\s*overflow-y:\s*auto/]) expect(phone).toMatch(rule);
    expect(css.slice(css.indexOf(".p-settings .s-back { display: none; }") - 40, css.indexOf(".p-settings .s-back { display: none; }") + 200)).toMatch(/@media \(max-width: 899px\)/);
  });
  it("the CSS (§7): on a phone Settings' dialogs are full-screen sheets; its title stays whole, the version takes what room is left", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const at = css.indexOf(".p-settings .dlg {");
    // Inside the phone block (the nearest media query before it is the phone one, and no block closed between).
    const before = css.slice(0, at), media = before.lastIndexOf("@media");
    expect(before.slice(media, media + 30)).toMatch(/^@media \(max-width: 899px\)/);
    expect(css.slice(at, css.indexOf("}", at))).toMatch(/width:\s*100vw;\s*max-width:\s*100vw;\s*height:\s*100dvh;\s*max-height:\s*100dvh;\s*margin:\s*0;\s*border-radius:\s*0/);
    expect(css).toMatch(/\.p-settings \.dlg-box\s*\{\s*height:\s*100%;\s*max-height:\s*100dvh/);
    // A line under the title and one over the actions: the fields scroll between them.
    expect(css).toMatch(/\.p-settings \.dlg-head\s*\{[^}]*border-bottom:\s*1px solid var\(--border\)/);
    expect(css).toMatch(/\.p-settings \.dlg-actions\s*\{\s*border-top:\s*1px solid var\(--border\)/);
    // The title never shrinks; the version shortens, and goes under 56 px of room.
    expect(css).toMatch(/\.p-settings \.panel-title h1\s*\{\s*flex:\s*none/);
    expect(css).toMatch(/\.p-settings \.panel-sub\s*\{\s*flex:\s*1 1 0;\s*min-width:\s*0;\s*container:\s*settings-ver \/ inline-size/);
    expect(css).toMatch(/@container settings-ver \(max-width: 56px\)\s*\{\s*\.p-settings \.panel-sub \.pill\.ver\s*\{\s*display:\s*none/);
  });
  it("the CSS (§7): on a phone an effect tag wraps under its label — a field's, a legend's and a checkbox row's — whole", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const at = css.indexOf(".p-settings .field > label:not(.check) .impact");
    expect(at).toBeGreaterThan(0);
    const before = css.slice(0, at);
    expect(before.slice(before.lastIndexOf("@media"), before.lastIndexOf("@media") + 30)).toMatch(/^@media \(max-width: 899px\)/);
    expect(css.slice(at, css.indexOf("}", at))).toMatch(/\.p-settings \.field > legend \.impact\s*\{\s*display:\s*block;[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.p-settings \.check:has\(> \.impact\)\s*\{\s*flex-wrap:\s*wrap/);
    // The tag's own line, starting where the row's text does (the 16 px box and the gap).
    expect(css).toMatch(/\.p-settings \.check > \.impact\s*\{\s*flex:\s*1 0 calc\(100% - 16px - var\(--s-2\)\);\s*margin-left:\s*calc\(16px \+ var\(--s-2\)\);\s*white-space:\s*nowrap/);
    // #2512 review (Fable P3): a tag inside a note wraps whole.
    expect(css).toMatch(/\.p-settings \.note > \.impact\s*\{\s*display:\s*inline-block;\s*white-space:\s*nowrap/);
  });
});

