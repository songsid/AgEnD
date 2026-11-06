import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

let p: AppPage, SettingsPanel: any, nav: any, registry: any;
const originalFetch = globalThis.fetch;
const writes: string[] = [];
let webOnly = false;
const fakeFetch = async (path: string, init: { method?: string } = {}) => {
  if ((init.method || "GET") !== "GET") writes.push(path);
  const body = (() => {
    if (path === "/api/settings/schema") return buildSettingsImpactSchema();
    if (path === "/api/settings/fleet/raw") return { defaults: {}, instances: {}, channels: [], web: {} };
    if (path === "/api/settings/classic") return { defaults: {}, channels: {} };
    if (path === "/api/fleet") return { version: "2.3.5-alpha", instances: [] };
    if (path === "/api/settings/web-authority") return { state: { enabled: true }, configured: {}, hours: { min: 1, max: 48, default: 8 }, lanHosts: [], authorized: [] };
    if (path === "/ui/outside") return webOnly ? { webOnly: true, here: true, enrolled: false, outside: false, pausedForMs: 0 } : {};
    if (path === "/api/settings/guests") return { enabled: false, chat: true, explicit: true, instances: [], connections: [], guests: [] };
    if (path === "/api/settings/public-tunnel-token") return [{ token_present: false }];
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings/access", storage: { agend_lang: "en" } });
  (globalThis as any).fetch = fakeFetch;
  (await import("/assets/app-i18n.js")).setLang("en");
  ({ SettingsPanel } = await import("/ui/js/panel-settings.js"));
  nav = await import("/assets/app-nav.js");
  registry = await import("/ui/js/settings-registry.js");
  nav.startRouter(p.window);
});
afterEach(async () => {
  await p.unmount();
  p.document.body.removeAttribute("data-public-link");
  (await import("/ui/js/settings-apply.js")).resetOperation();
  (await import("/ui/js/settings-confirm.js")).resetConfirmations();
  writes.length = 0;
  webOnly = false;
});
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });

const byId = (id: string) => p.root.querySelector(`#${id}`) as any;
const click = async (id: string) => { byId(id).click(); await settle(6); };
const type = async (id: string, value: string) => { const field = byId(id); field.value = value; fire(field, "input"); await settle(6); };
async function open(section: string, hash = "") {
  nav.navigate(`/settings/${section}${hash}`, { force: true });
  await p.mount(h(SettingsPanel, { route: nav.navStore.get().route, navKey: `tabs:${nav.navStore.get().seq}` }));
  await settle(22);
}

