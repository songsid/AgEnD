/**
 * #1620 part 2: Settings → Web, as rendered (the panel in the mini DOM, a fake fetch for the server). The session
 * limits and the browser terminal are edited and staged as ONE PUT /api/settings/fleet/web with only what changed
 * (empty = the default: null, the key leaves fleet.yaml); the form refuses what the server would; the rest of the web
 * settings are listed read-only; over the temporary public link these are not edited (the server refuses Web writes). The web chat card moved here
 * from General.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const schema = buildSettingsImpactSchema();
let p: AppPage;
let fleet: any;
let sent: Array<{ method: string; path: string; body: any }> = [];
let invalidTunnelToken = false;
const realFetch = (globalThis as any).fetch;
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  if (invalidTunnelToken && method === "POST" && path === "/api/settings/public-tunnel-token/verify") {
    return { ok: false, status: 422, json: async () => ({ error_code: "invalid_tunnel_token", error: "private untrusted detail" }) };
  }
  const body = (() => {
    if (method === "POST" && path === "/api/settings/apply") return { id: "job-1", status: "done", targets: [] };
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return fleet;
    if (path === "/api/settings/classic") return { channels: {}, defaults: {} };
    if (path === "/api/settings/connections") return [];
    if (path === "/api/fleet") return { version: "2.2.0", instances: [] };
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};

beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/settings/web" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { sent = []; invalidTunnelToken = false; p.window.confirm = () => true; (globalThis as any).confirm = () => true; });
afterEach(async () => {
  await p.unmount();
  p.document.body.removeAttribute("data-public-link");
  const { resetOperation } = await import("/ui/js/settings-apply.js");
  const { resetConfirmations } = await import("/ui/js/settings-confirm.js");
  resetOperation(); resetConfirmations();
});

async function open(extra: Record<string, unknown> = {}, section = "web") {
  fleet = { defaults: { locale: "en" }, instances: {}, channels: [], ...extra };
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}` }));
  await settle(12);
  const $ = (id: string) => p.root.querySelector(`#${id}`) as any;
  const click = async (el: any) => { fire(el, "click"); await settle(); };
  const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(); };
  const type = async (el: any, value: string) => { el.value = value; fire(el, "input"); await settle(); };
  const button = (label: string, root: any = p.root) => root.querySelectorAll("button").find((b: any) => b.textContent.trim() === label);
  const review = async () => { await settle(4); };
  const apply = async () => { const region = p.root.querySelector("[role=region]"); if (region) await click(button("Save", region)); };
  const webWrites = () => sent.filter(s => s.method !== "GET" && s.path === "/api/settings/fleet/web");
  const text = () => p.root.querySelector(".s-web")?.textContent ?? "";
  return { $, check, type, review, apply, button, webWrites, text };
}

/** #2347: the Settings bar's Save (null while nothing is unsaved). */
const saveButton = () => (p.root.querySelector("[role=region]")?.querySelectorAll("button") ?? []).find((b: any) => b.textContent.trim() === "Save") ?? null;

