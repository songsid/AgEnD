/**
 * #3715 (M-2961): update_instance_config on a ClassicBot room may switch its AI account —
 * `config.backend_options.<backend>.credential_profile` and nothing else — with the room's Settings save (#3691):
 * - only that room's backend_options lines change in classicBot.yaml; comments, quoting and the other room stay;
 * - the room restarts through restartClassicInstanceFromSettings(name, ["backend_options"]) (the #1753 handoff), and
 *   the answer names the profile the room was relaunched on, read back from it — a mismatch is said, not hidden;
 * - refused with nothing written and no restart: a profile that doesn't exist here, one not signed in, any other key
 *   (today's message, word for word), another backend_options key, a backend without accounts;
 * - a failed restart puts the file back byte for byte.
 * Scratch AGEND_HOME (dataDir), fake tokens; nothing starts a CLI or a fleet.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { switchClassicRoomProfile, type SettingsApiContext } from "../src/settings-api.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A hand-written classicBot.yaml: comments, quoting and a second room the write must leave exactly as they are. */
const HAND = `# ClassicBot rooms — edited by hand
defaults:
  backend: claude-code   # the rooms' CLI
channels:
  "123#discord":
    instanceName: classic-alpha-0001
    channelId: "123"
    adapterId: discord
    model: 'opus'        # kept as typed
    collab: true
  "456#discord":
    instanceName: classic-beta-0002
    channelId: "456"
    adapterId: discord
    backend_options:
      claude-code:
        credential_profile: work
`;
const ROOMS = ["classic-alpha-0001", "classic-beta-0002"];

function setup(opts: { running?: boolean; launched?: (name: string, backend: string) => string | null; restartFails?: boolean | ((path: string) => void);
  restore?: () => Promise<"restarted" | "not-running" | "superseded"> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-3715-")); dirs.push(dir);
  // "work" and "team" signed in (fake tokens), "ghost" made but never signed in.
  for (const name of ["work", "team"]) {
    const home = join(dir, "credential-profiles", "claude-code", name); mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c".repeat(40), refreshToken: "d".repeat(40), expiresAt: Date.now() + 3_600_000 } }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: `u-${name}` } }));
  }
  mkdirSync(join(dir, "credential-profiles", "claude-code", "ghost"), { recursive: true });
  const path = join(dir, "classicBot.yaml");
  writeFileSync(path, HAND);
  const restart = vi.fn(async (..._args: unknown[]) => {
    if (typeof opts.restartFails === "function") { opts.restartFails(path); throw new Error("start refused"); }
    if (opts.restartFails) throw new Error("start refused");
  });
  const restore = vi.fn(opts.restore ?? (async () => "restarted" as const));
  const settings = {
    fleetConfig: { defaults: {}, instances: {} }, configPath: join(dir, "fleet.yaml"), dataDir: dir,
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    // FleetManager.beginClassicProfileSwitch in production (its own tests below); here its two calls are observed.
    beginClassicProfileSwitch: (name: string, fields: string[]) => ({ restart: () => restart(name, fields), restore, close() {} }),
  } as unknown as SettingsApiContext;
  const running = opts.running ?? true;
  // The tool's context: FleetManager in production (switchClassicRoomProfile delegates to settings-api's, with itself).
  const ctx = {
    fleetConfig: settings.fleetConfig, dataDir: dir,
    classicChannels: { getAll: () => ROOMS.map(instanceName => ({ instanceName, name: "room", channelId: "x" })) },
    lifecycle: { daemons: new Map(running ? ROOMS.map(n => [n, {}]) : []), isPaused: () => false },
    instanceIpcClients: new Map(),
    saveFleetConfig: vi.fn(),
    switchClassicRoomProfile: (name: string, options: unknown) => switchClassicRoomProfile(settings, name, options),
    // What the relaunched room runs on: by default, what the file now says (as the real launch resolves it).
    credentialProfileOf: vi.fn(opts.launched ?? ((name: string) => {
      const m = new ClassicChannelManager(dir, { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } } as never);
      m.reloadFromDisk();
      const p = m.getCredentialProfileByInstance(name, {});
      return p.state === "profile" ? p.name : null;
    })),
  } as any;
  return { dir, path, ctx, restart, restore };
}
async function update(ctx: any, name: string, config: Record<string, unknown>) {
  let result: any, error: string | null | undefined;
  await outboundHandlers.get("update_instance_config")!(ctx, { name, config }, (value, message) => { result = value; error = message; }, { instanceName: "general" } as any);
  return { result, error };
}
/** Lines of `after` not in `before` (in order), and whether `before` survives in order. */
function linesAdded(before: string, after: string): { added: string[]; kept: boolean } {
  const b = before.split("\n"), a = after.split("\n"), added: string[] = [];
  let i = 0;
  for (const line of a) { if (i < b.length && line === b[i]) i++; else added.push(line); }
  return { added, kept: i === b.length };
}

