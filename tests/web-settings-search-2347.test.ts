/**
 * #2347 §6: settings search. The registry (settings-registry.js) against what each section really draws: every field
 * with an id drawn there has an entry, and every entry's element is drawn in its section. Matching by name, config key
 * and words in both languages ("token", "語言", "port", "固定網址"). The search box: results grouped by section with
 * where they are, ↑↓ Enter Esc, "/" focuses it; a result goes to its section, focuses the field and flashes it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniEvent } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const schema = buildSettingsImpactSchema();
let p: AppPage;
const realFetch = (globalThis as any).fetch;
/** #2383 review: the message search's answer (null: an empty one), and a configuration read held until it opens. */
let searchAnswer: "404" | "throw" | null = null;
let rawHold: Promise<void> | null = null;
/** The fleet's `web` as read, and the authority overview's named hostname — a named tunnel draws more fields. */
let rawWeb: Record<string, unknown> = {}, namedHost: string | null = null;
const fakeFetch = async (path: string, init: { method?: string } = {}) => {
  const method = init.method ?? "GET";
  if (path.startsWith("/ui/search")) {
    if (searchAnswer === "throw") throw new TypeError("network");
    if (searchAnswer === "404") return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  }
  if (path === "/api/settings/fleet/raw" && rawHold) { const held = rawHold; rawHold = null; await held; }
  const body = (() => {
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/schema") return { ...schema, provider_secrets: true };
    if (path === "/api/settings/fleet/raw") return { defaults: { locale: "en" }, instances: {}, channels: [{ id: "main", type: "discord", bot_token_env: "T", group_id: "1" }], web: rawWeb };
    if (path === "/api/settings/classic") return { defaults: {}, channels: { "c1": { name: "ops", instanceName: "ops-t1", channelId: "1" } } };
    if (path === "/api/settings/provider-secrets") return [{ id: "openai", display_name: "OpenAI", verifier: "available", token_present: false }];
    if (path === "/api/settings/connections") return [{ id: "main", token_present: true }];
    if (path === "/api/settings/web-authority") return { state: { enabled: true, loopbackOnly: false, epoch: 1 }, configured: {}, hours: { min: 1, max: 48, default: 48 }, lanHosts: [], authorized: [], ...(namedHost ? { namedHost } : {}) };
    if (path === "/api/settings/guests") return { enabled: false, chat: true, explicit: true, instances: [], connections: [], guests: [] };
    if (path === "/api/fleet") return { version: "2.4.0", instances: [] };
    if (path === "/ui/owner-css/state") return { active: null, pending: null, text: "", versions: [], assets: [], limits: { maxAssets: 16 } };
    if (path.startsWith("/ui/")) return {};
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
let nav: any, reg: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19285/settings", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  (globalThis as any).AgendPreview = { optedIn: () => false, onChange: () => () => {}, setOptIn: () => {} };
  (globalThis as any).AgendAuth = { trialSession: async () => ({ localAdmin: true }) };
  p.document.body.dataset.mode = "full";
  nav = await import("/assets/app-nav.js");
  reg = await import("/ui/js/settings-registry.js");
  // Effects (Look) are drawn with Canvas Worker effects on: every card is there to check against the registry.
  (await import("/assets/app-store.js")).appStore.set({ canvasWorker: true });
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; delete (globalThis as any).AgendPreview; delete (globalThis as any).AgendAuth; });
beforeEach(() => { (globalThis as any).confirm = () => true; });
afterEach(async () => { await p.unmount(); });

const open = async (section: string) => {
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}|${Math.random()}` }));
  await settle(20);
  if (section === "look") for (let i = 0; i < 40 && !p.root.querySelector(".s-effects"); i++) await new Promise((r) => setTimeout(r, 25));
};
const SECTIONS = ["preferences", "look", "agents", "agent-defaults", "chat", "web-dashboard", "access", "advanced"];

/** What a section draws that no entry covers, and the entries whose element it does not draw. */
async function coverage(sections: string[], skipAbsent: (e: any) => boolean = () => false) {
  const missing: string[] = [], absent: string[] = [];
  for (const section of sections) {
    await open(section);
    const body = p.root.querySelector(".p-settings .panel-body");
    const mine = reg.SETTINGS_REGISTRY.filter((e: any) => e.section === section);
    const covered = (el: any) => mine.some((e: any) => {
      const target = body.querySelector(e.target);
      if (!target) return false;
      for (let n = el; n; n = n.parentElement) if (n === target) return true;
      return false;
    });
    for (const el of body.querySelectorAll("input[id], select[id], textarea[id], fieldset[id]")) if (!covered(el)) missing.push(`${section}: #${el.id}`);
    for (const e of mine) if (!skipAbsent(e) && !body.querySelector(e.target)) absent.push(`${section}: ${e.id} (${e.target})`);
  }
  return [missing, absent];
}
/** Drawn only with a fixed hostname (a named tunnel): checked by the named-tunnel case below. */
const NAMED_ONLY = new Set(["access.public-auto-open", "access.authority-named-link"]);

