import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
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

class El {
  kids: any[] = []; value = ""; checked = false; disabled = false; innerHTML = ""; textContent = ""; type = ""; id = ""; selected = false; onclick?: () => void;
  constructor(public tag: string) {}
  append(...kids: any[]) { this.kids.push(...kids); if (this.tag === "select") for (const k of kids) if (k.selected || !this.value) this.value = k.value; }
  addEventListener() {}
}
/** Execute the shipped render/save callback, not a reconstruction of its diff logic. */
function panel(web?: Record<string, unknown>) {
  const html = readFileSync(join(process.cwd(), "src/ui/settings.html"), "utf8");
  const state: any = { fleet: { defaults: { locale: "en" }, ...(web ? { web } : {}) }, classic: { defaults: {} }, pending: new Map() };
  const made: El[] = [], host = new El("div"), calls: Array<{ path: string; body: any }> = [];
  const el = (tag: string, attrs: any = {}, ...kids: any[]) => { const e = Object.assign(new El(tag), attrs); e.append(...kids); made.push(e); return e; };
  const slice = (start: string, end: string) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
  const sandbox: any = {
    state, structuredClone, $: () => host, el, channels: () => [], BACKENDS: ["claude-code", "codex"],
    // main's page helpers next to select() (#1294 backendSelect, #1310 localeSelect, #1302 visibility), stubbed alike.
    select: (value: string) => el("select", { value }), backendSelect: (value: string) => el("select", { value }),
    localeSelect: (value: string) => el("select", { value }),
    VISIBILITY_MODES: ["full", "summary", "hidden"], visibilityDefault: (d: any) => d?.cross_instance_visibility ?? "full",
    t: (key: string) => key, tf: (key: string) => key,
    impact: () => el("span"), impactOf: () => "now", batchImpact: () => "now", esc: (v: string) => v,
    chipList: () => el("div"), drawer: (_t: string, ...kids: any[]) => el("div", {}, ...kids), setValidation: () => true,
    updatePendingBar: () => {},
    stageChange: (key: string, change: any) => state.pending.set(key, change),
    api: async (path: string, opts: any) => { calls.push({ path, body: JSON.parse(opts.body) }); },
  };
  vm.runInNewContext(slice('  const hasOwn =', '  function setValidation(') + '\n' + slice('  function renderGeneral()', '  // ── What\'s New') + '\nrenderGeneral();', sandbox);
  const save = made.find(e => e.tag === "button" && e.onclick)!;
  return { state, calls, made, toggle: made.find(e => e.id === "webEchoToChannel")!, publicToggle: made.find(e => e.id === "publicWebLink")!, publicTtl: made.find(e => e.id === "publicWebTtl")!, save: () => save.onclick!(), apply: async () => { for (const change of state.pending.values()) await change.apply(); } };
}

describe("web echo config and Settings (#1320 A)", () => {
  it("public-link controls display defaults without writing, then send only edited leaves (#1367)", async () => {
    const h = panel(); expect(h.publicToggle.checked).toBe(true); expect(Number(h.publicTtl.value)).toBe(120);
    h.save(); await h.apply(); expect(h.calls.some(c => c.path.endsWith("/web"))).toBe(false);
    h.publicToggle.checked = false; h.publicTtl.value = "30"; h.save(); await h.apply();
    expect(h.calls.filter(c => c.path.endsWith("/web"))).toEqual([{ path: "/api/settings/fleet/web", body: { public_link: { allow_public: false, ttl_minutes: 30 } } }]);
  });
  it("public-link Settings rejects invalid TTL before staging any unrelated edits (#1367)", async () => {
    const h = panel(); h.publicTtl.value = "481"; const progress = h.made.find(e => e.tag === "select" && e.value === "off")!; progress.value = "standard";
    h.save(); await h.apply(); expect(h.calls).toEqual([]); expect(h.state.pending.size).toBe(0);
  });
  it("public-link sparse settings preserve unknown/unrelated web fields and reject invalid patches (#1367)", async () => {
    const h = context({ usage_panel: false, public_link: { protocol: "quic" } });
    expect((await request(h.fm, "/api/settings/fleet/web", { public_link: { allow_public: false } })).status).toBe(200);
    expect(h.raw().web).toEqual({ usage_panel: false, public_link: { protocol: "quic", allow_public: false } });
    expect((await request(h.fm, "/api/settings/fleet/web", { public_link: { ttl_minutes: 481 } })).status).toBe(400);
    expect(h.raw().web.public_link.ttl_minutes).toBeUndefined();
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
  it("the live Settings save callback keeps an absent toggle absent on unrelated edits", async () => {
    const h = panel(); expect(h.toggle.checked).toBe(true);
    const toolProgress = h.made.find(e => e.tag === "select" && e.value === "off")!; toolProgress.value = "standard";
    h.save(); await h.apply();
    expect(h.calls.some(c => c.path.endsWith("/web"))).toBe(false); expect(h.state.fleet.web).toBeUndefined();
    expect(h.calls).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/api/settings/fleet/defaults", body: { tool_progress: "standard" } })]));
  });
  it("changing a staged toggle back removes its pending write", async () => {
    const h = panel(); h.toggle.checked = false; h.save(); expect(h.state.pending.has("web:echo")).toBe(true);
    h.toggle.checked = true; h.save(); await h.apply();
    expect(h.calls.some(c => c.path.endsWith("/web"))).toBe(false); expect(h.state.fleet.web).toBeUndefined();
  });
  it.each([undefined, true, false])("the live checkbox stages only an actual toggle from %s", async initial => {
    const h = panel(initial === undefined ? undefined : { echo_to_channel: initial, usage_panel: false });
    expect(h.toggle.checked).toBe(initial ?? true); h.save(); await h.apply(); expect(h.calls.some(c => c.path.endsWith("/web"))).toBe(false);
    h.toggle.checked = !h.toggle.checked; h.save(); await h.apply();
    expect(h.calls.filter(c => c.path.endsWith("/web"))).toEqual([{ path: "/api/settings/fleet/web", body: { echo_to_channel: !(initial ?? true) } }]);
  });
});