describe("update_instance_config switches a ClassicBot room's account", () => {
  it("writes only that room's backend_options lines, restarts it, and names the profile it relaunched on", async () => {
    const { path, ctx, restart } = setup();
    const r = await update(ctx, "classic-alpha-0001", { backend_options: { "claude-code": { credential_profile: "work" } } });
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ success: true, classic_room: "123#discord", backend: "claude-code", credential_profile: "work", changed: true, restarted: true, launched_profile: "work" });
    expect(r.result.warning).toBeUndefined();
    const after = readFileSync(path, "utf8");
    const { added, kept } = linesAdded(HAND, after);
    expect(kept).toBe(true);
    expect(added.filter(Boolean).map(l => l.trim())).toEqual(["backend_options:", "claude-code:", "credential_profile: work"]);
    expect(restart.mock.calls).toEqual([["classic-alpha-0001", ["backend_options"]]]);
  });
  it("null goes back to the fleet default: the key goes, nothing else changes", async () => {
    const { path, ctx } = setup();
    const r = await update(ctx, "classic-beta-0002", { backend_options: { "claude-code": { credential_profile: null } } });
    expect(r.result).toMatchObject({ success: true, credential_profile: "default", launched_profile: "default", changed: true });
    const after = readFileSync(path, "utf8");
    expect(linesAdded(after, HAND)).toEqual({ added: ["    backend_options:", "      claude-code:", "        credential_profile: work"], kept: true });
    expect((yaml.load(after) as any).channels["456#discord"].backend_options).toBeUndefined();
  });
  it("the same account again: nothing written, no restart", async () => {
    const { path, ctx, restart } = setup();
    const r = await update(ctx, "classic-beta-0002", { backend_options: { "claude-code": { credential_profile: "work" } } });
    expect(r.result).toMatchObject({ success: true, credential_profile: "work", changed: false, restarted: false, launched_profile: "work" });
    expect([readFileSync(path, "utf8"), restart.mock.calls.length]).toEqual([HAND, 0]);
  });
  it("a relaunch on another profile than asked is said, not hidden", async () => {
    const { ctx } = setup({ launched: () => "team" });
    const r = await update(ctx, "classic-alpha-0001", { backend_options: { "claude-code": { credential_profile: "work" } } });
    expect(r.result).toMatchObject({ credential_profile: "work", launched_profile: "team" });
    expect(r.result.warning).toContain(`running on "team"`);
  });
  it("a stopped room is not started: the account is saved for its next start", async () => {
    const { path, ctx } = setup({ running: false });
    const r = await update(ctx, "classic-alpha-0001", { backend_options: { "claude-code": { credential_profile: "team" } } });
    expect(r.result).toMatchObject({ success: true, credential_profile: "team", restarted: false });
    expect(r.result.launched_profile).toBeUndefined();
    expect(r.result.note).toContain("next time");
    expect((yaml.load(readFileSync(path, "utf8")) as any).channels["123#discord"].backend_options).toEqual({ "claude-code": { credential_profile: "team" } });
  });
});