describe("#2347 §6: the registry is what Settings draws", () => {
  it("every field with an id in a section has an entry, and every entry's element is drawn in its section", async () => {
    expect(await coverage(SECTIONS, (e) => NAMED_ONLY.has(e.id))).toEqual([[], []]);
  }, 30_000);
  it("with a fixed hostname (a named tunnel): its own fields too — Reopen after start, Also over my named link", async () => {
    rawWeb = { public_link: { hostname: "chat.example.com", tunnel_token_env: "AGEND_CLOUDFLARE_TUNNEL_TOKEN" } }; namedHost = "chat.example.com";
    try {
      expect(await coverage(["access"])).toEqual([[], []]);
      for (const id of NAMED_ONLY) expect(p.root.querySelector(reg.SETTINGS_REGISTRY.find((e: any) => e.id === id).target), id).not.toBeNull();
    } finally { rawWeb = {}; namedHost = null; }
  }, 30_000);
  it("every entry has a name in both languages, a known section, and a unique id", async () => {
    const { SETTINGS_SECTIONS } = await import("/assets/app-route.js");
    const ids = reg.SETTINGS_REGISTRY.map((e: any) => e.id);
    const bad = reg.SETTINGS_REGISTRY.filter((e: any) => !SETTINGS_SECTIONS.includes(e.section)
      || [reg.settingLabel(e, "en"), reg.settingLabel(e, "zh-TW")].some((l: string) => !l || l.startsWith("settings.") || l.startsWith("app.") || l.startsWith("chat.")));
    expect([bad.map((e: any) => e.id), ids.length === new Set(ids).size]).toEqual([[], true]);
  });
});

describe("#2347 §6: what a search finds", () => {
  const ids = (q: string) => reg.searchSettings(q).map((e: any) => e.id);
  it("\"token\": the Cloudflare token, a connection's bot token and the provider API keys", () => {
    expect(ids("token")).toEqual(expect.arrayContaining(["access.cloudflare-token", "chat.new-connection", "agents.provider-keys"]));
  });
  it("\"語言\": the dashboard's language and the bots' reply language", () => {
    expect(ids("語言")).toEqual(expect.arrayContaining(["prefs.lang", "defaults.locale"]));
  });
  it("\"port\", \"https\", \"domain\" and \"固定網址\" find the fixed address", () => {
    const want: Record<string, string[]> = { port: ["access.origin-port"], https: ["access.hostname"], domain: ["access.hostname"],
      固定網址: ["access.hostname", "access.origin-port", "access.cloudflare-token"] };
    for (const [q, found] of Object.entries(want)) expect(ids(q), q).toEqual(expect.arrayContaining(found));
  });
  it("main's newer settings are found too (the sync after #2391, #2450, #2453): by name, key and words, both languages", () => {
    const ids = (q: string) => reg.searchSettings(q).map((e: any) => e.id);
    expect(ids("dashboard access")).toContain("defaults.dashboard");
    expect(ids("defaults.dashboard")).toContain("defaults.dashboard");
    expect(ids("權限")).toContain("defaults.dashboard");
    expect(ids("reopen after restart")).toContain("access.public-auto-open");
    expect(ids("web.public_link.auto_open")).toContain("access.public-auto-open");
    expect(ids("自動開啟")).toContain("access.public-auto-open");
    expect(ids("my named link")).toContain("access.authority-named-link");
    expect(ids("固定網域")).toContain("access.authority-named-link");
    expect(ids("no expiry")).toContain("access.public-ttl");
  });
  it("by config key, by its name in the other language, every word of several; nothing for nonsense", () => {
    expect([ids("web.log_tab")[0], ids("自動暫停")[0], ids("public link minutes")[0], ids("zzqx")]).toEqual(["dash.log-tab", "defaults.auto-pause", "access.public-ttl", []]);
  });
  it("a name that starts with the query comes first; a name before a synonym (\"token\": the setting called a token)", () => {
    expect([ids("theme")[0], ids("token")[0]]).toEqual(["prefs.theme", "access.cloudflare-token"]);
  });
  it("by its name in Chinese alone (no synonym says it): \"併發\" is the startup concurrency", () => {
    expect(ids("併發")).toEqual(["defaults.concurrency"]);
  });
});