describe("the real Settings forms across page tabs", () => {
  it("keeps Access edits and the same fields while viewing other groups, without writing", async () => {
    await open("access");
    const session = byId("webSessionAbsolute"), hostname = byId("publicWebHostname");
    await type("webSessionAbsolute", "24");
    await click("access-tab-sharing");
    await type("publicWebHostname", "chat.example.com");
    await click("access-tab-guests");
    await click("access-tab-login");
    expect([session === byId("webSessionAbsolute"), hostname === byId("publicWebHostname"), session.value, hostname.value])
      .toEqual([true, true, "24", "chat.example.com"]);
    expect(byId("access-panel-login").hasAttribute("hidden")).toBe(false);
    expect(p.root.querySelector(".s-pending")).not.toBeNull();
    expect(writes).toEqual([]);
  });

  it("lists the Sign-in & authorization cards in the reference order: owner verification, sessions, web authorization", async () => {
    webOnly = true;
    await open("access");
    const login = byId("access-panel-login");
    const order = [...login.querySelectorAll(".s-outside, .s-access-session, .s-web-authority")].map((c: any) => c.className.split(" ").find((x: string) => /^s-(outside|access-session|web-authority)$/.test(x)));
    expect(order).toEqual(["s-outside", "s-access-session", "s-web-authority"]);
    expect([byId("outsideCard").querySelector("h3").textContent, byId("outState").textContent]).toEqual(["Owner verification", "Not set up"]);
    expect(login.querySelector(".s-authority-rule")?.textContent).toContain("judged separately");
  });

  it("opens a hidden Sharing tab and its credentials disclosure for a settings-search target", async () => {
    registry.goToTarget("access", "#publicTunnelToken");
    await p.mount(h(SettingsPanel, { route: nav.navStore.get().route, navKey: `target:${nav.navStore.get().seq}` }));
    await settle(26);
    expect(byId("access-tab-sharing").getAttribute("aria-selected")).toBe("true");
    expect(byId("access-panel-sharing").hasAttribute("hidden")).toBe(false);
    expect(byId("publicTunnelToken").closest("details").open).toBe(true);
    expect(p.document.activeElement).toBe(byId("publicTunnelToken"));
    expect(writes).toEqual([]);
  });

  it("reveals a deep-linked Access field while keeping the public-link form disabled", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    await open("access", "#publicWebHostname");
    expect(byId("access-tab-sharing").getAttribute("aria-selected")).toBe("true");
    expect(byId("publicWebHostname").closest("fieldset").disabled).toBe(true);
    expect(byId("publicTunnelToken")).toBeNull();
    expect(byId("vaEnabled")).toBeNull();
    expect(byId("guestsEnabled")).toBeNull();
    expect(writes).toEqual([]);
  });

  it("expands disclosures for a direct hash target while preserving the existing Access draft", async () => {
    await open("access");
    await click("access-tab-login");
    const session = byId("webSessionAbsolute"), token = byId("publicTunnelToken");
    const disclosure = token.closest("details");
    expect(disclosure.open, "the credentials editor starts collapsed").toBe(false);
    expect(byId("access-panel-sharing").hasAttribute("hidden")).toBe(true);
    await type("webSessionAbsolute", "24");

    // A URL hash, not registry.goToTarget: the hash-reveal path owns this navigation.
    await open("access", "#publicTunnelToken");
    expect(byId("access-panel-sharing").hasAttribute("hidden")).toBe(false);
    expect(disclosure.open, "a revealed tab must also reveal the field's disclosure").toBe(true);
    for (let d = token.closest("details"); d; d = d.parentElement?.closest("details")) expect(d.open).toBe(true);
    expect([byId("publicTunnelToken") === token, byId("webSessionAbsolute") === session, session.value])
      .toEqual([true, true, "24"]);
    expect(writes).toEqual([]);
  });

  it("lets the Save bar reveal an invalid field hidden in another Access tab", async () => {
    await open("access");
    await click("access-tab-sharing");
    await type("publicWebTtl", "999");
    await click("access-tab-login");
    const fix = p.root.querySelector(".s-pending button.s-fix") as any;
    expect(fix).not.toBeNull();
    fix.click(); await settle(4);
    await p.mount(h(SettingsPanel, { route: nav.navStore.get().route, navKey: `fix:${nav.navStore.get().seq}` }));
    await settle(22);
    expect(byId("access-tab-sharing").getAttribute("aria-selected")).toBe("true");
    expect(p.document.activeElement).toBe(byId("publicWebTtl"));
    expect(byId("publicWebTtl").value).toBe("999");
    expect(writes).toEqual([]);
  });

  it("keeps an unstaged YAML edit while inspecting effective values, with no editable readonly controls", async () => {
    await open("advanced");
    const edit = p.root.querySelectorAll(".s-dev-bar button").find((button: any) => button.textContent === "Edit");
    edit.click(); await settle(5);
    const field = p.root.querySelector("textarea.s-yaml") as any;
    const text = "defaults:\n  locale: en\ninstances: {}\n";
    field.value = text; fire(field, "input"); await settle(5);
    await click("advanced-tab-effective");
    expect(p.root.querySelectorAll(".s-web-ro input, .s-web-ro select, .s-web-ro textarea")).toHaveLength(0);
    expect(byId("advanced-panel-effective").hasAttribute("hidden")).toBe(false);
    await click("advanced-tab-editor");
    expect(p.root.querySelector("textarea.s-yaml")).toBe(field);
    expect(field.value).toBe(text);
    expect(writes).toEqual([]);
  });
});