describe("refused, with nothing written and no restart", () => {
  const TODAY = "This is a ClassicBot instance (managed in classicBot.yaml). Use set_display_name or set_description to configure it.";
  const cases: Array<[string, Record<string, unknown>, string | RegExp]> = [
    ["a profile that doesn't exist here", { backend_options: { "claude-code": { credential_profile: "nobody" } } }, /No claude-code account named "nobody"/],
    ["a profile that isn't signed in (with its login command)", { backend_options: { "claude-code": { credential_profile: "ghost" } } }, /"ghost" is not signed in[\s\S]*CLAUDE_CONFIG_DIR=/],
    ["a malformed name", { backend_options: { "claude-code": { credential_profile: "../x" } } }, /credential_profile/],
    ["another backend_options key", { backend_options: { "claude-code": { credential_profile: "work", permissions: "full" } } }, /only backend_options\.claude-code\.credential_profile/],
    ["a backend with no named accounts", { backend_options: { opencode: { credential_profile: "work" } } }, /opencode has no named accounts/],
    ["any other key: today's refusal", { model: "sonnet" }, TODAY],
    ["the account together with another key: today's refusal", { backend_options: { "claude-code": { credential_profile: "work" } }, description: "x" }, TODAY],
    ["an empty config: today's refusal", {}, TODAY],
  ];
  for (const [label, config, error] of cases) {
    it(label, async () => {
      const { path, ctx, restart } = setup();
      const r = await update(ctx, "classic-alpha-0001", config);
      expect(r.result).toBeNull();
      if (typeof error === "string") expect(r.error).toBe(error); else expect(r.error).toMatch(error);
      expect([readFileSync(path, "utf8"), restart.mock.calls.length]).toEqual([HAND, 0]);
    });
  }
  it("a failed restart puts classicBot.yaml back byte for byte and brings the room up again", async () => {
    const { path, ctx, restore } = setup({ restartFails: true });
    const r = await update(ctx, "classic-alpha-0001", { backend_options: { "claude-code": { credential_profile: "work" } } });
    expect([r.result, r.error]).toEqual([null, expect.stringContaining("so its account was put back and the room was started on it again")]);
    expect(readFileSync(path, "utf8")).toBe(HAND);
    expect(restore).toHaveBeenCalledOnce();
  });
});

describe("Prism on #3719 (3): a failed restart says what really happened", () => {
  const SWITCH = { backend_options: { "claude-code": { credential_profile: "work" } } };
  it("a newer edit of the same account meanwhile is kept, said, and nothing is restarted for it", async () => {
    const { path, ctx, restore } = setup({ restartFails: (file) => {
      const now = yaml.load(readFileSync(file, "utf8")) as any, next = structuredClone(now);
      next.channels["123#discord"].backend_options = { "claude-code": { credential_profile: "team" } };
      noteSettingsWrite(file, now, next); writeFileSync(file, yaml.dump(next));
    } });
    const r = await update(ctx, "classic-alpha-0001", SWITCH);
    expect(r.error).toContain("was not put back: classicBot.yaml was changed again meanwhile");
    expect((yaml.load(readFileSync(path, "utf8")) as any).channels["123#discord"].backend_options).toEqual({ "claude-code": { credential_profile: "team" } });
    expect(restore).not.toHaveBeenCalled();
  });
  it("a file that can't be read back: said, and nothing is restarted", async () => {
    const { ctx, restore } = setup({ restartFails: (file) => writeFileSync(file, "channels: [unclosed\n") });
    const r = await update(ctx, "classic-alpha-0001", SWITCH);
    expect(r.error).toContain("could not be put back");
    expect(restore).not.toHaveBeenCalled();
  });
  it("put back, but the room's own restart on it fails too: said", async () => {
    const { path, ctx } = setup({ restartFails: true, restore: async () => { throw new Error("pane gone"); } });
    const r = await update(ctx, "classic-alpha-0001", SWITCH);
    expect(r.error).toContain("starting the room on it failed too (pane gone)");
    expect(readFileSync(path, "utf8")).toBe(HAND);
  });
  it("put back, and the room was changed by someone else meanwhile: not restarted, said", async () => {
    const { ctx } = setup({ restartFails: true, restore: async () => "superseded" });
    expect((await update(ctx, "classic-alpha-0001", SWITCH)).error).toContain("The room was not restarted: it was stopped or started by something else meanwhile.");
  });
  it("controls: an agent in fleet.yaml keeps its own path; an unknown name keeps its error", async () => {
    const { ctx } = setup();
    expect((await update(ctx, "missing", { description: "x" })).error).toBe("Instance 'missing' not found in fleet config");
  });
});

/**
 * The real FleetManager: beginClassicProfileSwitch, restartClassicInstanceFromSettings, startClassicInstance and
 * startInstance run as in production; only the boundaries are replaced — the stop (it invalidates the room's epoch at
 * once, as the real one does in its transition, and takes the daemon away) and the CLI launch inside lifecycle.start
 * (it publishes a daemon whose snapshot is the config it was given, through the same `published` callback).
 */
