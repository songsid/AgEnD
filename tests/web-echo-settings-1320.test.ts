import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { FleetManager } from "../src/fleet-manager.js";

// Fail fast if a regression escapes the intended in-process/IO seams.
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
  rotateLogIfNeeded: () => { throw new Error("log rotation is outside this harness"); },
  rotateLogIfNeededAsync: async () => { throw new Error("log rotation is outside this harness"); },
}));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("process execution is outside this harness"); };
  return { ...original, spawn: blocked, spawnSync: blocked, exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, fork: blocked };
});


const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function context(web?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "echo-settings-")); dirs.push(dir); vi.stubEnv("AGEND_HOME", dir);
  const fm = new FleetManager(dir), s = fm as any;
  s.configPath = join(dir, "fleet.yaml");
  s.fleetConfig = { defaults: {}, instances: { worker: { working_directory: dir } }, ...(web ? { web } : {}) };
  writeFileSync(s.configPath, yaml.dump(s.fleetConfig)); s.savedFleetConfigSnapshot = structuredClone(s.fleetConfig);
  return { fm, s, path: s.configPath, raw: () => yaml.load(readFileSync(s.configPath, "utf8")) as any };
}
function request(ctx: FleetManager, path: string, body: unknown) {
  return new Promise<{ status: number; body: any }>(resolve => {
    let status = 0;
    const req = Object.assign(new EventEmitter(), { method: "PUT", destroy() {} });
    const res = { writeHead(code: number) { status = code; }, end(text: string) { resolve({ status, body: JSON.parse(text) }); } };
    expect(handleSettingsRequest(req as never, res as never, new URL(path, "http://localhost"), ctx as unknown as SettingsApiContext)).toBe(true);
    req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end");
  });
}

describe("web echo config and Settings (#1320 A)", () => {
  it("public-link sparse settings preserve unknown/unrelated web fields and reject invalid patches (#1367)", async () => {
    const h = context({ usage_panel: false, public_link: { protocol: "quic" } });
    expect((await request(h.fm, "/api/settings/fleet/web", { public_link: { allow_public: false } })).status).toBe(200);
    expect(h.raw().web).toEqual({ usage_panel: false, public_link: { protocol: "quic", allow_public: false } });
    expect((await request(h.fm, "/api/settings/fleet/web", { public_link: { ttl_minutes: 481 } })).status).toBe(400);
    expect(h.raw().web.public_link.ttl_minutes).toBeUndefined();
  });

  it("real Settings handler refuses array protocol without writing (#1367 r2)", async () => {
    const h = context({ public_link: { protocol: "http2" } });
    expect((await request(h.fm, "/api/settings/fleet/web", { public_link: { protocol: ["quic"] } })).status).toBe(400);
    expect(h.raw().web.public_link).toEqual({ protocol: "http2" });
    expect((await request(h.fm, "/api/settings/fleet/web", { public_link: { protocol: "quic" } })).status).toBe(200);
    expect(h.raw().web.public_link).toEqual({ protocol: "quic" });
  });

  it("validates boolean config and declares a hot impact", () => {
    for (const value of [true, false]) expect(validateFleetConfig({ instances: {}, web: { echo_to_channel: value } }).errors).toEqual([]);
    for (const value of ["false", null, 0, {}]) expect(validateFleetConfig({ instances: {}, web: { echo_to_channel: value } }).errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "web.echo_to_channel" })]));
    expect(buildSettingsImpactSchema().impacts["web.echo_to_channel"]).toBe("now");
  });

  it("explicit toggles persist, preserve the other web fields, and apply immediately", async () => {
    const h = context({ usage_panel: false, view_access: "session" });
    expect((await request(h.fm, "/api/settings/fleet/web", { echo_to_channel: false })).status).toBe(200);
    expect(h.raw().web).toEqual({ usage_panel: false, view_access: "session", echo_to_channel: false });
    expect(h.s.fleetConfig.web.echo_to_channel).toBe(false);
    expect((await request(h.fm, "/api/settings/fleet/web", { echo_to_channel: true })).status).toBe(200);
    expect(h.raw().web.echo_to_channel).toBe(true);
  });

  it("empty web patch and unrelated edit do not create the default key", async () => {
    const h = context();
    await request(h.fm, "/api/settings/fleet/web", {});
    await request(h.fm, "/api/settings/fleet/defaults", { tool_progress: "standard" });
    expect(h.raw().web).toBeUndefined(); expect(h.s.fleetConfig.web).toBeUndefined();
  });

  it.each([{ echo_to_channel: "false" }, { echo_to_channel: null }, { allowed_hosts: ["evil"] }, []])("rejects invalid or unrelated fields without writing (%j)", async body => {
    const h = context(); const original = readFileSync(h.path, "utf8");
    expect((await request(h.fm, "/api/settings/fleet/web", body)).status).toBe(400);
    expect(readFileSync(h.path, "utf8")).toBe(original); expect(h.s.fleetConfig.web).toBeUndefined();
  });
});

