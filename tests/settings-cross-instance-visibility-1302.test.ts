/**
 * #1302: the Settings page exposes `cross_instance_visibility` as a fleet default and as a per-instance override.
 * Nothing is written for a user who never touched it (the #1298 lesson): an unrelated edit leaves the key out of the
 * PATCH / PUT, even when fleet.yaml holds a value the picker cannot show. What the page sends goes through the real
 * settings API into a scratch fleet.yaml and comes back on the next load.
 *
 * #1408 step 3: the agent editor and the General defaults are rendered in the mini DOM (fake fetch for the server);
 * the round trip below is the real settings API against a scratch fleet.yaml, as before.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { crossInstanceVisibility } from "../src/cross-instance-notice.js";

interface Sent { method: string; path: string; body: any }
const schema = buildSettingsImpactSchema();
let p: AppPage;
let fleet: any;
let sent: Sent[] = [];

const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  const body = (() => {
    if (method !== "GET") return method === "POST" ? { id: "job-1", status: "done", targets: [] } : { ok: true };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return fleet;
    if (path === "/api/settings/classic") return { channels: {}, defaults: {} };
    if (path === "/api/settings/connections") return [];
    if (path === "/api/settings/status-emojis") return { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] };
    if (path === "/api/fleet") return { version: "2.1.12", instances: [{ name: "worker", status: "running" }] };
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};

const realFetch = (globalThis as any).fetch;
beforeAll(() => {
  p = page({ url: "http://127.0.0.1:19280/settings" });
  (globalThis as any).fetch = fakeFetch;
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => {
  fleet = { defaults: { locale: "en" }, instances: {}, channels: [] };
  sent = [];
  (globalThis as any).confirm = () => true;
  p.window.confirm = () => true;
});
afterEach(async () => {
  await p.unmount();
  const { resetOperation } = await import("/ui/js/settings-apply.js");
  const { resetConfirmations } = await import("/ui/js/settings-confirm.js");
  resetOperation(); resetConfirmations();
});

const mountSection = async (section: "agents" | "general") => {
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}` }));
  await settle(12);
};
const button = (label: string, root: any = p.root) => {
  const found = root.querySelectorAll("button").filter((b: any) => b.textContent.trim() === label);
  expect(found.length, `button ${label}`).toBeGreaterThan(0);
  return found[0];
};
const click = async (el: any) => { fire(el, "click"); await settle(); };
const choose = async (el: any, value: string) => { el.value = value; fire(el, "change"); await settle(); };
const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(); };
const type = async (el: any, value: string) => { el.value = value; fire(el, "input"); await settle(); };
const writes = () => sent.filter(s => s.method !== "GET");
/** The visibility picker: the select that offers the three modes (a value it does not offer is listed first, too). */
const visibilityPicker = (root: any = p.root) => root.querySelectorAll("select").filter((s: any) => {
  const values = s.querySelectorAll("option").map((o: any) => o.value);
  return ["full", "summary", "hidden"].every(m => values.includes(m));
});
/** The "Inherit from defaults" checkbox in the same field as the picker. */
const inheritOf = (picker: any) => picker.closest(".field").querySelector("input[type=checkbox]");

async function openAgent(inst: Record<string, unknown>, defaults: Record<string, unknown> = {}) {
  fleet = { defaults: { locale: "en", ...defaults }, instances: { worker: inst }, channels: [] };
  await mountSection("agents");
  await click(button("Settings"));
  const pickers = visibilityPicker(p.root);
  expect(pickers).toHaveLength(1);
  return { picker: pickers[0]!, inherit: inheritOf(pickers[0]!) };
}
/** Stage the agent dialog, then Apply; the PATCH it sent for the agent. */
async function saveAgent() {
  sent = [];
  await click(button("Stage change"));
  await click(button("Apply changes", p.root.querySelector("[role=region]")));
  return writes().find(s => s.path === "/api/settings/fleet/instances/worker") ?? null;
}
async function openGeneral(defaults: Record<string, unknown>) {
  // The language picker is set, so a save writes only this one key's neighbours (the locale picker is #1310's).
  fleet = { defaults: { locale: "en", ...defaults }, instances: {}, channels: [] };
  await mountSection("general");
  const picker = visibilityPicker(p.root.querySelector(".s-general")!)[0]!;
  /** Review, then Apply: the defaults PUT it sends (null when nothing differs). */
  const review = async () => {
    sent = [];
    await click(button("Review changes"));
    const region = p.root.querySelector("[role=region]");
    if (!region) return null;
    await click(button("Apply changes", region));
    return sent.find(s => s.path === "/api/settings/fleet/defaults") ?? null;
  };
  return { picker, review };
}

