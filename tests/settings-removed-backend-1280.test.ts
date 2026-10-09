/**
 * #1280 review (P2): with gemini-cli gone from the Settings backend list, an instance (or the fleet default) still
 * set to it showed a select with no matching option. A browser select then falls to its first option, so editing
 * only the description sent `backend: "claude-code"` too — the CLI and account changed without anyone choosing it.
 * The backend picker now keeps an unoffered current value first and selected until the user picks another.
 *
 * #1408 step 3: the panel's own pickers, rendered in the mini DOM (no server). The mini DOM's <select> does not fall
 * to its first option the way a browser's does, so the picker's list is asserted directly: the current value is the
 * first option, and it is the only one that is not offered. The pure rule is backendOptions (settings-model.js).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { backendOptions, BACKENDS } from "/ui/js/settings-model.js";

interface Sent { method: string; path: string; body: any; headers: Record<string, string> }
interface World { fleet: any; classic: any; instances: Record<string, any>; connections: any[]; providerSecrets: any[] }

const schema = buildSettingsImpactSchema();
let p: AppPage;
let w: World;
let sent: Sent[] = [];
let answer: (method: string, path: string, body: any) => { status?: number; body?: unknown } | undefined = () => undefined;

const fakeFetch = async (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body) : undefined;
  sent.push({ method, path, body, headers: init.headers ?? {} });
  const r = answer(method, path, body) ?? reads(method, path) ?? {};
  const status = r.status ?? 200;
  return { ok: status < 400, status, json: async () => r.body ?? {} };
};
function reads(method: string, path: string): { status?: number; body?: unknown } | undefined {
  if (method !== "GET") return undefined;
  if (path === "/api/settings/schema") return { body: schema };
  if (path === "/api/settings/fleet/raw") return { body: w.fleet };
  if (path === "/api/settings/classic") return { body: w.classic };
  if (path === "/api/settings/connections") return { body: w.connections };
  if (path === "/api/settings/provider-secrets") return { body: w.providerSecrets };
  if (path === "/api/fleet") return { body: { version: "2.1.12", instances: Object.entries(w.instances).map(([name, i]) => ({ name, ...i })) } };
  if (path === "/api/profiles" || path === "/api/settings/pending") return { body: [] };
  if (path === "/api/settings/status-emojis") return { body: { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] } };
  return undefined;
}
const succeed = (method: string, path: string) => (method === "POST" && path === "/api/settings/apply" ? { body: { id: "job-1", status: "done", targets: [] } } : method !== "GET" ? { body: { ok: true } } : undefined);

const realFetch = (globalThis as any).fetch;
beforeAll(() => {
  p = page({ url: "http://127.0.0.1:19280/settings" });
  (globalThis as any).fetch = fakeFetch;
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => {
  w = { fleet: { defaults: {}, instances: {}, channels: [] }, classic: { channels: {}, defaults: {} }, instances: {}, connections: [], providerSecrets: [] };
  sent = []; answer = succeed;
  (globalThis as any).confirm = () => true;
  p.window.confirm = () => true;
});
afterEach(async () => {
  await p.unmount();
  const { resetOperation } = await import("/ui/js/settings-apply.js");
  const { resetConfirmations } = await import("/ui/js/settings-confirm.js");
  resetOperation(); resetConfirmations();
});

const mountSettings = async (section = "agents") => {
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}` }));
  await settle(12);
};
const buttons = (label: string, root: any = p.root): any[] => root.querySelectorAll("button").filter((b: any) => b.textContent.trim() === label);
const button = (label: string, root: any = p.root) => { const found = buttons(label, root); expect(found.length, `button ${label}`).toBeGreaterThan(0); return found[0]; };
const click = async (el: any) => { fire(el, "click"); await settle(); };
const type = async (el: any, value: string) => { el.value = value; fire(el, "input"); await settle(); };
const choose = async (el: any, value: string) => { el.value = value; fire(el, "change"); await settle(); };
const writes = () => sent.filter(s => s.method !== "GET");
const optionValues = (select: any) => select.querySelectorAll("option").map((o: any) => o.value);

describe("the backend picker keeps a value it does not offer", () => {
  it("the pure rule: a removed backend stays first, marked unavailable; an offered one leaves the list unchanged", () => {
    const kept: any[] = backendOptions("gemini-cli");
    expect(kept[0]).toEqual({ value: "gemini-cli", label: null, unavailable: true });
    expect(kept.slice(1).map((o: any) => o.value)).toEqual(BACKENDS);
    expect(backendOptions("codex").map((o: any) => o.value)).toEqual(BACKENDS);
    expect(backendOptions("codex").some((o: any) => o.unavailable)).toBe(false);
  });

  it("rendered: a removed backend is the first option and labelled as removed; an offered one is selected from the list", async () => {
    w.instances = { worker: { status: "running" } };
    w.fleet = { defaults: {}, instances: { worker: { working_directory: "/w", channel_id: "dc", backend: "gemini-cli" } }, channels: [{ id: "dc", type: "discord", access: { mode: "locked", allowed_users: [] } }] };
    await mountSettings("agents");
    await click(button("Settings"));
    const picker = p.root.querySelector("#ag-be")!;
    expect(picker.value).toBe("gemini-cli");
    expect(optionValues(picker)).toEqual(["gemini-cli", ...BACKENDS]);
    expect(picker.querySelectorAll("option")[0]!.textContent).toBe("gemini-cli (removed — choose another backend)");
    expect(picker.querySelectorAll("option").slice(1).some((o: any) => o.textContent.includes("removed"))).toBe(false);
    // Offered ones: the list is exactly the backends, with no extra entry.
    await click(button("Stage change"));
    sent = [];
    w.fleet.instances.worker.backend = "codex";
    await mountSettings("agents");
    await click(button("Settings"));
    expect(p.root.querySelector("#ag-be")!.value).toBe("codex");
    expect(optionValues(p.root.querySelector("#ag-be"))).toEqual(BACKENDS);
  });

  it("fleet defaults: an unrelated edit leaves `backend` out of the defaults PATCH", async () => {
    w.fleet = { defaults: { backend: "gemini-cli", locale: "en", log_level: "info" }, instances: {}, channels: [] };
    await mountSettings("general");
    expect(p.root.querySelector("#g-be")!.value).toBe("gemini-cli");
    expect(optionValues(p.root.querySelector("#g-be"))[0]).toBe("gemini-cli");
    await choose(p.root.querySelector("#g-ll")!, "warn");
    await click(button("Review changes"));
    await click(button("Apply changes", p.root.querySelector("[role=region]")));
    const put = writes().find(s => s.path === "/api/settings/fleet/defaults")!;
    expect(put.body).toEqual({ log_level: "warn" });
    expect(put.body).not.toHaveProperty("backend");
  });
});

describe("the agent editor (#1280 review): editing only the description of a gemini-cli instance", () => {
  it("stages a PATCH with the description and no backend", async () => {
    w.instances = { worker: { status: "running" } };
    w.fleet = { defaults: {}, instances: { worker: { working_directory: "/w", channel_id: "dc", backend: "gemini-cli", description: "old desc" } }, channels: [{ id: "dc", type: "discord", access: { mode: "locked", allowed_users: [] } }] };
    await mountSettings("agents");
    await click(button("Settings"));
    expect(p.root.querySelector("#ag-be")!.value).toBe("gemini-cli");
    const desc = p.root.querySelector("#ag-desc")!;
    expect(desc.value).toBe("old desc");
    await type(desc, "new desc");
    await click(button("Stage change"));
    await click(button("Apply changes", p.root.querySelector("[role=region]")));
    expect(writes().filter(s => s.path.startsWith("/api/settings/fleet/instances/"))).toEqual([
      expect.objectContaining({ method: "PATCH", path: "/api/settings/fleet/instances/worker", body: { description: "new desc" } }),
    ]);
  });
});