// ── The General section's web chat, rendered (#1408 step 3: the panel in the mini DOM, a fake fetch for the server) ──

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
    if (path === "/api/settings/status-emojis") return { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] };
    if (path === "/api/fleet") return { version: "2.1.12", instances: [] };
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};

beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/settings" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => {
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

/** The General section with the given fleet.yaml (its web block, if any). */
async function general(web?: Record<string, unknown>) {
  fleet = { defaults: { locale: "en" }, instances: {}, channels: [], ...(web ? { web } : {}) };
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "general" }, navKey: "settings:general" }));
  await settle(12);
  const $ = (id: string) => p.root.querySelector(`#${id}`)!;
  const click = async (el: any) => { fire(el, "click"); await settle(); };
  const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(); };
  const choose = async (el: any, value: string) => { el.value = value; fire(el, "change"); await settle(); };
  const type = async (el: any, value: string) => { el.value = value; fire(el, "input"); await settle(); };
  const button = (label: string, root: any = p.root) => root.querySelectorAll("button").find((b: any) => b.textContent.trim() === label);
  const writes = () => sent.filter(s => s.method !== "GET");
  /** Review, then Apply: the writes it sent (none when nothing differs). */
  const save = async () => { await click(button("Review changes")); };
  const apply = async () => {
    const region = p.root.querySelector("[role=region]");
    if (region) await click(button("Apply changes", region));
  };
  return { $, check, type, choose, save, apply, writes, pending: () => p.root.querySelector("[role=region]"), click, button };
}

describe("web echo config and Settings, as rendered (#1320 A)", () => {
  it("public-link controls display defaults without writing, then send only edited leaves (#1367)", async () => {
    const h = await general();
    expect(h.$("publicWebLink").checked).toBe(true);
    expect(Number(h.$("publicWebTtl").value)).toBe(120);
    await h.save(); await h.apply();
    expect(h.writes().some(s => s.path.endsWith("/web"))).toBe(false);
    await h.check(h.$("publicWebLink"), false); await h.type(h.$("publicWebTtl"), "30");
    await h.save(); await h.apply();
    expect(h.writes().filter(s => s.path.endsWith("/web"))).toEqual([{ method: "PUT", path: "/api/settings/fleet/web", body: { public_link: { allow_public: false, ttl_minutes: 30 } } }]);
  });

  it("the web batch derives changed-leaf impact from the server schema (#1367)", async () => {
    const before = schema.impacts["web.public_link.ttl_minutes"];
    schema.impacts["web.public_link.ttl_minutes"] = "fleet";
    try {
      const h = await general();
      await h.type(h.$("publicWebTtl"), "30");
      await h.check(h.$("webEchoToChannel"), false);
      await h.save();
      expect(h.pending()!.textContent).toContain("Restart AgEnD");
      expect(h.pending()!.textContent).not.toContain("Immediately");
    } finally { schema.impacts["web.public_link.ttl_minutes"] = before; }
  });

  it("public-link Settings rejects invalid TTL before staging any unrelated edits (#1367)", async () => {
    const h = await general();
    await h.type(h.$("publicWebTtl"), "481");
    await h.choose(h.$("g-tp"), "standard");
    await h.check(h.$("webEchoToChannel"), false);
    expect(h.button("Review changes")!.disabled).toBe(true);
    expect(h.$("publicWebTtl").getAttribute("class")).toBe("invalid");
    await h.save(); await h.apply();
    expect(h.pending()).toBeNull();
    expect(h.writes()).toEqual([]);
  });

  it("the live Settings save callback keeps an absent toggle absent on unrelated edits", async () => {
    const h = await general();
    expect(h.$("webEchoToChannel").checked).toBe(true);
    const toolProgress = h.$("g-tp");
    await h.choose(toolProgress, "standard");
    await h.save(); await h.apply();
    expect(h.writes().some(s => s.path.endsWith("/web"))).toBe(false);
    expect(h.writes()).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/api/settings/fleet/defaults", body: { tool_progress: "standard" } })]));
  });

  it("changing a staged toggle back removes its pending write", async () => {
    const h = await general();
    await h.check(h.$("webEchoToChannel"), false);
    await h.save();
    expect(h.pending()).not.toBeNull();
    await h.check(h.$("webEchoToChannel"), true);
    await h.save();
    expect(h.pending()).toBeNull();
    expect(h.writes().some(s => s.path.endsWith("/web"))).toBe(false);
  });

  it.each([undefined, true, false])("the live checkbox stages only an actual toggle from %s", async initial => {
    const h = await general(initial === undefined ? undefined : { echo_to_channel: initial, usage_panel: false });
    expect(h.$("webEchoToChannel").checked).toBe(initial ?? true);
    await h.save(); await h.apply();
    expect(h.writes().some(s => s.path.endsWith("/web"))).toBe(false);
    await h.check(h.$("webEchoToChannel"), !(initial ?? true));
    await h.save(); await h.apply();
    expect(h.writes().filter(s => s.path.endsWith("/web"))).toEqual([{ method: "PUT", path: "/api/settings/fleet/web", body: { echo_to_channel: !(initial ?? true) } }]);
  });
});