describe("Settings → Web, as rendered", () => {
  it("#2347: its parts are where each belongs — Access & security, Chat & connections (web echo), Web dashboard; none in Agent defaults", async () => {
    const { SETTINGS_SECTIONS } = await import("/assets/app-route.js");
    expect(SETTINGS_SECTIONS).toEqual(["preferences", "look", "agents", "agent-defaults", "chat", "web-dashboard", "access", "advanced"]);
    const ids = ["webEchoToChannel", "publicWebLink", "webSessionAbsolute", "webTerminalEnabled", "webLogTab", "webUsagePublic"];
    const where: Record<string, boolean[]> = {};
    for (const section of ["access", "chat", "web-dashboard", "agent-defaults"]) { const w = await open({}, section); where[section] = ids.map((id) => !!w.$(id)); }
    expect(where).toEqual({ access: [false, true, true, true, false, false], chat: [true, false, false, false, false, false],
      "web-dashboard": [false, false, false, false, true, true], "agent-defaults": [false, false, false, false, false, false] });
    // The old address (/settings/web) is Access & security.
    expect(!!(await open({}, "web")).$("webSessionAbsolute")).toBe(true);
  });

  it("nothing set: the fields are empty with the defaults shown, the terminal on; Review writes nothing", async () => {
    const w = await open();
    expect([w.$("webSessionAbsolute").value, w.$("webSessionIdle").value, w.$("webTerminalTtl").value, w.$("webTerminalEnabled").checked]).toEqual(["", "", "", true]);
    // #2347 §10: the value in effect in plain text with a "default" mark (#1670: 48 h / 48 h; the terminal's 10 min), no grey placeholder.
    const effect = (id: string) => w.$(id).parentNode.querySelector(".s-effect")?.textContent.replace(/\s+/g, " ").trim() ?? null;
    expect([["webSessionAbsolute", "webSessionIdle", "webTerminalTtl"].map(effect), ["webSessionAbsolute", "webSessionIdle", "webTerminalTtl"].map((id) => w.$(id).getAttribute("placeholder"))])
      .toEqual([["In effect: 48 h default", "In effect: 48 h default", "In effect: 10 min default"], [null, null, null]]);
    await w.review(); await w.apply();
    expect(w.webWrites()).toEqual([]);
  });
  it("#2347 §10: a blank idle time under a shorter session says it follows it; a typed value shows no in-effect line", async () => {
    const w = await open();
    await w.type(w.$("webSessionAbsolute"), "24");
    const effect = (id: string) => w.$(id).parentNode.querySelector(".s-effect")?.textContent.replace(/\s+/g, " ").trim() ?? null;
    expect([effect("webSessionAbsolute"), effect("webSessionIdle")]).toEqual([null, "In effect: 24 h capped by the session length"]);
  });

  it("an edit is staged as one write with only what changed", async () => {
    const w = await open({ web: { echo_to_channel: true } });
    await w.type(w.$("webSessionAbsolute"), "24");
    await w.type(w.$("webSessionIdle"), "6");
    await w.check(w.$("webTerminalEnabled"), false);
    await w.type(w.$("webTerminalTtl"), "5");
    await w.review(); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ session: { local: { absolute_hours: 24, idle_hours: 6 } }, web_terminal: { enabled: false, ttl_minutes: 5 } }]);
  });

  it("#2122: Usage report over the public link — off by default; ticking it stages exactly that key; it says it applies at once", async () => {
    const w = await open({}, "web-dashboard");
    expect(w.$("webUsagePublic").checked).toBe(false);
    expect(w.text()).toContain("Fleet → Usage (up to 400 days of each agent's tokens, requests, messages and API-equivalent amounts) is offered over the temporary public link too. Off by default; guests never see it. Applies at once.");
    await w.check(w.$("webUsagePublic"), true);
    await w.review(); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ usage_report_on_public_link: true }]);
  });

  it("emptying a set value — or turning the terminal back on — puts it back to its default (null)", async () => {
    const w = await open({ web: { session: { local: { absolute_hours: 48, idle_hours: 6 } } }, web_terminal: { enabled: false, ttl_minutes: 15 } });
    expect([w.$("webSessionAbsolute").value, w.$("webSessionIdle").value, w.$("webTerminalTtl").value, w.$("webTerminalEnabled").checked]).toEqual(["48", "6", "15", false]);
    await w.type(w.$("webSessionAbsolute"), "");
    await w.check(w.$("webTerminalEnabled"), true);
    await w.review(); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ session: { local: { absolute_hours: null } }, web_terminal: { enabled: null } }]);
  });

  it("a toggle put back as it was writes nothing (unset stays unset)", async () => {
    const w = await open();
    await w.check(w.$("webTerminalEnabled"), false);
    await w.check(w.$("webTerminalEnabled"), true);
    await w.type(w.$("webSessionIdle"), "3");
    await w.type(w.$("webSessionIdle"), "");
    await w.review(); await w.apply();
    expect(w.webWrites()).toEqual([]);
  });

  it.each([
    ["webSessionAbsolute", "721", "Must be a number of hours from 1 to 720"],
    ["webSessionAbsolute", "0.5", "Must be a number of hours from 1 to 720"],
    ["webSessionIdle", "60", "Must not exceed the session length"],       // absolute left at its default, 48 (#1670)
    ["webTerminalTtl", "21", "Must be a whole number from 1 to 20"],
    ["webTerminalTtl", "2.5", "Must be a whole number from 1 to 20"],
  ])("%s = %s is refused in the form: marked, explained; unsaved, but Save waits — nothing is written (#2347)", async (id, value, message) => {
    const w = await open();
    await w.type(w.$(id), value);
    expect([w.$(id).getAttribute("class"), w.text().includes(message), saveButton()?.disabled, !!p.root.querySelector(".s-pending .s-fix")]).toEqual(["invalid", true, true, true]);
    await w.review(); await w.apply();
    expect(w.webWrites()).toEqual([]);
  });

  it("a shorter session typed with the idle time left blank is fine: the idle time follows it (#1670)", async () => {
    const w = await open();
    await w.type(w.$("webSessionAbsolute"), "24");
    expect([w.$("webSessionIdle").getAttribute("class"), saveButton()?.disabled]).toEqual(["", false]);
    await w.review(); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ session: { local: { absolute_hours: 24 } } }]);
  });

  it("idle is checked against the absolute limit being typed, not only the stored one", async () => {
    const w = await open({ web: { session: { local: { absolute_hours: 4 } } } });
    await w.type(w.$("webSessionIdle"), "6");
    expect(saveButton()?.disabled).toBe(true);
    await w.type(w.$("webSessionAbsolute"), "8");
    expect(saveButton()?.disabled).toBe(false);
  });

  it("#2347 §10 review: an upload limit that is not what applies says what does — capped by the whole message's, or out of range", async () => {
    const row = (k: string) => p.root.querySelectorAll(".s-web-ro > div").find((d: any) => d.querySelector("dt").textContent === k).querySelector("dd").textContent.replace(/\s+/g, " ").trim();
    await open({ web: { upload_max_total_mb: 10 } }, "advanced");
    const capped = [row("web.upload_max_file_mb"), row("web.upload_max_total_mb")];
    await p.unmount();
    await open({ web: { upload_max_file_mb: 60, upload_max_total_mb: 10 } }, "advanced");
    const over = row("web.upload_max_file_mb");
    await p.unmount();
    await open({ web: { upload_max_total_mb: 999 } }, "advanced");
    expect([capped, over, row("web.upload_max_total_mb")])
      .toEqual([["10 default capped by upload_max_total_mb", "10"], "60 in effect: 10", "999 in effect: 100"]);
  });
  it("lists every other web setting read-only, with its value from fleet.yaml or the one in effect, marked default (#2347 §10)", async () => {
    const w = await open({ web: { view_access: "session", allowed_hosts: ["box.lan"], preview: false }, web_terminal: { bind: "0.0.0.0" } }, "advanced");
    const rows = p.root.querySelectorAll(".s-web-ro > div").map((d: any) => [d.querySelector("dt").textContent, d.querySelector("dd").textContent,
      !!d.querySelector("dd .s-default")]);
    expect(rows).toEqual([
      ["web.allowed_hosts", "[\"box.lan\"]", false], ["web.view_access", "session", false], ["web.notify_login", "true default", true], ["web.preview", "false", false],
      ["web.preview_port", "19281 default", true], ["web.preview_origin", "none default", true], ["web.preview_on_public_link", "true default", true],
      ["web.usage_panel", "true default", true],
      ["web.search", "not set (no age limit; 300,000-row cap)", false],
      ["web.provider_secrets", "false default", true], ["web.upload_max_file_mb", "50 default", true], ["web.upload_max_total_mb", "100 default", true],
      ["web_terminal.bind", "0.0.0.0", false], ["web_terminal.tunnel", "none default", true],
    ]);
    expect(p.root.querySelectorAll(".s-web-ro input, .s-web-ro select, .s-web-ro textarea").length).toBe(0);
  });

  it("web.search read-only: unset and 0 are no age limit; a positive day count is the number (#2516)", async () => {
    const value = () => [...p.root.querySelectorAll(".s-web-ro > div")]
      .find((d: any) => d.querySelector("dt")?.textContent === "web.search")?.querySelector("dd")?.textContent;
    // #2347: the read-only list is in Advanced.
    await open({}, "advanced");
    expect(value()).toBe("not set (no age limit; 300,000-row cap)");
    await open({ web: { search: { retention_days: 0 } } }, "advanced");
    expect(value()).toBe("0 (no age limit; 300,000-row cap)");
    await open({ web: { search: { retention_days: 90 } } }, "advanced");
    expect(value()).toBe("90");
  });

  it("over the temporary public link: the web form is disabled and says why (the server refuses Web writes there); nothing can be staged", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    const w = await open();
    // The user's decision (2026-10-22): an admin may change the fleet's settings over the link — but not these, which the
    // server keeps refusing there; so no general "read-only" note either.
    expect([p.root.querySelector(".s-web-fields").hasAttribute("disabled"), !!w.$("webPublicRefused"), !!p.root.querySelector(".s-readonly")]).toEqual([true, true, false]);
    await w.type(w.$("webSessionAbsolute"), "6");
    await w.review(); await w.apply();
    expect([p.root.querySelector("[role=region]"), w.webWrites()]).toEqual([null, []]);   // #2347: no Save bar over the link
  });

  it("from the dashboard's own address the same form is enabled (control)", async () => {
    const w = await open();
    expect([p.root.querySelector(".s-web-fields").hasAttribute("disabled"), !!w.$("webPublicRefused")]).toEqual([false, false]);
  });
});


