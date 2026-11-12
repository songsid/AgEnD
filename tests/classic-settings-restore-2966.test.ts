/**
 * M-2966 (follow-up to #3719, Prism's P2 there): a ClassicBot room saved from Settings whose restart fails is rolled back
 * AND brought back up on what it had — not left stopped. The PATCH /api/settings/classic/channels/:key route runs on a
 * real FleetManager: its owned restart (beginClassicSettingsRestart), restartClassicInstanceFromSettings,
 * startClassicInstance and startInstance are the product's; only the boundaries are replaced — the stop (it invalidates
 * the room's epoch at once and takes the daemon away, as the real one does) and the CLI launch inside lifecycle.start
 * (it publishes a daemon whose snapshot is the config it was given, through the same `published` callback).
 *  1. a plain Save (no confirmed continuation) whose first start fails: the room is started again on its old account;
 *  2. a Stop while the handoff is held: nothing is launched, and the rollback doesn't start the room either;
 *  3. a newer runtime published after the failed start: never stopped or replaced;
 *  control: a Save whose start succeeds still restarts once on the new account.
 * Scratch AGEND_HOME, fake tokens; nothing starts a CLI or a fleet.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";

const dirs: string[] = [];
const previousHome = process.env.AGEND_HOME;
afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = previousHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const KEY = "123#discord", NAME = "classic-alpha-0001";
const ROOM = { instanceName: NAME, channelId: "123", adapterId: "discord", name: "room" };

function request(fm: unknown, method: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method; req.destroy = () => undefined;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, setHeader() {}, end(payload: string) { resolve({ status, body: JSON.parse(payload) as Record<string, unknown> }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost/api/settings/classic/channels/${encodeURIComponent(KEY)}`), fm as SettingsApiContext)).toBe(true);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (err) { reject(err); }
  });
}

async function realFleet(opts: { starts?: Array<"ok" | "fail" | ((fm: any) => void)>; holdHandoff?: Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2966-")); dirs.push(dir); process.env.AGEND_HOME = dir;
  for (const name of ["team", "work"]) {
    const home = join(dir, "credential-profiles", "claude-code", name); mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c".repeat(40), refreshToken: "d".repeat(40), expiresAt: Date.now() + 3_600_000 } }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: `u-${name}` } }));
  }
  const path = join(dir, "classicBot.yaml");
  writeFileSync(path, yaml.dump({ defaults: { backend: "claude-code" }, channels: { [KEY]: ROOM } }));
  writeFileSync(join(dir, "fleet.yaml"), "instances: {}\n");
  const fm = new FleetManager(dir) as any;
  fm.loadConfig(join(dir, "fleet.yaml"));
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as never;
  const classic = new ClassicChannelManager(dir, log); classic.configureAdapters([{ id: "discord", type: "discord" }]);
  fm.classicChannels = classic; classic.reloadFromDisk();
  const daemon = (config: Record<string, unknown>) => ({ applyConfigUpdate: vi.fn(), getConfigSnapshot: () => config, getProcessStatus: () => "running" as const });
  fm.lifecycle.daemons.set(NAME, daemon({ backend: "claude-code", working_directory: join(dir, "workspaces", NAME) }));
  const stop = vi.spyOn(fm, "stopInstance").mockImplementation((...args: unknown[]) => {
    const n = args[0] as string; fm.lifecycle.invalidate(n);
    return (async () => { await Promise.resolve(); fm.lifecycle.daemons.delete(n); return { backgroundWorkEnded: false }; })();
  });
  vi.spyOn(fm, "switchConversation").mockImplementation(async () => { await opts.holdHandoff; return { carried: true, sessionId: "s", bytes: 1, ms: 1, replacedOlderCopy: false }; });
  const plan = [...(opts.starts ?? ["ok"])];
  const started: Record<string, unknown>[] = [];
  vi.spyOn(fm.lifecycle, "start").mockImplementation(async (...args: unknown[]) => {
    const [n, config, , , , , published] = args as [string, Record<string, unknown>, unknown, unknown, unknown, unknown, ((d: object) => void) | undefined];
    const step = plan.shift() ?? "ok";
    started.push(config);
    if (typeof step === "function") { step(fm); throw new Error("first start refused"); }
    if (step === "fail") throw new Error("first start refused");
    const d = daemon(config); fm.lifecycle.daemons.set(n, d); published?.(d);
  });
  // Only the restart's 250 ms settle is skipped; every other timer (an operation's own deadline among them) is real.
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
    ms === 250 ? (fn(), 0 as any) : realTimeout(fn, ms, ...rest)) as any);
  const profileOf = (config: Record<string, unknown> | undefined) => (config?.backend_options as any)?.["claude-code"]?.credential_profile ?? null;
  const saved = () => (yaml.load(readFileSync(path, "utf8")) as any).channels[KEY].backend_options;
  return { fm, path, dir, stop, started, profileOf, saved };
}
const TEAM = { backend_options: { "claude-code": { credential_profile: "team" } } };

describe("M-2966: a Settings room save whose restart fails brings the room back", () => {
  it("control: a save whose start succeeds restarts the room once, on the new account", async () => {
    const f = await realFleet();
    const r = await request(f.fm, "PATCH", TEAM);
    expect(r.status).toBe(200);
    expect(f.started.map(f.profileOf)).toEqual(["team"]);
    expect(f.saved()).toEqual({ "claude-code": { credential_profile: "team" } });
  });
  it("1. a plain Save whose first start fails: rolled back, and the room is started again on its old account", async () => {
    const f = await realFleet({ starts: ["fail", "ok"] });
    const r = await request(f.fm, "PATCH", TEAM);
    expect([r.status, r.body.error]).toEqual([409, "classic instance restart failed: first start refused"]);
    expect(f.saved()).toBeUndefined();
    expect(f.started.map(f.profileOf)).toEqual(["team", null]);
    expect(f.fm.lifecycle.daemons.has(NAME)).toBe(true);
  });
  it("2. a Stop while the handoff is held: nothing launches, and the rollback doesn't start the room", async () => {
    let release!: () => void;
    const f = await realFleet({ holdHandoff: new Promise<void>(r => { release = r; }) });
    const pending = request(f.fm, "PATCH", TEAM);
    await vi.waitFor(() => expect(f.fm.switchConversation).toHaveBeenCalled());
    f.fm.lifecycle.invalidate(NAME);                                         // what a Stop does at once
    release();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(f.started).toEqual([]);
    expect(f.fm.lifecycle.daemons.has(NAME)).toBe(false);
    expect(f.saved()).toBeUndefined();
  });
  it("3. a newer runtime published after the failed start is left alone: no second stop, no replacement", async () => {
    const newer = { getConfigSnapshot: () => ({ backend: "claude-code" }), getProcessStatus: () => "running" as const };
    const f = await realFleet({ starts: [(fm) => { fm.lifecycle.invalidate(NAME); fm.lifecycle.daemons.set(NAME, newer); }] });
    const r = await request(f.fm, "PATCH", TEAM);
    expect(r.status).toBe(409);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.fm.lifecycle.daemons.get(NAME)).toBe(newer);
    expect(f.started).toHaveLength(1);
  });
});

describe("Prism on #3721: the compensation runs only after a clean rollback", () => {
  it("a newer valid edit written while the first start fails is kept, and the room is not started onto it", async () => {
    let file = "";
    const f = await realFleet({ starts: [() => {
      const now = yaml.load(readFileSync(file, "utf8")) as any, next = structuredClone(now);
      next.channels[KEY].backend_options = { "claude-code": { credential_profile: "work" } };
      noteSettingsWrite(file, now, next); writeFileSync(file, yaml.dump(next));
    }] });
    file = f.path;
    const r = await request(f.fm, "PATCH", TEAM);
    expect(r.status).toBe(409);
    expect(f.saved()).toEqual({ "claude-code": { credential_profile: "work" } });
    expect(f.started.map(f.profileOf)).toEqual(["team"]);                    // no second start, onto "work" or anything
  });
  it("a file that can't be read back: nothing is started", async () => {
    let file = "";
    const f = await realFleet({ starts: [() => writeFileSync(file, "channels: [unclosed\n")] });
    file = f.path;
    const r = await request(f.fm, "PATCH", TEAM);
    expect(r.status).toBe(409);
    expect(f.started).toHaveLength(1);
  });
});
