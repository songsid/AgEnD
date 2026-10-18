/**
 * #1620 part 2 (baseline: the maintainer's comment on the issue): Settings → Web writes the local session limits, the
 * browser terminal (enabled / ttl_minutes), web echo and the public link's menu through PUT /api/settings/fleet/web.
 * A change that LOOSENS access waits for the #1423 General-admin confirmation; one that TIGHTENS it applies at once;
 * over the temporary public link none of it can be changed. The real classifier and effect projection; the real
 * confirmation gate in front of the real handler, on a fleet.yaml on disk.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { FleetManager } from "../src/fleet-manager.js";

// The real FleetManager's loader and saver below: nothing may log to a file or start a process.
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

const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const WEB = "/api/settings/fleet/web";
/** What the gate would decide for this body against this fleet.yaml: null = applies directly. */
const judge = (body: unknown, fleet: Record<string, unknown> = {}) =>
  prepareSettingsEffect("PUT", WEB, body, { config: { defaults: {}, instances: {}, ...fleet } as any, classic: {} }).diff;

describe("the classifier judges these by direction", () => {
  it("tightening applies directly: a shorter session or idle time, the terminal off, a shorter terminal session", () => {
    expect(judge({ session: { local: { absolute_hours: 6 } } })).toBeNull();
    expect(judge({ session: { local: { idle_hours: 1 } } })).toBeNull();
    expect(judge({ session: { local: { absolute_hours: 6, idle_hours: 1 } } })).toBeNull();
    expect(judge({ web_terminal: { enabled: false } })).toBeNull();
    expect(judge({ web_terminal: { ttl_minutes: 5 } })).toBeNull();
    expect(judge({ session: { local: { absolute_hours: 24 } } }, { web: { session: { local: { absolute_hours: 48 } } } })).toBeNull();
    // The projection keeps what the body leaves out: a shorter terminal session never reads as "enabled → default".
    expect(judge({ web_terminal: { ttl_minutes: 5 } }, { web_terminal: { enabled: false, ttl_minutes: 15 } })).toBeNull();
    expect(judge({ session: { local: { absolute_hours: 6 } } }, { web: { session: { local: { idle_hours: 1 } } } })).toBeNull();
  });
  it("loosening waits for a General admin: each one is named, old → new, in the access section", () => {
    const cases: Array<[unknown, Record<string, unknown>, string]> = [
      // #1670: the default is 48 h / 48 h, so a longer limit is above it.
      [{ session: { local: { absolute_hours: 72 } } }, {}, "fleet.web.session.local.absolute\\_hours: default → 72"],
      [{ session: { local: { idle_hours: 60 } } }, { web: { session: { local: { absolute_hours: 72 } } } }, "fleet.web.session.local.idle\\_hours: default → 60"],
      [{ web_terminal: { enabled: true } }, { web_terminal: { enabled: false } }, "fleet.web\\_terminal.enabled: false → true"],
      [{ web_terminal: { ttl_minutes: 15 } }, {}, "fleet.web\\_terminal.ttl\\_minutes: default → 15"],
      [{ web_terminal: { ttl_minutes: 15 } }, { web_terminal: { ttl_minutes: 12 } }, "fleet.web\\_terminal.ttl\\_minutes: 12 → 15"],
    ];
    for (const [body, fleet, line] of cases) {
      const diff = judge(body, fleet);
      expect([diff?.section, diff?.summary.slice(1)], JSON.stringify(body)).toEqual(["access", [line]]);
    }
  });
  it("back to the default (null) is judged against the default: from below it loosens, from above it tightens", () => {
    expect(judge({ session: { local: { absolute_hours: null } } }, { web: { session: { local: { absolute_hours: 6 } } } })?.summary.slice(1))
      .toEqual(["fleet.web.session.local.absolute\\_hours: 6 → default"]);
    expect(judge({ session: { local: { absolute_hours: null } } }, { web: { session: { local: { absolute_hours: 72, idle_hours: 2 } } } })).toBeNull();
    // …and a value below the 48 h default goes back up to it: that lengthens (#1670).
    expect(judge({ session: { local: { absolute_hours: null } } }, { web: { session: { local: { absolute_hours: 24 } } } })?.summary.slice(1))
      .toEqual(["fleet.web.session.local.absolute\\_hours: 24 → default"]);
    expect(judge({ web_terminal: { enabled: null } }, { web_terminal: { enabled: false } })?.summary.slice(1)).toEqual(["fleet.web\\_terminal.enabled: false → default"]);
    expect(judge({ web_terminal: { ttl_minutes: null } }, { web_terminal: { ttl_minutes: 20 } })).toBeNull();
  });
  it("judged as the policy the store enforces, not the stored numbers: a stored value it falls back from (#1627 review)", () => {
    // absolute 1000 is enforced as the 48 h default: 72 lengthens sessions.
    expect(judge({ session: { local: { absolute_hours: 72 } } }, { web: { session: { local: { absolute_hours: 1000 } } } })?.summary.slice(1))
      .toEqual(["fleet.web.session.local.absolute\\_hours: 1000 → 72"]);
    // idle 1000 is enforced as the 48 h default: 60 lengthens the idle window (in a 96 h session).
    expect(judge({ session: { local: { idle_hours: 60 } } }, { web: { session: { local: { absolute_hours: 96, idle_hours: 1000 } } } })?.summary.slice(1))
      .toEqual(["fleet.web.session.local.idle\\_hours: 1000 → 60"]);
    // An idle window cut by the absolute limit is lifted by a longer absolute limit: confirmed, naming what changed.
    expect(judge({ session: { local: { absolute_hours: 4 } } }, { web: { session: { local: { absolute_hours: 1, idle_hours: 3 } } } })?.summary.slice(1))
      .toEqual(["fleet.web.session.local.absolute\\_hours: 1 → 4"]);
    // Controls: an effective 6 → 24 is still confirmed, 48 → 24 still applies; 1000 → 6 (effective 48 → 6) applies.
    expect(judge({ session: { local: { absolute_hours: 24 } } }, { web: { session: { local: { absolute_hours: 6 } } } })).not.toBeNull();
    expect(judge({ session: { local: { absolute_hours: 24 } } }, { web: { session: { local: { absolute_hours: 48 } } } })).toBeNull();
    expect(judge({ session: { local: { absolute_hours: 6 } } }, { web: { session: { local: { absolute_hours: 1000 } } } })).toBeNull();
  });
  it("one loosening in a batch of tightenings is confirmed — and only it is named", () => {
    const diff = judge({ session: { local: { absolute_hours: 3, idle_hours: 2 } }, web_terminal: { enabled: false } },
      { web: { session: { local: { absolute_hours: 6, idle_hours: 1 } } } });
    expect(diff?.summary.slice(1)).toEqual(["fleet.web.session.local.idle\\_hours: 1 → 2"]);
  });
  it("the classifier itself: a value of the wrong kind is never judged a tightening (whatever reaches it)", () => {
    const diff = settingsChangeDiff({ fleet: { web_terminal: { enabled: true } } }, { fleet: { web_terminal: { enabled: "false" } } }, { operation: "PUT x" });
    expect(diff?.section).toBe("access");
    expect(settingsChangeDiff({ fleet: { web: { session: { local: { idle_hours: 2 } } } } }, { fleet: { web: { session: { local: { idle_hours: "1" } } } } }, { operation: "PUT x" })).not.toBeNull();
  });
  it("what the handler or the validator would refuse is refused here, before anything is proposed", () => {
    expect(() => judge({ session: { local: { idle_hours: 60 } } })).toThrow("invalid_settings_effect");   // #1670: > the 48 h default
    for (const body of [{ web_terminal: { ttl_minutes: 21 } }, { web_terminal: { ttl_minutes: 0 } }, { web_terminal: { enabled: "false" } },
      { web_terminal: { bind: "0.0.0.0" } }, { session: { local: { absolute_hours: "48" } } }, { session: { gateway: {} } },
      { allowed_hosts: ["other.invalid"] }, { view_access: "open" }, { echo_to_channel: "false" }, { public_link: { ttl_minutes: 481 } }])
      expect(() => judge(body), JSON.stringify(body)).toThrow("invalid_web_settings");
  });
  it("web echo stays immediate and the public link's menu stays confirmed, as before", () => {
    expect(judge({ echo_to_channel: false })).toBeNull();
    expect(judge({ public_link: { allow_public: false } })).not.toBeNull();
  });
  it("the schema says all four apply now (read at every check / by /login when it starts)", () => {
    const impacts = buildSettingsImpactSchema().impacts;
    expect(["web.session.local.absolute_hours", "web.session.local.idle_hours", "web_terminal.enabled", "web_terminal.ttl_minutes"].map(k => impacts[k]))
      .toEqual(["now", "now", "now", "now"]);
  });
});