describe("#2307 fixed public link settings and write-only token", () => {
  it.each([
    ["en", "Set token", "Paste only the long string that starts with eyJ."],
    ["zh-TW", "設定 token", "請只貼上以 eyJ 開頭的長字串。"],
  ])("shows a safe localized token-format hint and permits retry (%s)", async (language, label, hint) => {
    const { setLang } = await import("/assets/app-i18n.js");
    setLang(language);
    try {
      const w = await open(); invalidTunnelToken = true;
      await w.type(w.$("publicTunnelToken"), "private wrong command");
      fire(w.button(label), "click"); await settle(12);
      expect(p.root.textContent).toContain(hint);
      expect(p.root.textContent).not.toContain("private wrong command");
      expect(p.root.textContent).not.toContain("private untrusted detail");
      expect(w.$("publicTunnelToken").value).toBe("");
      expect(sent.filter(s => s.path.endsWith("/apply") && s.path.includes("public-tunnel-token"))).toEqual([]);
      await w.type(w.$("publicTunnelToken"), "retry value");
      expect(w.button(label).disabled).toBe(false);
    } finally { setLang("en"); }
  });
  it("stages a named hostname and its fixed secret reference without token material", async () => {
    const w = await open();
    await w.type(w.$("publicWebHostname"), "agend.example.com");
    await w.review(); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ public_link: { hostname: "agend.example.com", tunnel_token_env: "AGEND_CLOUDFLARE_TUNNEL_TOKEN" } }]);
    expect(w.$("publicTunnelToken").getAttribute("type")).toBe("password");
  });
  it("sends the token only to prepare, clears its field, and applies/clears using opaque proof", async () => {
    let present = false;
    (globalThis as any).fetch = async (path: string, init: any = {}) => {
      if (!path.startsWith("/api/settings/public-tunnel-token")) return fakeFetch(path, init);
      const body = init.body ? JSON.parse(init.body) : undefined;
      sent.push({ method: init.method || "GET", path, body });
      if (path.endsWith("/verify")) return { ok: true, status: 200, json: async () => ({ verification_id: body.clear ? "clear-proof" : "set-proof" }) };
      if (path.endsWith("/apply")) { present = body.verification_id === "set-proof"; return { ok: true, status: 200, json: async () => ({ result: "reloaded" }) }; }
      return { ok: true, status: 200, json: async () => [{ token_present: present }] };
    };
    try {
      const w = await open(); const token = "eyJWriteOnlyConnectorTokenUI2307";
      await w.type(w.$("publicTunnelToken"), token);
      fire(w.button("Set token"), "click"); await settle(12);
      expect(w.$("publicTunnelToken").value).toBe("");
      expect(p.root.textContent).not.toContain(token);
      const prepared = sent.filter(s => s.path.endsWith("/verify"));
      expect(prepared[0].body).toEqual({ secret: token });
      expect(sent.find(s => s.path.endsWith("/apply"))?.body.verification_id).toBe("set-proof");
      expect(sent.filter(s => s.path.endsWith("/apply")).every(s => !JSON.stringify(s.body).includes(token))).toBe(true);
      fire(w.button("Clear token"), "click"); await settle(12);
      expect(sent.filter(s => s.path.endsWith("/verify"))[1].body).toEqual({ clear: true });
      expect(sent.filter(s => s.path.endsWith("/apply"))[1].body.verification_id).toBe("clear-proof");
    } finally { (globalThis as any).fetch = fakeFetch; }
  });
  it("does not expose connector inputs or token endpoints through a public-link settings page", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    const w = await open();
    expect(w.$("publicTunnelToken")).toBeNull();
    expect(sent.filter(s => s.path.startsWith("/api/settings/public-tunnel-token"))).toHaveLength(0);
  });
});


