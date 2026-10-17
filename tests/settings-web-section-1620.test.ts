/**
 * #1620 part 2: Settings → Web, as rendered (the panel in the mini DOM, a fake fetch for the server). The session
 * limits and the browser terminal are edited and staged as ONE PUT /api/settings/fleet/web with only what changed
 * (empty = the default: null, the key leaves fleet.yaml); the form refuses what the server would; the rest of the web
 * settings are listed read-only; over the temporary public link nothing can be edited. The web chat card moved here
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
const realFetch = (globalThis as any).fetch;
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
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
beforeEach(() => { sent = []; p.window.confirm = () => true; (globalThis as any).confirm = () => true; });
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
  const review = async () => { await click(button("Review changes")); };
  const apply = async () => { const region = p.root.querySelector("[role=region]"); if (region) await click(button("Apply changes", region)); };
  const webWrites = () => sent.filter(s => s.method !== "GET" && s.path === "/api/settings/fleet/web");
  const text = () => p.root.querySelector(".s-web")?.textContent ?? "";
  return { $, check, type, review, apply, button, webWrites, text };
}

describe("Settings → Web, as rendered", () => {
  it("is a section of its own; the web chat card moved here from General", async () => {
    const { SETTINGS_SECTIONS } = await import("/assets/app-route.js");
    expect(SETTINGS_SECTIONS).toEqual(["device", "appearance", "agents", "bots", "classic", "general", "web", "advanced"]);   // #1629: Appearance
    const w = await open();
    expect([!!w.$("webEchoToChannel"), !!w.$("publicWebLink"), !!w.$("webSessionAbsolute"), !!w.$("webTerminalEnabled")]).toEqual([true, true, true, true]);
    const g = await open({}, "general");
    expect([!!g.$("webEchoToChannel"), !!g.$("publicWebLink"), !!g.$("webSessionAbsolute")]).toEqual([false, false, false]);
  });

  it("nothing set: the fields are empty with the defaults shown, the terminal on; Review writes nothing", async () => {
    const w = await open();
    expect([w.$("webSessionAbsolute").value, w.$("webSessionIdle").value, w.$("webTerminalTtl").value, w.$("webTerminalEnabled").checked]).toEqual(["", "", "", true]);
    expect([w.$("webSessionAbsolute").getAttribute("placeholder"), w.$("webSessionIdle").getAttribute("placeholder"), w.$("webTerminalTtl").getAttribute("placeholder")])
      .toEqual(["48 (default)", "48 (default)", "10 (default)"]);   // #1670: 48 h / 48 h
    await w.review(); await w.apply();
    expect(w.webWrites()).toEqual([]);
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
  ])("%s = %s is refused in the form: marked, explained, nothing staged", async (id, value, message) => {
    const w = await open();
    await w.type(w.$(id), value);
    expect([w.$(id).getAttribute("class"), w.text().includes(message), w.button("Review changes").disabled]).toEqual(["invalid", true, true]);
    await w.review(); await w.apply();
    expect([p.root.querySelector("[role=region]"), w.webWrites()]).toEqual([null, []]);
  });

  it("a shorter session typed with the idle time left blank is fine: the idle time follows it (#1670)", async () => {
    const w = await open();
    await w.type(w.$("webSessionAbsolute"), "24");
    expect([w.$("webSessionIdle").getAttribute("class"), w.button("Review changes").disabled]).toEqual(["", false]);
    await w.review(); await w.apply();
    expect(w.webWrites().map(s => s.body)).toEqual([{ session: { local: { absolute_hours: 24 } } }]);
  });

  it("idle is checked against the absolute limit being typed, not only the stored one", async () => {
    const w = await open({ web: { session: { local: { absolute_hours: 4 } } } });
    await w.type(w.$("webSessionIdle"), "6");
    expect(w.button("Review changes").disabled).toBe(true);
    await w.type(w.$("webSessionAbsolute"), "8");
    expect(w.button("Review changes").disabled).toBe(false);
  });

  it("lists every other web setting read-only, with its value from fleet.yaml or 'not set (default)'", async () => {
    const w = await open({ web: { view_access: "session", allowed_hosts: ["box.lan"], preview: false }, web_terminal: { bind: "0.0.0.0" } });
    const rows = p.root.querySelectorAll(".s-web-ro > div").map((d: any) => [d.querySelector("dt").textContent, d.querySelector("dd").textContent]);
    expect(rows).toEqual([
      ["web.allowed_hosts", "[\"box.lan\"]"], ["web.view_access", "session"], ["web.notify_login", "not set (default)"], ["web.preview", "false"],
      ["web.preview_port", "not set (default)"], ["web.preview_origin", "not set (default)"], ["web.preview_on_public_link", "not set (default)"],
      ["web.usage_panel", "not set (default)"],
      ["web.provider_secrets", "not set (default)"], ["web.upload_max_file_mb", "not set (default)"], ["web.upload_max_total_mb", "not set (default)"], ["web_terminal.bind", "0.0.0.0"], ["web_terminal.tunnel", "not set (default)"],
    ]);
    expect(p.root.querySelectorAll(".s-web-ro input, .s-web-ro select, .s-web-ro textarea").length).toBe(0);
  });

  it("over the temporary public link: the form is disabled and says why; nothing can be staged", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    const w = await open();
    expect([p.root.querySelector(".s-web-fields").hasAttribute("disabled"), !!w.$("webPublicRefused"), w.button("Review changes").disabled]).toEqual([true, true, true]);
    await w.type(w.$("webSessionAbsolute"), "6");
    await w.review(); await w.apply();
    expect(w.webWrites()).toEqual([]);
  });

  it("from the dashboard's own address the same form is enabled (control)", async () => {
    const w = await open();
    expect([p.root.querySelector(".s-web-fields").hasAttribute("disabled"), !!w.$("webPublicRefused")]).toEqual([false, false]);
  });
});