describe("the agent editor", () => {
  it("unset: shows the fleet default as inherited, and an unrelated edit sends nothing for it", async () => {
    const { picker } = await openAgent({ working_directory: "/w", description: "old" }, { cross_instance_visibility: "summary" });
    expect(picker.value).toBe("summary");
    expect(picker.disabled).toBe(true);
    await type(p.root.querySelector("#ag-desc"), "new desc");
    expect(await saveAgent()).toEqual({ method: "PATCH", path: "/api/settings/fleet/instances/worker", body: { description: "new desc" } });
  });

  it("a value the picker cannot show (a typo in fleet.yaml) is not rewritten by an unrelated edit", async () => {
    const { picker } = await openAgent({ working_directory: "/w", description: "old", cross_instance_visibility: "verbose" });
    expect(picker.value).toBe("full");                          // what the fleet does with it: unknown reads as unset
    await type(p.root.querySelector("#ag-desc"), "new desc");
    expect((await saveAgent())!.body).toEqual({ description: "new desc" });
  });

  it("override, change and back to inherit", async () => {
    const set = await openAgent({ working_directory: "/w" });
    await check(set.inherit, false);
    await choose(set.picker, "hidden");
    expect((await saveAgent())!.body).toEqual({ cross_instance_visibility: "hidden" });

    const change = await openAgent({ working_directory: "/w", cross_instance_visibility: "hidden" });
    expect(change.picker.value).toBe("hidden");
    expect(change.picker.disabled).toBe(false);
    await choose(change.picker, "summary");
    expect((await saveAgent())!.body).toEqual({ cross_instance_visibility: "summary" });

    const inherit = await openAgent({ working_directory: "/w", cross_instance_visibility: "hidden" });
    await check(inherit.inherit, true);
    expect((await saveAgent())!.body).toEqual({ cross_instance_visibility: null });
  });
});

describe("the fleet defaults", () => {
  it("unset: shows full, and saving other defaults sends nothing for it", async () => {
    const g = await openGeneral({ tool_progress: "off" });
    expect(g.picker.value).toBe("full");
    await choose(p.root.querySelector("#g-tp")!, "verbose");
    expect((await g.review())!.body).toEqual({ tool_progress: "verbose" });
  });

  it("untouched: nothing staged at all; a value the picker cannot show is left alone", async () => {
    expect(await (await openGeneral({})).review()).toBeNull();
    expect(await (await openGeneral({ cross_instance_visibility: "loud" })).review()).toBeNull();
    expect(await (await openGeneral({ cross_instance_visibility: "hidden" })).review()).toBeNull();
  });

  it("changed: one PUT with the new mode", async () => {
    const g = await openGeneral({ cross_instance_visibility: "hidden" });
    expect(g.picker.value).toBe("hidden");
    await choose(g.picker, "summary");
    expect(await g.review()).toEqual({ method: "PUT", path: "/api/settings/fleet/defaults", body: { cross_instance_visibility: "summary" } });
  });
});

describe("round trip through the settings API and fleet.yaml", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function request(fm: FleetManager, path: string, method = "GET", body?: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
      req.method = method; req.destroy = () => undefined;
      let status = 0;
      const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload) }); } };
      try {
        expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), fm as never)).toBe(true);
        if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      } catch (err) { reject(err); }
    });
  }

  it("what the page sends is saved, validated, read back raw, and survives a reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1302-settings-")); dirs.push(dir);
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, `# header\ndefaults:\n  tool_progress: off\ninstances:\n  worker:\n    working_directory: ${dir}\n    topic_id: 5\n  other:\n    working_directory: ${dir}\n    topic_id: 6\n`);
    const fm = new FleetManager(dir);
    try {
      fm.loadConfig(path);
      expect((await request(fm, "/api/settings/fleet/defaults", "PUT", { cross_instance_visibility: "summary" })).status).toBe(200);
      expect((await request(fm, "/api/settings/fleet/instances/worker", "PATCH", { cross_instance_visibility: "hidden" })).status).toBe(200);
      expect((await request(fm, "/api/settings/fleet/instances/worker", "PATCH", { cross_instance_visibility: "loud" })).status).toBe(400);

      const raw = (await request(fm, "/api/settings/fleet/raw")).body;
      expect(raw.defaults.cross_instance_visibility).toBe("summary");
      expect(raw.instances.worker.cross_instance_visibility).toBe("hidden");
      expect(raw.instances.other).not.toHaveProperty("cross_instance_visibility");

      const reloaded = new FleetManager(dir);
      reloaded.loadConfig(path);
      expect(crossInstanceVisibility(reloaded.fleetConfig, "worker")).toBe("hidden");
      expect(crossInstanceVisibility(reloaded.fleetConfig, "other")).toBe("summary");
      expect(readFileSync(path, "utf8")).toContain("# header");

      // Back to inherit: null removes the override, it is not stored as null.
      expect((await request(fm, "/api/settings/fleet/instances/worker", "PATCH", { cross_instance_visibility: null })).status).toBe(200);
      expect(readFileSync(path, "utf8").match(/cross_instance_visibility/g)).toHaveLength(1);
      expect(crossInstanceVisibility(fm.fleetConfig, "worker")).toBe("summary");
      for (const f of [fm, reloaded]) { f.stormWindow.shutdown(); f.spawnGate.shutdown(); f.memoryPressure.stop(); }
    } catch (err) {
      fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); fm.memoryPressure.stop();
      throw err;
    }
  });
});