function harness(fleet: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-test-1620-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  const config: any = { defaults: {}, instances: {}, ...structuredClone(fleet) };
  writeFileSync(path, yaml.dump(config));
  let revision = 0;
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), config); writeFileSync(path, yaml.dump(config)); revision++; });
  const ctx = { fleetConfig: config, dataDir: root, configPath: path, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => config, saveFleetConfig: save, lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() } } as unknown as SettingsApiContext;
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => revision });
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => req.headers.cookie ? { id: "session-a", label: "browser", source: "web_session", current: () => true } : null,
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  const dispatched = vi.fn();
  /** Through the gate (as the server mounts it) unless `direct`; `publicLink` binds the request to the public link's listener. */
  async function request(body: unknown, opts: { publicLink?: boolean; direct?: boolean; key?: string } = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = new EventEmitter() as any;
      req.method = "PUT"; req.url = WEB; req.headers = { "idempotency-key": opts.key ?? "k-1", cookie: "opaque" }; req.destroy = () => undefined;
      if (opts.publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.example", isCurrent: () => true });
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => { dispatched(); return handleSettingsRequest(r, s, u, ctx); };
      const url = new URL(WEB, "http://localhost");
      try { expect(opts.direct ? next(req, res, url) : gate.handle(req, res, url, next)).toBe(true);
        queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }); }
      catch (err) { reject(err); }
    });
  }
  const raw = () => yaml.load(readFileSync(path, "utf8")) as any;
  return { config, save, store, request, raw, dispatched };
}
const admin = () => ({ label: "F", current: () => true });

