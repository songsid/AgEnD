import { beforeAll, beforeEach, afterAll, afterEach, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
let p: AppPage, settings: any;
const sent: any[] = [], originalFetch = globalThis.fetch;
let allStopped = false;
const raw = { defaults: { backend: "claude-code", model: "sonnet" }, instances: {
  Alpha: { working_directory: "/w/alpha", display_name: "Example Alpha" }, Beta: { working_directory: "/w/beta", backend: "codex" },
  Gamma: { working_directory: "/w/gamma", backend: "muse" }, Delta: { working_directory: "/w/delta", model: "opus" },
} };
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19284/settings/general", storage: { agend_tour_done: "1" } });
  globalThis.fetch = (async (path: string, init: any = {}) => {
    if (init.method && init.method !== "GET") sent.push({ path, body: init.body && JSON.parse(init.body) });
    const body = path === "/api/settings/schema" ? buildSettingsImpactSchema()
      : path === "/api/settings/fleet/raw" ? raw
      : path === "/api/settings/classic" ? { defaults: {}, channels: {} }
      : path === "/api/fleet" ? { version: "fixture", instances: Object.keys(raw.instances).map(name => ({ name, status: allStopped ? "stopped" : "running" })) }
      : path.startsWith("/ui/models") ? { models: [{ id: "sonnet" }, { id: "haiku" }] }
      : path === "/api/settings/apply" ? { id: "fixture-apply", status: "done", targets: [{ target: "Alpha", kind: "restart", status: "next-start" }] }
      : init.method ? { ok: true, shared_defaults_consent: "00000000-0000-4000-8000-000000000001" } : [];
    return { ok: true, status: 200, json: async () => body };
  }) as any;
  (await import("/assets/app-nav.js")).startRouter(p.window);
  settings = await import("/ui/js/panel-settings.js");
});
beforeEach(async () => { sent.length = 0; allStopped = false; (globalThis as any).confirm = undefined; (await import("/ui/js/settings-apply.js")).resetOperation(); });
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
  expect($(".s-pending .note").textContent).not.toContain(lang === "en" ? "Restart this Agent" : "重新啟動此 Agent");
});
it("R1: cancels restart before any write, then carries next-start through Apply and renders its outcome", async () => {
  await open("en"); await choose("g-model", "haiku"); await choose("g-default-adoption", "restart");
  $(".s-pending .btn-primary").click(); await settle(5);
  const { confirmStore, answerConfirm } = await import("/assets/ui-confirm.js");
  const q = confirmStore.get().queue[0]; expect(q.message).toContain("interrupts their current sessions");
  expect(q.message).toContain("1");
  expect(q.message).toContain("Example Alpha");
  expect(sent).toEqual([]); answerConfirm(q.id, false); await settle(5);
  expect(sent).toEqual([]);
  await choose("g-default-adoption", "next-start"); $(".s-pending .btn-primary").click(); await settle(14);
  expect(sent.find(s => s.path === "/api/settings/apply").body.shared_defaults).toBe("next-start");
  expect($(".s-step.next-start").textContent).toContain("Saved · applies on next restart");
  expect($(".s-step.next-start .s-op-name").textContent).toBe("Example Alpha");
  expect($(".s-op").textContent).not.toContain("Restart this Agent");
});

it("keeps the cost of other cold changes visible beside the deferred model choice", async () => {
  await open("en"); await choose("g-model", "haiku"); await choose("g-ts", "full");
  const note = $(".s-pending .note").textContent;
  expect(note).toContain("Next restart · no restart now");
  expect(note).toContain("Other changes: Restart this Agent");
});

it("R1: disables immediate restart when no affected owner is known running", async () => {
  allStopped = true; await open("en"); await choose("g-model", "haiku");
  expect($("#g-default-adoption").querySelectorAll("option").find((o: any) => o.value === "restart").disabled).toBe(true);
  expect($("#g-default-adoption").value).toBe("next-start");
});
it("R1: the accepted request keeps the exact names shown even if the staged scope changes while the question is open", async () => {
  await open("en"); await choose("g-model", "haiku"); await choose("g-default-adoption", "restart");
  $(".s-pending .btn-primary").click(); await settle(5);
  const { confirmStore, answerConfirm } = await import("/assets/ui-confirm.js");
  const q = confirmStore.get().queue[0]; expect(q.message).toContain("Example Alpha"); expect(q.message).not.toContain("Beta");
  try {
    raw.instances.Beta.backend = "claude-code";
    await choose("g-model", "opus"); // the confirmed write must stay haiku, not this later draft
    await choose("g-tp", "verbose"); // simulates a recomputed draft scope; the open question still authorizes only Alpha
    answerConfirm(q.id, true); await settle(14);
    const request = sent.find(s => s.path === "/api/settings/apply");
    expect(request.body.shared_defaults).toBe("restart");
    expect(request.body.shared_defaults_targets).toEqual(["Alpha"]);
    expect(request.body.shared_defaults_consent).toBe("00000000-0000-4000-8000-000000000001");
    expect(sent.find(s => s.path === "/api/settings/fleet/defaults").body).toMatchObject({ backend: "claude-code", model: "haiku" });
  } finally { raw.instances.Beta.backend = "codex"; }
});

it("R2: Classic model inheritance label follows the selected backend", async () => {
  const { ClassicDialog } = await import("/ui/js/settings-dialogs.js");
  (await import("/assets/app-i18n.js")).setLang("en");
  const ctx = { fleet: { defaults: { backend: "claude-code", model: "opus" }, instances: {} }, classic: { defaults: {} }, schema: buildSettingsImpactSchema(), classicRuntime: () => ({ execution: "stopped" }) };
  await p.mount(h(ClassicDialog, { room: { instanceName: "example-room", backend: "codex" }, ctx, onClose: () => {} }));
  await settle(8);
  expect($("#cl-model").closest(".field").textContent).not.toContain("opus");
  await choose("cl-be", "claude-code");
  expect($("#cl-model").closest(".field").textContent).toContain("opus");
});