describe("#2344 Web edits join the existing Apply draft automatically", () => {
  const pending = () => p.root.querySelector("[role=region]");
  it("mounting an existing named tunnel makes no draft; a valid edit shows Apply immediately without HTTP writes", async () => {
    const w = await open({ web: { public_link: { hostname: "chat.example.com", tunnel_token_env: "MY_CUSTOM_CONNECTOR" } } });
    expect(pending()).toBeNull(); expect(w.webWrites()).toEqual([]);
    await w.type(w.$("publicWebTtl"), "90");
    expect(pending()?.textContent).toContain("Save"); expect(w.webWrites()).toEqual([]);
    await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ public_link: { ttl_minutes: 90 } }]);
  });
  it("each valid keystroke replaces the same draft with the latest values; Apply alone sends it", async () => {
    const w = await open();
    await w.type(w.$("publicWebHostname"), "chat.example.com");
    await w.type(w.$("publicWebTtl"), "9"); await w.type(w.$("publicWebTtl"), "90");
    expect(pending()?.textContent).toContain("Save"); expect(w.webWrites()).toEqual([]);
    await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ public_link: { hostname: "chat.example.com", tunnel_token_env: "AGEND_CLOUDFLARE_TUNNEL_TOKEN", ttl_minutes: 90 } }]);
  });
  it("putting every edited value back removes the draft and Apply bar", async () => {
    const w = await open({}, "web-dashboard"); await w.check(w.$("webLogTab"), true);
    expect(pending()?.textContent).toContain("Save");
    await w.check(w.$("webLogTab"), false); expect(pending()).toBeNull();
    await w.apply(); expect(w.webWrites()).toEqual([]);
  });
  it("an invalid edit replaces the older valid draft: unsaved, Save waits (#2347), remains inline, and recovers when corrected", async () => {
    const w = await open(); await w.type(w.$("publicWebTtl"), "90"); expect(pending()).not.toBeNull();
    await w.type(w.$("publicWebTtl"), "999"); expect(w.$("publicWebTtl").getAttribute("class")).toBe("invalid");
    expect([!!pending()?.querySelector(".s-fix"), saveButton()?.disabled]).toEqual([true, true]); await w.apply(); expect(w.webWrites()).toEqual([]);
    await w.type(w.$("publicWebTtl"), "60"); expect(pending()?.textContent).toContain("Save"); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ public_link: { ttl_minutes: 60 } }]);
  });
  it("returning from another Settings section shows the pending hostname and later edits preserve it", async () => {
    const w = await open(); await w.type(w.$("publicWebHostname"), "chat.example.com"); expect(pending()).not.toBeNull();
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "general" }, navKey: "settings:general" })); await settle();
    expect(pending()).not.toBeNull();
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "web" }, navKey: "settings:web" })); await settle();
    expect(pending()?.textContent).toContain("Save"); expect(w.$("publicWebHostname").value).toBe("chat.example.com"); expect(w.webWrites()).toEqual([]);
    await w.type(w.$("publicWebOriginPort"), "19300"); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ public_link: { hostname: "chat.example.com", tunnel_token_env: "AGEND_CLOUDFLARE_TUNNEL_TOKEN", origin_port: 19300 } }]);
  });
  it("remounted Web fields retain false values and null session/terminal resets before another edit", async () => {
    const w = await open({ web: { session: { local: { absolute_hours: 48, idle_hours: 6 } } }, web_terminal: { enabled: false, ttl_minutes: 15 } });
    await w.type(w.$("webSessionAbsolute"), ""); await w.type(w.$("webSessionIdle"), "");
    await w.check(w.$("webTerminalEnabled"), true); await w.type(w.$("webTerminalTtl"), "");
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    const go = async (section: string) => { await p.mount(h(SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}` })); await settle(); };
    // #2347: web echo is in Chat & connections — the same form, the same draft.
    await go("chat"); await w.check(w.$("webEchoToChannel"), false);
    await go("agent-defaults"); await go("access");
    const access = [w.$("webSessionAbsolute").value, w.$("webSessionIdle").value, w.$("webTerminalTtl").value, w.$("webTerminalEnabled").checked];
    await go("chat"); const echo = w.$("webEchoToChannel").checked;
    await go("access");
    expect([...access, echo]).toEqual(["", "", "", true, false]);
    await w.type(w.$("publicWebOriginPort"), "19300"); expect(w.webWrites()).toEqual([]); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ echo_to_channel: false, session: { local: { absolute_hours: null, idle_hours: null } }, web_terminal: { enabled: null, ttl_minutes: null }, public_link: { origin_port: 19300 } }]);
  });
  it("public-link fields cannot auto-stage even if an input event is forged", async () => {
    p.document.body.setAttribute("data-public-link", "1"); const w = await open();
    await w.type(w.$("publicWebHostname"), "chat.example.com");
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "web-dashboard" }, navKey: "settings:web-dashboard" })); await settle();
    await w.check(w.$("webLogTab"), true);
    expect(pending()).toBeNull(); await w.apply(); expect(w.webWrites()).toEqual([]);
  });
  it("typing a secret never joins the Web draft or sends token material before Set token", async () => {
    const w = await open({ web: { public_link: { hostname: "chat.example.com", tunnel_token_env: "MY_CUSTOM_CONNECTOR" } } });
    const token = "private-test-connector-2344"; await w.type(w.$("publicTunnelToken"), token);
    expect(pending()).toBeNull(); expect(sent.filter(s => s.method !== "GET")).toEqual([]);
    await w.type(w.$("publicWebTtl"), "90"); expect(pending()?.textContent).toContain("Save"); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ public_link: { ttl_minutes: 90 } }]);
    expect(JSON.stringify(w.webWrites())).not.toContain(token); expect(sent.filter(s => s.method !== "GET" && s.path.includes("public-tunnel-token"))).toEqual([]);
  });
  it("a custom connector reference survives hostname edits; a blank unchanged hostname does not create a mount draft", async () => {
    let w = await open({ web: { public_link: { hostname: "chat.example.com", tunnel_token_env: "MY_CUSTOM_CONNECTOR" } } });
    await w.type(w.$("publicWebHostname"), "other.example.com"); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ public_link: { hostname: "other.example.com" } }]);
    w = await open({ web: { public_link: { tunnel_token_env: "MY_CUSTOM_CONNECTOR" } } });
    expect(pending()).toBeNull(); await w.type(w.$("publicWebTtl"), "90"); await w.apply();
    expect(w.webWrites().at(-1)?.body).toEqual({ public_link: { ttl_minutes: 90 } });
  });
});

describe("#named-link-ttl: the public link's minutes and auto_open follow the mode", () => {
  const pending = () => p.root.querySelector("[role=region]");
  const NAMED = { web: { public_link: { hostname: "chat.example.com", tunnel_token_env: "AGEND_CLOUDFLARE_TUNNEL_TOKEN" } } };
  it("quick tunnel: 1–480, no 'no expiry' hint and no auto-open box; 600 stays inline-invalid with the quick range", async () => {
    const w = await open();
    expect([w.$("publicWebTtl").getAttribute("min"), w.$("publicWebTtl").getAttribute("max")]).toEqual(["1", "480"]);
    expect(w.$("publicTtlNamedHint")).toBeNull(); expect(w.$("publicAutoOpen")).toBeNull();
    expect(w.text()).toContain("Public link minutes (1–480)");
    await w.type(w.$("publicWebTtl"), "600");
    expect(w.$("publicWebTtl").getAttribute("class")).toBe("invalid");
    expect(w.text()).toContain("A quick tunnel allows 1–480 minutes");
    await w.type(w.$("publicWebTtl"), "0"); expect(w.$("publicWebTtl").getAttribute("class")).toBe("invalid");
    // #2347's save model: an invalid edit is unsaved and Save waits ("Fix 1 field"); nothing is written.
    expect([!!pending()?.querySelector(".s-fix"), saveButton()?.disabled]).toEqual([true, true]); await w.apply(); expect(w.webWrites()).toEqual([]);
  });
  it("fixed hostname: 0–10080 with the 'no expiry' hint; 0 and auto_open stage as one write", async () => {
    const w = await open(NAMED);
    expect([w.$("publicWebTtl").getAttribute("min"), w.$("publicWebTtl").getAttribute("max")]).toEqual(["0", "10080"]);
    expect(w.$("publicTtlNamedHint").textContent).toContain("0 = no expiry");
    // Carry of #2450 (the maintainers' condition on Fable's P2-4): the hint says when a changed lifetime applies.
    expect(w.$("publicTtlNamedHint").textContent).toContain("A changed lifetime applies at the next opening; Close the link to end the current one.");
    expect(w.$("publicAutoOpen").checked).toBe(false);
    await w.type(w.$("publicWebTtl"), "10081"); expect(w.$("publicWebTtl").getAttribute("class")).toBe("invalid");
    await w.type(w.$("publicWebTtl"), ""); expect(w.$("publicWebTtl").getAttribute("class")).toBe("invalid");
    await w.type(w.$("publicWebTtl"), "0"); await w.check(w.$("publicAutoOpen"), true);
    expect(pending()?.textContent).toContain("Save"); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ public_link: { ttl_minutes: 0, auto_open: true } }]);
  });
  it("blanking the hostname with 600 minutes and auto_open set: both flagged, nothing staged until they fit a quick tunnel", async () => {
    const w = await open({ web: { public_link: { ...NAMED.web.public_link, ttl_minutes: 600, auto_open: true } } });
    await w.type(w.$("publicWebHostname"), "");
    expect(w.$("publicWebTtl").getAttribute("class")).toBe("invalid");
    expect(w.$("publicAutoOpen").checked).toBe(true);                       // still shown, so it can be unticked
    expect(w.text()).toContain("Needs a fixed hostname");
    expect([!!pending()?.querySelector(".s-fix"), saveButton()?.disabled]).toEqual([true, true]);   // #2347: Save waits
    await w.type(w.$("publicWebTtl"), "480"); await w.check(w.$("publicAutoOpen"), false);
    expect(w.$("publicAutoOpen")).toBeNull();
    await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ public_link: { ttl_minutes: 480, hostname: "", tunnel_token_env: "", auto_open: false } }]);
  });
  it("#2495 review: an untouched Reopen box is not an edit — a minutes-only Save never sends auto_open", async () => {
    const w = await open(NAMED);
    expect([w.$("publicAutoOpen").checked, w.$("publicAutoOpen").closest("label").getAttribute("class"), pending()]).toEqual([false, "check", null]);
    await w.type(w.$("publicWebTtl"), "600");
    expect(pending()?.textContent).toContain("Save"); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ public_link: { ttl_minutes: 600 } }]);
  });
});