describe("through the gate and the real handler", () => {
  it("tightening is written at once — fleet.yaml and the live config", async () => {
    const h = harness();
    const r = await h.request({ session: { local: { absolute_hours: 6, idle_hours: 1 } }, web_terminal: { enabled: false, ttl_minutes: 5 } });
    expect(r.status).toBe(200);
    expect([h.raw().web.session, h.raw().web_terminal]).toEqual([{ local: { absolute_hours: 6, idle_hours: 1 } }, { enabled: false, ttl_minutes: 5 }]);
    expect([h.config.web.session.local.idle_hours, h.config.web_terminal.enabled]).toEqual([1, false]);
  });
  it("loosening is proposed, written only when a General admin confirms it", async () => {
    const h = harness({ web_terminal: { enabled: false } });
    const r = await h.request({ session: { local: { absolute_hours: 72, idle_hours: 8 } }, web_terminal: { enabled: true } });
    expect([r.status, r.body.result]).toEqual([202, "pending_confirmation"]);
    expect(h.save).not.toHaveBeenCalled();
    expect([h.raw().web, h.raw().web_terminal]).toEqual([undefined, { enabled: false }]);
    const outcome = await h.store.decide(r.body.pending_change.id, "confirm", admin());
    expect(outcome.state).toBe("applied");
    expect([h.raw().web.session.local, h.raw().web_terminal]).toEqual([{ absolute_hours: 72, idle_hours: 8 }, { enabled: true }]);
  });
  it("null puts a value back to its default: the key leaves fleet.yaml, the others stay", async () => {
    // #1670: from above the 48 h default, so going back to it is a tightening (written at once).
    const h = harness({ web: { usage_panel: false, session: { local: { absolute_hours: 72, idle_hours: 6 } } }, web_terminal: { enabled: false, ttl_minutes: 15, bind: "127.0.0.1" } });
    expect((await h.request({ session: { local: { absolute_hours: null } }, web_terminal: { ttl_minutes: null } })).status).toBe(200);
    expect(h.raw().web).toEqual({ usage_panel: false, session: { local: { idle_hours: 6 } } });
    expect(h.raw().web_terminal).toEqual({ enabled: false, bind: "127.0.0.1" });
  });
  it.each([
    [{ session: { local: { absolute_hours: "24" } } }], [{ session: { gateway: { idle_hours: 1 } } }], [{ session: { local: { absolute: 24 } } }],
    [{ web_terminal: { enabled: "no" } }], [{ web_terminal: { ttl_minutes: 1.5 } }], [{ web_terminal: { ttl_minutes: 21 } }], [{ web_terminal: { ttl_minutes: 0 } }], [{ web_terminal: { bind: "0.0.0.0" } }], [{ web_terminal: { tunnel: {} } }],
    [{ session: [] }], [{ web_terminal: null }], [{ allowed_hosts: ["evil"] }],
  ])("the handler refuses a malformed or read-only field without writing (%j)", async body => {
    const h = harness({ web_terminal: { enabled: false } }), before = readFileSync(join(roots.at(-1)!, "fleet.yaml"), "utf8");
    expect((await h.request(body, { direct: true })).status).toBe(400);
    expect(readFileSync(join(roots.at(-1)!, "fleet.yaml"), "utf8")).toBe(before);
    expect(h.save).not.toHaveBeenCalled();
  });
  it("the handler applies the validator to the whole result: idle above absolute is refused", async () => {
    const h = harness({ web: { session: { local: { absolute_hours: 4 } } } });
    expect((await h.request({ session: { local: { idle_hours: 6 } } }, { direct: true })).status).toBe(400);
    expect((await h.request({ session: { local: { idle_hours: 4 } } }, { direct: true, key: "k-2" })).status).toBe(200);
    expect(h.raw().web.session.local).toEqual({ absolute_hours: 4, idle_hours: 4 });
  });
});

