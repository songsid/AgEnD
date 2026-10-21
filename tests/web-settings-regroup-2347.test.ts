/**
 * #2347 regrouping: the Settings sections in two groups — You (Preferences, Look) and Fleet (Agents, Agent defaults,
 * Chat & connections, Web dashboard, Access & security, Advanced) — each card where the person looks for it (#2347 §3),
 * the old addresses leading to the new sections (ClassicBot's to its place: /settings/chat#classicbot), and a split
 * form (the defaults, Web) still one form with one draft.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { shellRoute } from "../src/web-shell-routes.js";

const schema = buildSettingsImpactSchema();
let p: AppPage;
const realFetch = (globalThis as any).fetch;
const fakeFetch = async (path: string, init: { method?: string } = {}) => {
  const method = init.method ?? "GET";
  const body = (() => {
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/schema") return { ...schema, provider_secrets: true };
    if (path === "/api/settings/fleet/raw") return { defaults: { locale: "en" }, instances: {}, channels: [{ id: "main", type: "discord", bot_token_env: "T", group_id: "1" }], web: {} };
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
