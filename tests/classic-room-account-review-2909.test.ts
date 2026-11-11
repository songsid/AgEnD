/**
 * M-2909, Prism's review of #3691:
 * - P2-3: an account change saved from Settings restarts the room through restartClassicSettingsOwned; between the stop
 *   and the start it does the same handoff as a classicBot.yaml edit (#1753): Claude's conversation is carried, Kiro starts
 *   fresh (its marker), Codex resumes; an unchanged account does neither.
 * - P2-2: the signed-out guard compares the room's binding before (its current backend and options) with after (the merged
 *   ones), whenever the backend or the options change — moving the room onto another CLI whose saved or inherited
 *   profile is signed out is refused, and the YAML stays as it was.
 * Nothing here starts a CLI or a fleet: scratch AGEND_HOME; stop/start and the carry itself are replaced.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { mergeBackendOptions } from "../src/classic-bindings.js";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";

let dir: string;
const previousHome = process.env.AGEND_HOME;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-2909r-")); process.env.AGEND_HOME = dir; });
afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});
const KEY = "875544568890785823#discord", NAME = "classic-room-bot";
function writeClassic(channel: Record<string, unknown>, defaults: Record<string, unknown> = {}): string {
  const path = join(dir, "classicBot.yaml");
  writeFileSync(path, yaml.dump({ defaults, channels: { [KEY]: { channelId: "875544568890785823", adapterId: "discord", instanceName: NAME, name: "room", ...channel } } }));
  return path;
}
const log = () => { const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => l } as any; return l; };

describe("P2-3: the Settings restart hands the conversation over like a file edit", () => {
  async function settingsRestart(from: Record<string, unknown>, to: Record<string, unknown>, fields: string[]) {
    writeClassic(from);
    const fm = new FleetManager(dir);
    fm.fleetConfig = { defaults: {}, instances: {} } as any;
    const classic = new ClassicChannelManager(dir, log()); classic.configureAdapters([{ id: "discord", type: "discord" }]);
    fm.classicChannels = classic; classic.reloadFromDisk();
    const launched = { backend: from.backend as string, backend_options: mergeBackendOptions(undefined, from.backend_options as any), working_directory: join(dir, "workspaces", NAME) };
    fm.lifecycle.daemons.set(NAME, { applyConfigUpdate: vi.fn(), getConfigSnapshot: () => launched } as any);
    mkdirSync(fm.getInstanceDir(NAME), { recursive: true });
    vi.spyOn(fm as any, "stopInstance").mockImplementation(async () => { fm.lifecycle.daemons.delete(NAME); return { backgroundWorkEnded: false }; });
    const start = vi.spyOn(fm as any, "startClassicInstance").mockResolvedValue(true);
    // As in #1220's file-edit tests: Claude's copy itself is claude-carry-1753's (stubbed); Kiro's switch runs for real.
    const carry = vi.spyOn(fm as any, "switchConversation");
    if ((to.backend ?? from.backend) === "claude-code") carry.mockResolvedValue({ carried: true, sessionId: "s", bytes: 1, ms: 1, replacedOlderCopy: false });
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0 as any; }) as any);
    writeClassic(to);                                                   // what the Settings PATCH just wrote
    await fm.restartClassicInstanceFromSettings(NAME, fields);
    const fresh = existsSync(join(fm.getInstanceDir(NAME), "crash-state.json"));
    return { start, carry, fresh };
  }
  it("claude-code: the conversation is carried between the stop and the start — no fresh marker", async () => {
    const { start, carry, fresh } = await settingsRestart({ backend: "claude-code" }, { backend: "claude-code", backend_options: { "claude-code": { credential_profile: "second" } } }, ["backend_options"]);
    expect([carry.mock.calls.map(c => c[1]), fresh]).toEqual([[{ backend: "claude-code", from: null, to: "second", workingDirectory: join(dir, "workspaces", NAME) }], false]);
    expect(carry.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!);
  });
  it("kiro: restarted fresh (its marker) — the other subscription holds other conversations", async () => {
    const { carry, fresh } = await settingsRestart({ backend: "kiro-cli" }, { backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "second" } } }, ["backend_options"]);
    expect([carry.mock.calls.length, fresh]).toEqual([1, true]);
  });
  it("controls: an unchanged account (a model edit) neither carries nor starts fresh", async () => {
    const { start, carry, fresh } = await settingsRestart({ backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: "second" } } },
      { backend: "kiro-cli", model: "x", backend_options: { "kiro-cli": { credential_profile: "second" } } }, ["model"]);
    expect([start.mock.calls.length, carry.mock.calls.length, fresh]).toEqual([1, 0, false]);
  });
});

function request(path: string, ctx: SettingsApiContext, method: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method; req.destroy = () => undefined;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, setHeader() {}, end(payload: string) { resolve({ status, body: JSON.parse(payload) as Record<string, unknown> }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), ctx)).toBe(true);
      if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (err) { reject(err); }
  });
}
describe("P2-2: the signed-out guard compares the old and new effective bindings", () => {
  function ctxWith(defaults: Record<string, unknown> = {}) {
    mkdirSync(join(dir, "credential-profiles", "claude-code", "ghost"), { recursive: true });     // made, never signed in
    const restart = vi.fn(async () => undefined);
    const ctx = { fleetConfig: { defaults, instances: {} }, configPath: join(dir, "fleet.yaml"), dataDir: dir, logger: log(),
      getRawFleetConfig: () => ({}), saveFleetConfig: vi.fn(), lifecycle: { isPaused: vi.fn(() => false), pause: vi.fn(), wake: vi.fn() },
      isClassicInstance: vi.fn(() => true), restartClassicInstanceFromSettings: restart } as unknown as SettingsApiContext;
    return { ctx, restart };
  }
  const key = encodeURIComponent(KEY);
  it("a Codex room moved to Claude with its saved (dormant) Claude profile signed out: 409, the file and runtime untouched", async () => {
    const path = writeClassic({ backend: "codex", backend_options: { "claude-code": { credential_profile: "ghost" } } });
    const before = readFileSync(path, "utf8");
    const { ctx, restart } = ctxWith();
    const r = await request(`/api/settings/classic/channels/${key}`, ctx, "PATCH", { backend: "claude-code", backend_options: { "claude-code": { credential_profile: "ghost" } } });
    expect([r.status, r.body.error, r.body.profile]).toEqual([409, "credential_profile_signed_out", "ghost"]);
    expect([readFileSync(path, "utf8"), restart.mock.calls.length]).toEqual([before, 0]);
    const backendOnly = await request(`/api/settings/classic/channels/${key}`, ctx, "PATCH", { backend: "claude-code" });
    expect(backendOnly.status).toBe(409);
  });
  it("inherited: a Codex room moved to Claude, clearing its own options, onto a signed-out fleet default: 409", async () => {
    const path = writeClassic({ backend: "codex", backend_options: { codex: { credential_profile: "x" } } });
    const before = readFileSync(path, "utf8");
    const { ctx } = ctxWith({ backend_options: { "claude-code": { credential_profile: "ghost" } } });
    const r = await request(`/api/settings/classic/channels/${key}`, ctx, "PATCH", { backend: "claude-code", backend_options: null });
    expect([r.status, r.body.profile]).toEqual([409, "ghost"]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  it("control: a room already on that binding is not refused for an unrelated edit", async () => {
    writeClassic({ backend: "claude-code", backend_options: { "claude-code": { credential_profile: "ghost" } } });
    const { ctx } = ctxWith();
    expect((await request(`/api/settings/classic/channels/${key}`, ctx, "PATCH", { collab: true })).status).toBe(200);
  });
});