describe("#2122: the usage report over the public link — one switch in Settings → Web", () => {
  it("a boolean; applies at once either way (the default, off, is the gate; nothing to confirm)", () => {
    expect(judge({ usage_report_on_public_link: true })).toBeNull();
    expect(judge({ usage_report_on_public_link: false }, { web: { usage_report_on_public_link: true } })).toBeNull();
    expect(() => prepareSettingsEffect("PUT", WEB, { usage_report_on_public_link: "yes" }, { config: { defaults: {}, instances: {} } as any, classic: {} })).toThrow("invalid_web_settings");
  });
  it("through the gate and the real handler: written at once, fleet.yaml and the live config; off again the same way", async () => {
    const h = harness();
    const on = await h.request({ usage_report_on_public_link: true });
    expect(on.status).toBe(200);
    expect([h.raw().web.usage_report_on_public_link, h.config.web.usage_report_on_public_link]).toEqual([true, true]);
    const off = await h.request({ usage_report_on_public_link: false });
    expect(off.status).toBe(200);
    expect(h.config.web.usage_report_on_public_link).toBe(false);
  });
  it("never over the public link itself", async () => {
    const h = harness();
    const r = await h.request({ usage_report_on_public_link: true }, { publicLink: true });
    expect([r.status, r.body.error, h.save.mock.calls.length]).toEqual([403, "web_settings_not_over_public_link", 0]);
  });
});

describe("never over the temporary public link", () => {
  it.each([
    ["a tightening", { session: { local: { absolute_hours: 6 } } }],
    ["a loosening", { web_terminal: { ttl_minutes: 20 } }],
    ["web echo", { echo_to_channel: false }],
    ["the public link's own menu", { public_link: { allow_public: false } }],
  ])("%s: refused by the gate — nothing proposed, nothing dispatched, nothing written", async (_what, body) => {
    const h = harness();
    const r = await h.request(body, { publicLink: true });
    expect([r.status, r.body.error]).toEqual([403, "web_settings_not_over_public_link"]);
    expect([h.store.list("session-a"), h.dispatched.mock.calls.length, h.save.mock.calls.length]).toEqual([[], 0, 0]);
  });
  it("and by the handler itself, for anything that reaches it without the gate", async () => {
    const h = harness();
    const r = await h.request({ session: { local: { absolute_hours: 6 } } }, { publicLink: true, direct: true });
    expect([r.status, r.body.error, h.save.mock.calls.length]).toEqual([403, "web_settings_not_over_public_link", 0]);
    expect(h.raw().web).toBeUndefined();
  });
  it("the same requests from the dashboard's own address go through (control)", async () => {
    const h = harness();
    expect((await h.request({ session: { local: { absolute_hours: 6 } } })).status).toBe(200);
    expect((await h.request({ session: { local: { absolute_hours: 5 } } }, { direct: true, key: "k-2" })).status).toBe(200);
  });
});

/**
 * #1627 review: the real FleetManager — fleet.yaml read by its loader (a hand-written file the validator would refuse
 * included) and written by its saver, whose fsync seam can fail the atomic write before the rename — behind the real
 * gate and the real handler.
 */
function realFleet(yamlText: string) {
  const root = mkdtempSync(join(tmpdir(), "agend-test-1620-fm-")); roots.push(root); vi.stubEnv("AGEND_HOME", root);
  const path = join(root, "fleet.yaml");
  writeFileSync(path, yamlText);
  const fm = new FleetManager(root) as any;
  fm.loadConfig(path);
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => fm.configPath, config: () => fm.fleetConfig, current: () => 0 });
  const gate = new SettingsHttpConfirmation(store, {
    principal: () => ({ id: "session-a", label: "browser", source: "web_session", current: () => true }),
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  let key = 0;
  const request = (body: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = new EventEmitter() as any;
    req.method = "PUT"; req.url = WEB; req.headers = { "idempotency-key": `fm-${++key}`, cookie: "opaque" }; req.destroy = () => undefined;
    let status = 0;
    const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
      end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
    const url = new URL(WEB, "http://localhost");
    try { expect(gate.handle(req, res, url, (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, fm))).toBe(true);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }); }
    catch (err) { reject(err); }
  });
  const file = () => readFileSync(path, "utf8");
  const live = () => structuredClone({ web: fm.fleetConfig.web, web_terminal: fm.fleetConfig.web_terminal, hasWeb: "web" in fm.fleetConfig });
  const failSaves = () => { fm.fsyncForTest = () => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); }; };
  return { fm, store, request, file, live, failSaves };
}