describe("#2347 §6: the search box", () => {
  const box = () => p.root.querySelector("#settingsSearch") as any;
  const key = (el: any, k: string) => { const e = new MiniEvent("keydown", { bubbles: true, cancelable: true }); (e as any).key = k; el.dispatchEvent(e); };
  it("results grouped by section with where they are and the config key; ↑↓ moves; Enter goes there — the field focused and flashed", async () => {
    await open("agents");
    box().value = "unused hours"; fire(box(), "input"); await settle(4);
    const heads = p.root.querySelectorAll(".s-find-head").map((x: any) => x.textContent);
    const first = p.root.querySelector(".s-find-item.on");
    expect([heads, first.querySelector(".s-find-label").textContent, first.querySelector(".s-find-key").textContent, !!first.querySelector("mark")])
      .toEqual([["Fleet › Access & security"], "Sign out after unused for, hours (1–720)", "web.session.local.idle_hours", true]);
    key(box(), "Enter"); await settle(4);
    await open("access");
    const field = p.root.querySelector("#webSessionIdle");
    let row = field; while (row && !/\bfield\b/.test(row.getAttribute?.("class") || "")) row = row.parentElement;
    expect([nav.navStore.get().route, p.document.activeElement === field, /s-flash/.test(row.getAttribute("class"))])
      .toEqual([{ panel: "settings", section: "access" }, true, true]);
  });
  it("nothing found says so; Esc clears; \"/\" anywhere in Settings focuses the box", async () => {
    await open("look");
    box().value = "zzqx"; fire(box(), "input"); await settle(4);
    const none = p.root.querySelector(".s-find-none")?.textContent;
    key(box(), "Escape"); await settle(4);
    const cleared = [box().value, !!p.root.querySelector(".s-find-results")];
    box().blur?.();
    key(p.document.body, "/"); await settle(2);
    expect([none, cleared, p.document.activeElement === box()]).toEqual(["No setting matches.", ["", false], true]);
  });
});

describe("#2347 §6: the best match first", () => {
  it("\"token\": the group of the best match (Access & security: the Cloudflare token) comes first, and Enter goes there", async () => {
    await open("agents");
    const box: any = p.root.querySelector("#settingsSearch");
    box.value = "token"; fire(box, "input"); await settle(4);
    const heads = p.root.querySelectorAll(".s-find-head").map((x: any) => x.textContent);
    const e = new MiniEvent("keydown", { bubbles: true, cancelable: true }); (e as any).key = "Enter"; box.dispatchEvent(e); await settle(4);
    expect([heads[0], nav.navStore.get().route.section]).toEqual(["Fleet › Access & security", "access"]);
  });
});