async function realFleet(opts: { starts?: Array<"ok" | "fail" | ((fm: any) => void)>; holdHandoff?: Promise<void> } = {}) {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const { dir, path } = setup();
  const previousHome = process.env.AGEND_HOME; process.env.AGEND_HOME = dir;
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = { defaults: {}, instances: {} };
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as never;
  const classic = new ClassicChannelManager(dir, log); classic.configureAdapters([{ id: "discord", type: "discord" }]);
  fm.classicChannels = classic; classic.reloadFromDisk();
  const name = "classic-alpha-0001";
  const daemon = (config: Record<string, unknown>) => ({ applyConfigUpdate: vi.fn(), getConfigSnapshot: () => config, getProcessStatus: () => "running" as const });
  const original = daemon({ backend: "claude-code", working_directory: join(dir, "workspaces", name) });
  fm.lifecycle.daemons.set(name, original);
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
  // Only the restart's 250 ms settle is skipped; every other timer (the operation's own deadline among them) is real.
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
    ms === 250 ? (fn(), 0 as any) : realTimeout(fn, ms, ...rest)) as any);
  const run = async (config: Record<string, unknown>) => {
    let result: any, error: string | null | undefined;
    await outboundHandlers.get("update_instance_config")!(fm, { name, config }, (value, message) => { result = value; error = message; }, { instanceName: "general" } as any);
    return { result, error };
  };
  const done = () => { if (previousHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = previousHome; };
  const profileOf = (config: Record<string, unknown> | undefined) => (config?.backend_options as any)?.["claude-code"]?.credential_profile ?? null;
  return { fm, dir, path, name, original, stop, started, run, done, profileOf };
}
const TEAM = { backend_options: { "claude-code": { credential_profile: "team" } } };

describe("end to end through FleetManager: the answer is what the relaunch started with", () => {
  it("update_instance_config → the #3691 write → the owned restart → the room's start config → launched_profile", async () => {
    const f = await realFleet();
    try {
      const r = await f.run(TEAM);
      expect(r.error).toBeUndefined();
      expect(f.started.map(f.profileOf)).toEqual(["team"]);
      expect(r.result).toMatchObject({ success: true, credential_profile: "team", restarted: true, launched_profile: "team" });
      expect(linesAdded(HAND, readFileSync(f.path, "utf8")).added.filter(Boolean).map(l => l.trim())).toEqual(["backend_options:", "claude-code:", "credential_profile: team"]);
    } finally { f.done(); }
  });
});

describe("Prism on #3719 (1)(2): the compensation is owned, and brings the room back", () => {
  it("(1) the new account's first start fails: the file goes back and the room is started again on its old account", async () => {
    const f = await realFleet({ starts: ["fail", "ok"] });
    try {
      const r = await f.run(TEAM);
      expect(r.error).toContain("so its account was put back and the room was started on it again");
      expect(f.started.map(f.profileOf)).toEqual(["team", null]);           // the second start is the old (shared) login
      expect(f.fm.lifecycle.daemons.has(f.name)).toBe(true);
      expect(readFileSync(f.path, "utf8")).toBe(HAND);
    } finally { f.done(); }
  });
  it("(2) a Stop while the handoff is held: the switch never launches, and the compensation doesn't start the room either", async () => {
    let release!: () => void;
    const f = await realFleet({ holdHandoff: new Promise<void>(r => { release = r; }) });
    try {
      const pending = f.run(TEAM);
      await vi.waitFor(() => expect(f.fm.switchConversation).toHaveBeenCalled());
      f.fm.lifecycle.invalidate(f.name);                                     // what a Stop does at once
      release();
      const r = await pending;
      expect(f.started).toEqual([]);
      expect(r.error).toContain("The room was not restarted: it was stopped or started by something else meanwhile.");
      expect(f.fm.lifecycle.daemons.has(f.name)).toBe(false);
      expect(readFileSync(f.path, "utf8")).toBe(HAND);
    } finally { f.done(); }
  });
  it("(2) a newer runtime published after the failed start is left alone: no stop, no replacement", async () => {
    const newer = { getConfigSnapshot: () => ({ backend: "claude-code" }), getProcessStatus: () => "running" as const };
    const f = await realFleet({ starts: [(fm) => { fm.lifecycle.invalidate("classic-alpha-0001"); fm.lifecycle.daemons.set("classic-alpha-0001", newer); }] });
    try {
      const r = await f.run(TEAM);
      expect(r.error).toContain("The room was not restarted");
      expect(f.stop).toHaveBeenCalledOnce();                                  // the switch's own stop only
      expect(f.fm.lifecycle.daemons.get(f.name)).toBe(newer);
      expect(f.started).toHaveLength(1);
    } finally { f.done(); }
  });
});