describe("the real loader and saver (#1627 review)", () => {
  it("a hand-written limit the store falls back from: 'tightening' it is a real lengthening — proposed, not written", async () => {
    // 1000 is enforced as the 48 h default (#1670), so 1000 → 72 reads as shorter but is longer.
    const a = realFleet("instances: {}\nweb:\n  session:\n    local:\n      absolute_hours: 1000\n");
    const before = a.file();
    const r = await a.request({ session: { local: { absolute_hours: 72 } } });
    expect([r.status, r.body.result, a.file()]).toEqual([202, "pending_confirmation", before]);
    const b = realFleet("instances: {}\nweb:\n  session:\n    local:\n      absolute_hours: 96\n      idle_hours: 1000\n");
    const before2 = b.file();
    const r2 = await b.request({ session: { local: { idle_hours: 60 } } });
    expect([r2.status, r2.body.result, b.file()]).toEqual([202, "pending_confirmation", before2]);
  });
  it("controls: an effective 6 → 24 is proposed; 48 → 24 is written at once", async () => {
    const a = realFleet("instances: {}\nweb:\n  session:\n    local:\n      absolute_hours: 6\n");
    expect((await a.request({ session: { local: { absolute_hours: 24 } } })).status).toBe(202);
    const b = realFleet("instances: {}\nweb:\n  session:\n    local:\n      absolute_hours: 48\n");
    expect((await b.request({ session: { local: { absolute_hours: 24 } } })).status).toBe(200);
    expect((yaml.load(b.file()) as any).web.session.local).toEqual({ absolute_hours: 24 });
    expect(b.fm.fleetConfig.web.session.local.absolute_hours).toBe(24);
  });
  it("a save that fails (fsync before the rename): 500, fleet.yaml byte for byte unchanged, and the live config what the file says", async () => {
    const h = realFleet("instances: {}\nweb:\n  session:\n    local:\n      absolute_hours: 24\n      idle_hours: 4\nweb_terminal:\n  enabled: true\n  ttl_minutes: 15\n");
    const before = h.file(), live = h.live();
    h.failSaves();
    const r = await h.request({ session: { local: { absolute_hours: 6, idle_hours: 1 } }, web_terminal: { enabled: false, ttl_minutes: 5 } });
    expect(r.status).toBe(500);
    expect(h.file()).toBe(before);
    expect(h.live()).toEqual(live);
  });
  it("…also when there was no web: section at all — the live config gets none", async () => {
    const h = realFleet("instances: {}\n");
    const live = h.live(), hadTerminal = "web_terminal" in h.fm.fleetConfig;
    h.failSaves();
    expect((await h.request({ session: { local: { absolute_hours: 6 } }, web_terminal: { enabled: false } })).status).toBe(500);
    expect([h.live(), "web_terminal" in h.fm.fleetConfig]).toEqual([live, hadTerminal]);
    expect([h.fm.fleetConfig.web?.session, h.fm.fleetConfig.web_terminal]).toEqual([undefined, undefined]);
  });
  it("a confirmed loosening whose save fails: the receipt says failed, the file and the live config keep the terminal off", async () => {
    const h = realFleet("instances: {}\nweb_terminal:\n  enabled: false\n");
    const r = await h.request({ web_terminal: { enabled: true } });
    expect(r.status).toBe(202);
    h.failSaves();
    const outcome = await h.store.decide(r.body.pending_change.id, "confirm", admin());
    expect(outcome.state).toBe("failed");
    expect([(yaml.load(h.file()) as any).web_terminal, h.fm.fleetConfig.web_terminal]).toEqual([{ enabled: false }, { enabled: false }]);
  });
  it("control: the same confirmed loosening with a working save is written and live", async () => {
    const h = realFleet("instances: {}\nweb_terminal:\n  enabled: false\n");
    const r = await h.request({ web_terminal: { enabled: true } });
    const outcome = await h.store.decide(r.body.pending_change.id, "confirm", admin());
    expect(outcome.state).toBe("applied");
    expect([(yaml.load(h.file()) as any).web_terminal, h.fm.fleetConfig.web_terminal]).toEqual([{ enabled: true }, { enabled: true }]);
  });
});