describe("#2382 review: a field to fix elsewhere is named and reached from the bar", () => {
  it("an invalid public-link minutes in Access & security: in Agent defaults the bar says where, and goes there (the field focused)", async () => {
    await open("access");
    const ttl: any = p.root.querySelector("#publicWebTtl");
    ttl.value = "999"; fire(ttl, "input"); await settle(6);
    const here = p.root.querySelector(".s-pending .s-fix")?.textContent;
    await open("agent-defaults");
    const fix: any = p.root.querySelector(".s-pending button.s-fix");
    const there = fix?.textContent;
    fix.click(); await settle(4);
    await open("access");
    expect([here, there, nav.navStore.get().route.section, p.document.activeElement === p.root.querySelector("#publicWebTtl")])
      .toEqual(["Fix 1 field(s) to save", "Fix 1 field(s) in Access & security to save", "access", true]);
    p.root.querySelectorAll(".s-pending button").find((b: any) => b.textContent === "Discard").click(); await settle(6);
  });
});

describe("#2383 review: a setting asked for is reached however long the configuration takes", () => {
  for (const ms of [2400, 50]) {
    it(`the configuration read answers after ${ms} ms: the field is still focused and flashed`, async () => {
      await p.unmount();
      let release!: () => void;
      rawHold = new Promise<void>((r) => { release = r; });
      reg.goToSetting(reg.SETTINGS_REGISTRY.find((e: any) => e.id === "access.hostname"));
      const { SettingsPanel } = await import("/ui/js/panel-settings.js");
      await p.mount(h(SettingsPanel, { route: nav.navStore.get().route, navKey: `settings:access|held${ms}` }));
      await new Promise((r) => setTimeout(r, ms)); release(); await settle(20);
      const field = p.root.querySelector("#publicWebHostname");
      expect([!!field, p.document.activeElement === field]).toEqual([true, true]);
    });
  }
  it("a navigation made since, with no setting to find, cancels the one asked for", async () => {
    await p.unmount();
    let release!: () => void;
    rawHold = new Promise<void>((r) => { release = r; });
    reg.goToSetting(reg.SETTINGS_REGISTRY.find((e: any) => e.id === "access.hostname"));
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "access" }, navKey: "settings:access|first" }));
    nav.navigate("/settings/access");                                  // the person went on (no search result)
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "access" }, navKey: "settings:access|second" }));
    release(); await settle(20);
    expect(p.document.activeElement === p.root.querySelector("#publicWebHostname")).toBe(false);
  });
});

describe("#2347 §6: Ctrl K has a Settings group", () => {
  for (const answer of ["404", "throw"] as const) {
    it(`#2383 review: the message search failing (${answer === "404" ? "search off: 404" : "a dropped connection"}) leaves the settings shown, and Enter opens one`, async () => {
      searchAnswer = answer;
      try {
        const m = await import("/ui/js/search-dialog.js");
        await p.mount(h(m.SearchDialog, { preset: {}, onClose: () => {} }));
        const input: any = p.root.querySelector(".search-input");
        input.value = "cloudflare"; fire(input, "input");
        await new Promise((r) => setTimeout(r, 400)); await settle(6);
        const shown = [!!p.root.querySelector(".search-settings .search-row"), !!p.root.querySelector(".search-status.bad")];
        const e = new MiniEvent("keydown", { bubbles: true, cancelable: true }); (e as any).key = "Enter"; input.dispatchEvent(e); await settle(4);
        expect([shown, nav.navStore.get().route]).toEqual([[true, true], { panel: "settings", section: "access" }]);
      } finally { searchAnswer = null; }
    });
  }
  it("the settings come first, from the registry (no request); opening one goes to it", async () => {
    const m = await import("/ui/js/search-dialog.js");
    let closed = 0;
    await p.mount(h(m.SearchDialog, { preset: {}, onClose: () => { closed++; } }));
    const input: any = p.root.querySelector(".search-input");
    input.value = "cloudflare"; fire(input, "input"); await settle(4);
    const group = p.root.querySelector(".search-settings");
    expect([group?.querySelector(".search-group-head span").textContent, group?.querySelectorAll(".search-row").length > 0,
      group?.querySelector(".search-who").textContent]).toEqual(["Settings", true, "Settings › Access & security"]);
    group.querySelector(".search-row").click(); await settle(4);
    expect([closed, nav.navStore.get().route]).toEqual([1, { panel: "settings", section: "access" }]);
  });
});
