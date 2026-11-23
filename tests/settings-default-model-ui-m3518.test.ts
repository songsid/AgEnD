import { beforeAll, beforeEach, afterAll, afterEach, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
let p: AppPage, settings: any;
const sent: any[] = [], originalFetch = globalThis.fetch;
const raw = { defaults: { backend: "claude-code", model: "sonnet" }, instances: {
  Alpha: { working_directory: "/w/alpha" }, Beta: { working_directory: "/w/beta", backend: "codex" },
  Gamma: { working_directory: "/w/gamma", backend: "muse" }, Delta: { working_directory: "/w/delta", model: "opus" },
} };
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19284/settings/general", storage: { agend_tour_done: "1" } });
  globalThis.fetch = (async (path: string, init: any = {}) => {
    if (init.method && init.method !== "GET") sent.push({ path, body: init.body && JSON.parse(init.body) });
    const body = path === "/api/settings/schema" ? buildSettingsImpactSchema()
      : path === "/api/settings/fleet/raw" ? raw
      : path === "/api/settings/classic" ? { defaults: {}, channels: {} }
      : path === "/api/fleet" ? { version: "fixture", instances: Object.keys(raw.instances).map(name => ({ name, status: "running" })) }
      : path.startsWith("/ui/models") ? { models: [{ id: "sonnet" }, { id: "haiku" }] }
      : path === "/api/settings/apply" ? { id: "fixture-apply", status: "done", targets: [{ target: "Alpha", kind: "restart", status: "next-start" }] }
      : init.method ? { ok: true } : [];
    return { ok: true, status: 200, json: async () => body };
  }) as any;
  (await import("/assets/app-nav.js")).startRouter(p.window);
  settings = await import("/ui/js/panel-settings.js");
});
beforeEach(async () => { sent.length = 0; (globalThis as any).confirm = undefined; (await import("/ui/js/settings-apply.js")).resetOperation(); });
afterEach(async () => { await p.unmount(); });
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });
const $ = (sel: string): any => p.root.querySelector(sel);
const choose = async (id: string, value: string) => { const el = $(`#${id}`); el.value = value; fire(el, "change"); await settle(5); };
const open = async (lang: string) => {
  (await import("/assets/app-i18n.js")).setLang(lang);
  await p.mount(h(settings.SettingsPanel, { route: { panel: "settings", section: "general" }, navKey: `settings:general|${lang}` }));
  await settle(14);
};
it.each(["en", "zh-TW"])("scopes the count and exposes a safe timing choice before saving (%s)", async lang => {
  await open(lang);
  expect($("#g-model").closest(".field").textContent).toContain("1/2");
  expect($("#g-default-adoption")).toBeNull();
  await choose("g-model", "haiku");
  expect($("#g-default-adoption").value).toBe("next-start");
  expect($("#g-default-adoption").closest(".field").textContent).toContain("Alpha");
  expect($("#g-default-adoption").closest(".field").textContent).not.toContain("Beta");
  expect(sent).toEqual([]);
});
it("cancels restart before any write, then carries next-start through Apply and renders its outcome", async () => {
  await open("en"); await choose("g-model", "haiku"); await choose("g-default-adoption", "restart");
  $(".s-pending .btn-primary").click(); await settle(5);
  const { confirmStore, answerConfirm } = await import("/assets/ui-confirm.js");
  const q = confirmStore.get().queue[0]; expect(q.message).toContain("interrupts their current sessions");
  expect(sent).toEqual([]); answerConfirm(q.id, false); await settle(5);
  expect(sent).toEqual([]);
  await choose("g-default-adoption", "next-start"); $(".s-pending .btn-primary").click(); await settle(14);
  expect(sent.find(s => s.path === "/api/settings/apply").body.shared_defaults).toBe("next-start");
  expect($(".s-step.next-start").textContent).toContain("Saved · applies on next restart");
});
