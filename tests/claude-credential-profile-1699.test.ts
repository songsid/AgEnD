/**
 * #1699: claude-code credential profiles — a named profile is its own CLAUDE_CONFIG_DIR (login, account, trust,
 * conversations); no profile is exactly today's launch. Every AgEnD reader of the config dir follows the instance's
 * profile, and the API key is injected only by the instance's own dir's login (billing).
 *
 * Scratch AGEND_HOME and HOME (os.homedir() reads HOME), a fake ANTHROPIC_API_KEY of no secret shape, the real
 * ClaudeCodeBackend, update_instance_config and readResumeFingerprint / CacheService. Nothing starts a CLI or a fleet.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend, claudeProfileConfigDir, claudeProjectKey } from "../src/backend/claude-code.js";
import { claudeStoreHasLogin, credentialProfileHome, credentialProfileLogin, credentialSwitchStartsFresh } from "../src/backend/credential-profile.js";
import { readResumeFingerprint } from "../src/turn-resume.js";
import { outboundHandlers, type OutboundContext } from "../src/outbound-handlers.js";
import { Daemon } from "../src/daemon.js";
import { CacheService } from "../src/cache-service.js";
import { FleetManager } from "../src/fleet-manager.js";

const KEY = "test-api-key-not-a-secret-000000000000";
const ENV = ["AGEND_HOME", "HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
let root: string, agendHome: string, home: string, inst: string, work: string;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "agend-1699-"));
  agendHome = join(root, "agend"); home = join(root, "home"); inst = join(root, "inst"); work = join(root, "work");
  for (const d of [agendHome, home, inst, work]) mkdirSync(d, { recursive: true });
  process.env.AGEND_HOME = agendHome; process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_BASE_URL;
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const backend = () => { const b = new ClaudeCodeBackend(inst); (b as any).binaryPath = "/usr/bin/claude"; return b; };
const cfg = (backendOptions?: Record<string, unknown>) => ({ workingDirectory: work, instanceDir: inst, instanceName: "w", mcpServers: {}, skipPermissions: true, ...(backendOptions ? { backendOptions } : {}) }) as any;
const profileDir = (p: string) => credentialProfileHome(agendHome, "claude-code", p);
const writeJson = (path: string, value: unknown) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const OAUTH = { oauthAccount: { accountUuid: "acct-test" } };

describe("#1699 invariant 1: no profile is byte-identical to today", () => {
  const TODAY = (i: string) => `CMUX_CLAUDE_HOOKS_DISABLED=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 /usr/bin/claude --settings ${i}/claude-settings.json --mcp-config ${i}/mcp-config.json --dangerously-skip-permissions`;

  it("the launch command is today's, whether backend_options is absent, empty or has no profile; nothing is created", () => {
    for (const opts of [undefined, {}, { credential_profile: "" }, { some_other_option: "x" }]) {
      const b = backend();
      b.writeConfig(cfg(opts));
      b.preTrust(work, cfg(opts));
      expect(b.buildCommand(cfg(opts)), JSON.stringify(opts)).toBe(TODAY(inst));
    }
    expect(existsSync(join(agendHome, "credential-profiles")), "no profile directory").toBe(false);
    // Trust still goes where it always went.
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects[resolve(work)].hasTrustDialogAccepted).toBe(true);
  });

  it("the fleet's own CLAUDE_CONFIG_DIR is still honoured exactly as before (no profile)", () => {
    const own = join(root, "own-claude");
    process.env.CLAUDE_CONFIG_DIR = own;
    const b = backend();
    b.preTrust(work, cfg());
    expect(b.buildCommand(cfg())).toBe(TODAY(inst));
    expect(existsSync(join(own, ".claude.json"))).toBe(true);
    // --continue still judges the fleet's own dir's conversations, as before.
    writeFileSync(join(inst, "session-id"), "x");
    const p = join(own, "projects", claudeProjectKey(work));
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "s.jsonl"), `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } })}\n`);
    expect(b.buildCommand(cfg())).toBe(`${TODAY(inst)} --continue`);
  });

  it("with the fleet's own CLAUDE_CONFIG_DIR, a profile links back to THAT dir's instructions and skills", () => {
    const own = join(root, "own-claude");
    process.env.CLAUDE_CONFIG_DIR = own;
    mkdirSync(join(own, "skills"), { recursive: true });
    backend().buildCommand(cfg({ credential_profile: "team" }));
    expect(readlinkSync(join(profileDir("team"), "skills"))).toBe(join(own, "skills"));
  });
});

describe("#1699: a named profile is its own config dir", () => {
  it("CLAUDE_CONFIG_DIR=<canonical profile home> is prepended; the home is prepared (private entries, shared links)", () => {
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "my instructions");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    const cmd = backend().buildCommand(cfg({ credential_profile: "team" }));
    const dir = profileDir("team");
    expect(cmd.startsWith(`CMUX_CLAUDE_HOOKS_DISABLED=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CLAUDE_CONFIG_DIR='${dir}' /usr/bin/claude `)).toBe(true);
    for (const shared of ["CLAUDE.md", "skills", "plugins"]) {
      expect(lstatSync(join(dir, shared)).isSymbolicLink(), shared).toBe(true);
      expect(readlinkSync(join(dir, shared))).toBe(join(home, ".claude", shared));
    }
  });

  it("settings.json starts as a copy of the user's (permissions, hooks, enabled plugins) and is the profile's own after", () => {
    writeJson(join(home, ".claude", "settings.json"), { enabledPlugins: { "demo@market": true }, model: "opus" });
    backend().buildCommand(cfg({ credential_profile: "team" }));
    const own = join(profileDir("team"), "settings.json");
    expect(lstatSync(own).isSymbolicLink(), "a real file, not a link").toBe(false);
    expect(JSON.parse(readFileSync(own, "utf8"))).toEqual({ enabledPlugins: { "demo@market": true }, model: "opus" });
    writeFileSync(own, JSON.stringify({ model: "sonnet" }));                       // /model in the profile …
    writeJson(join(home, ".claude", "settings.json"), { model: "haiku" });          // … and in the shared one
    backend().buildCommand(cfg({ credential_profile: "team" }));                   // a later start
    expect(JSON.parse(readFileSync(own, "utf8")), "never overwritten").toEqual({ model: "sonnet" });
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")), "nor leaked back").toEqual({ model: "haiku" });
    backend().buildCommand(cfg({ credential_profile: "fresh" }));
    expect(JSON.parse(readFileSync(join(profileDir("fresh"), "settings.json"), "utf8")), "a new profile copies what is there now").toEqual({ model: "haiku" });
    rmSync(join(home, ".claude", "settings.json"));
    backend().buildCommand(cfg({ credential_profile: "bare" }));
    expect(existsSync(join(profileDir("bare"), "settings.json")), "nothing to start from: nothing made up").toBe(false);
  });

  it("invariant 4: the path is canonical — absolute, normalised — whatever AGEND_HOME looks like", () => {
    // join() would already fold "..", so the case that matters is a relative AGEND_HOME (and a trailing slash).
    process.env.AGEND_HOME = `${relative(process.cwd(), agendHome)}/`;
    const dir = claudeProfileConfigDir({ credential_profile: "team" })!;
    expect(dir).toBe(resolve(agendHome, "credential-profiles", "claude-code", "team"));
    expect(dir.endsWith("/")).toBe(false);
    // The macOS Keychain item claude 2.1.296 will use for it (binary: Lue()) — one name for one profile.
    const service = `Claude Code-credentials-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`;
    expect(service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(backend().buildCommand(cfg({ credential_profile: "team" }))).toContain(`CLAUDE_CONFIG_DIR='${dir}'`);
  });

  it("trust and the API-key approval go into the profile's .claude.json, never ~/.claude.json", () => {
    process.env.ANTHROPIC_API_KEY = KEY;
    const b = backend();
    b.writeConfig(cfg({ credential_profile: "team" }));
    b.preTrust(work, cfg({ credential_profile: "team" }));
    const own = JSON.parse(readFileSync(join(profileDir("team"), ".claude.json"), "utf8"));
    expect(own.projects[resolve(work)].hasTrustDialogAccepted).toBe(true);
    expect(own.customApiKeyResponses.approved).toContain(KEY.slice(-20));
    expect(existsSync(join(home, ".claude.json")), "the shared config is not touched").toBe(false);
  });
});

describe("#1699 invariant 2: the API key follows the instance's OWN config dir's login (billing)", () => {
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = KEY; });

  it("a profile with its own OAuth login gets no API key — even when the shared config has no login", () => {
    writeJson(join(profileDir("team"), ".claude.json"), OAUTH);
    expect(backend().buildCommand(cfg({ credential_profile: "team" }))).not.toContain("ANTHROPIC_API_KEY");
  });

  it("a profile without a login gets the key — even when the shared config HAS a login", () => {
    writeJson(join(home, ".claude.json"), OAUTH);
    expect(backend().buildCommand(cfg({ credential_profile: "team" }))).toContain(`ANTHROPIC_API_KEY='${KEY}'`);
  });

  it("no profile: today's rule, read from ~/.claude.json", () => {
    expect(backend().buildCommand(cfg())).toContain(`ANTHROPIC_API_KEY='${KEY}'`);
    writeJson(join(home, ".claude.json"), OAUTH);
    expect(backend().buildCommand(cfg())).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("#1699 invariant 3: every reader of the config dir follows the profile", () => {
  const session = (dir: string, cwd: string, name = "s1") => {
    const p = join(dir, "projects", claudeProjectKey(cwd));
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, `${name}.jsonl`), `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } })}\n`);
  };

  it("--continue: only when the PROFILE's projects/ has this directory's conversation", () => {
    writeFileSync(join(inst, "session-id"), "x");
    session(join(home, ".claude"), work);
    expect(backend().buildCommand(cfg({ credential_profile: "team" }))).not.toContain("--continue");
    session(profileDir("team"), work);
    expect(backend().buildCommand(cfg({ credential_profile: "team" }))).toContain("--continue");
    rmSync(join(home, ".claude"), { recursive: true });
    expect(backend().buildCommand(cfg()), "no profile: the shared store, as before").not.toContain("--continue");
  });

  it("the resume fingerprint reads the profile's transcripts when given its dir", () => {
    session(profileDir("team"), work, "only-in-profile");
    expect(readResumeFingerprint("claude", { instanceDir: inst, workingDirectory: work })).toBeNull();
    expect(readResumeFingerprint("claude", { instanceDir: inst, workingDirectory: work, claudeConfigDir: profileDir("team") })).not.toBeNull();
  });

  it("the daemon hands its instance's profile dir to the resume reader", () => {
    const d: any = new Daemon("w", { working_directory: work, backend: "claude-code", backend_options: { "claude-code": { credential_profile: "team" } } } as any,
      inst, false, backend(), undefined, { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as any);
    expect(d.resumeRoots(work)).toEqual({ instanceDir: inst, workingDirectory: work, claudeConfigDir: profileDir("team") });
    const plain: any = new Daemon("w", { working_directory: work, backend: "claude-code" } as any, inst, false, backend(), undefined,
      { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as any);
    expect(plain.resumeRoots(work).claudeConfigDir).toBe(join(home, ".claude"));
    process.env.CLAUDE_CONFIG_DIR = join(root, "own-claude");
    expect(plain.resumeRoots(work).claudeConfigDir, "the fleet's own dir, as before").toBe(join(root, "own-claude"));
  });

  it("the launch hands preTrust the same config writeConfig got — the profile's .claude.json is the one trusted", async () => {
    const d: any = new Daemon("w", { working_directory: work, backend: "claude-code", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      backend_options: { "claude-code": { credential_profile: "team" } } } as any,
      inst, false, undefined, undefined, { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as any);
    d.backend = { binaryName: "claude", writeConfig: vi.fn(), preTrust: vi.fn(), buildCommand: vi.fn(() => { throw new Error("stop after preTrust"); }) };
    await expect(d.trySpawnInsideGate()).rejects.toThrow(/stop after preTrust/);
    expect(d.backend.preTrust).toHaveBeenCalledWith(work, d.backend.writeConfig.mock.calls[0][0]);
    expect(d.backend.writeConfig.mock.calls[0][0].backendOptions).toEqual({ credential_profile: "team" });
  });

  it("the fleet's per-instance dir (cache ledger): fleet.yaml profile, fleet default, a ClassicBot room's launched or configured login", () => {
    const fm = Object.create(FleetManager.prototype);
    fm.lifecycle = { daemons: new Map([["room-running", { getConfigSnapshot: () => ({ backend: "claude-code", backend_options: { "claude-code": { credential_profile: "launched" } } }) }]]) };
    fm.classicChannels = {
      getCredentialProfileByInstance: (name: string) => (name.startsWith("room") ? { state: "profile", name: "configured" } : { state: "shared" }),
      getBackendByInstance: () => "claude-code",
    };
    fm.fleetConfig = { defaults: {}, instances: {
      plain: { working_directory: work },
      team: { working_directory: work, backend_options: { "claude-code": { credential_profile: "team" } } },
      other: { working_directory: work, backend_options: { codex: { credential_profile: "team" } } },
    } };
    expect(fm.claudeConfigDirOf("plain")).toBe(join(home, ".claude"));
    expect(fm.claudeConfigDirOf("team")).toBe(profileDir("team"));
    expect(fm.claudeConfigDirOf("other"), "another backend's profile is not claude's").toBe(join(home, ".claude"));
    expect(fm.claudeConfigDirOf("room-running"), "a running room: what it was launched on").toBe(profileDir("launched"));
    expect(fm.claudeConfigDirOf("room-stopped"), "a stopped room: its configured login").toBe(profileDir("configured"));
    expect(fm.claudeConfigDirOf("lobby")).toBe(join(home, ".claude"));
    fm.classicChannels.getAll = () => [{ instanceName: "room-stopped" }];
    fm.backendNameOf = () => "claude-code";
    fm.getInstanceDir = (name: string) => join(agendHome, "instances", name);
    expect(Object.fromEntries(fm.cacheInstances().map((i: { name: string; claudeConfigDir: string }) => [i.name, i.claudeConfigDir])), "the cache ledger gets each one's dir")
      .toEqual({ plain: join(home, ".claude"), team: profileDir("team"), other: join(home, ".claude"), "room-stopped": profileDir("configured") });
    fm.fleetConfig.defaults = { backend_options: { "claude-code": { credential_profile: "dflt" } } };
    expect(fm.claudeConfigDirOf("plain"), "fleet default").toBe(profileDir("dflt"));
  });

  it("the cache ledger lists the profile's transcripts for a profiled instance", async () => {
    session(profileDir("team"), work, "profile-session");
    session(join(home, ".claude"), work, "shared-session");
    const svc: any = new CacheService({
      instances: () => [], claudeProjectsDir: () => join(home, ".claude", "projects"), claudeKey: claudeProjectKey,
      codexSessionsDir: () => join(home, ".codex", "sessions"), listRollouts: () => [], metaPath: join(root, "meta.json"),
    } as any);
    const files = async (claudeConfigDir?: string) => (await svc.claudeFiles({ name: "w", backend: "claude-code", workingDirectory: work, ledgerPath: "", ...(claudeConfigDir ? { claudeConfigDir } : {}) }, 0))
      .map((f: { path: string }) => f.path.split("/").at(-1));
    expect(await files(profileDir("team"))).toEqual(["profile-session.jsonl"]);
    expect(await files()).toEqual(["shared-session.jsonl"]);
  });
});

describe("#1699: logins and invariant 5 (a switch starts fresh, with a handover)", () => {
  it("a claude login is seen in either form: a .credentials.json token (Linux) or the account in .claude.json (macOS)", () => {
    const dir = profileDir("a");
    expect(claudeStoreHasLogin(dir)).toBe(false);
    writeJson(join(dir, ".credentials.json"), { claudeAiOauth: { accessToken: "x" } });
    expect(claudeStoreHasLogin(dir)).toBe(true);
    const mac = profileDir("b");
    writeJson(join(mac, ".claude.json"), OAUTH);
    expect(claudeStoreHasLogin(mac)).toBe(true);
    writeJson(join(profileDir("c"), ".claude.json"), { oauthAccount: {} });
    expect(claudeStoreHasLogin(profileDir("c"))).toBe(false);
  });

  it("a login file that is there but cannot be read is UNKNOWN — never signed out (a switch is not refused over it)", () => {
    const dir = profileDir("broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), "{ half-written");
    expect(claudeStoreHasLogin(dir)).toBeNull();
    expect(credentialProfileLogin(agendHome, "claude-code", "broken")).toEqual({ state: "unknown" });
    writeJson(join(dir, ".claude.json"), OAUTH);
    expect(claudeStoreHasLogin(dir), "the other file still proves it").toBe(true);
    const odd = profileDir("odd");
    mkdirSync(join(odd, ".claude.json"), { recursive: true });   // EISDIR: there, not readable
    expect(claudeStoreHasLogin(odd)).toBeNull();
    const nul = profileDir("null");
    mkdirSync(nul, { recursive: true });
    writeFileSync(join(nul, ".credentials.json"), "null");          // valid JSON, not a credentials file
    expect(claudeStoreHasLogin(nul)).toBeNull();
    writeJson(join(profileDir("absent"), "x.json"), {});
    expect(claudeStoreHasLogin(profileDir("absent")), "neither file: signed out").toBe(false);
  });

  it("a signed-out profile names the exact command: CLAUDE_CONFIG_DIR=<home> claude auth login", () => {
    const login = credentialProfileLogin(agendHome, "claude-code", "team");
    expect(login).toEqual({ state: "signed-out", loginCommand: `CLAUDE_CONFIG_DIR=${JSON.stringify(profileDir("team"))} claude auth login` });
    expect(credentialSwitchStartsFresh("claude-code")).toBe(true);
  });

  function harness(instance: Record<string, unknown>, handover: string) {
    const delivered: Array<Record<string, unknown>> = [];
    const daemons = new Map([["worker", { collectHandoverContext: () => handover }]]);
    const restartSingleInstance = vi.fn(async () => { daemons.delete("worker"); });
    const ctx = {
      dataDir: agendHome,
      fleetConfig: { defaults: {}, instances: { worker: instance } },
      classicChannels: { getAll: () => [] }, saveFleetConfig: vi.fn(), restartSingleInstance,
      lifecycle: { daemons, isPaused: () => false },
      instanceIpcClients: new Map([["worker", { send: (m: Record<string, unknown>) => { delivered.push(m); } }]]),
      getInstanceStatus: () => "running",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as OutboundContext;
    return { ctx, delivered, restartSingleInstance };
  }
  async function update(ctx: OutboundContext, config: unknown) {
    let result: any = null, error: string | undefined;
    let settle!: () => void; const done = new Promise<void>(r => { settle = r; });
    await outboundHandlers.get("update_instance_config")!(ctx, { name: "worker", config } as never, (r, e) => { result = r; error = e; settle(); }, {} as never);
    await Promise.race([done, new Promise(r => setTimeout(r, 6_000))]);
    return { result, error };
  }

  it("switching to a signed-out claude profile is refused with that command; the config stays", async () => {
    const instance: Record<string, unknown> = { working_directory: work, backend: "claude-code" };
    const h = harness(instance, "");
    const { error } = await update(h.ctx, { backend_options: { "claude-code": { credential_profile: "team" } } });
    expect(error).toContain(`CLAUDE_CONFIG_DIR=${JSON.stringify(profileDir("team"))} claude auth login`);
    expect(instance.backend_options).toBeUndefined();
    expect(h.restartSingleInstance).not.toHaveBeenCalled();
  });

  it("switching to a signed-in profile restarts fresh and hands the work over", async () => {
    writeJson(join(profileDir("team"), ".claude.json"), OAUTH);
    const h = harness({ working_directory: work, backend: "claude-code" }, "Recent user messages:\n- finish the release notes");
    const { result } = await update(h.ctx, { backend_options: { "claude-code": { credential_profile: "team" } } });
    expect(h.restartSingleInstance).toHaveBeenCalledWith("worker", { freshStart: true });
    expect(h.delivered).toHaveLength(1);
    expect(String(h.delivered[0]!.content)).toContain("[system:handover]");
    expect(String(h.delivered[0]!.content)).toContain("finish the release notes");
    expect(result).toMatchObject({ conversation_carried_over: false });
  }, 10_000);
});
