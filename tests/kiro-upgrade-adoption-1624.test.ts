import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Factory construction may probe compatibility; every process boundary is inert
// even before our Daemon.start stub. The configured backend above uses fixed facts.
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFileSync: () => { throw new Error("fixture: no processes"); },
  execFile: () => { throw new Error("fixture: no processes"); }, spawn: () => { throw new Error("fixture: no processes"); } }));
import { KiroBackend, probeKiroCliCompatibility, type KiroCliCompatibility } from "../src/backend/kiro.js";
import { recordKiroLaunch, readKiroLedger } from "../src/backend/kiro-engine-ledger.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { Daemon } from "../src/daemon.js";
import { sharedKiroV2StoreLane } from "../src/backend/kiro-v2-store.js";
import { EventEmitter } from "node:events";
import { getLocale, setLocale, t } from "../src/locale.js";

// Real backend/identity/SQLite, private native row fixtures only. No launch handler is called.
let root: string, home: string, cwd: string;
const compat: KiroCliCompatibility = {
  version: "kiro-cli 2.29.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, supportsInstanceAgent: true, source: "version",
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-1624-")); home = join(root, "agend"); cwd = join(root, "work");
  mkdirSync(join(home, "instances", "worker"), { recursive: true }); mkdirSync(cwd);
  vi.stubEnv("AGEND_HOME", home); vi.stubEnv("XDG_DATA_HOME", join(root, "xdg")); vi.stubEnv("KIRO_HOME", join(root, "kiro"));
});
afterEach(() => { sharedKiroV2StoreLane.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function store(rows: Array<[string, number, string?]> = [["old", 100], ["newest", 200]]): void {
  const dir = join(root, "xdg", "kiro-cli"); mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX IF NOT EXISTS idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);");
    const native = JSON.parse(readFileSync(join(__dirname, "fixtures/kiro-upgrade-1624/conversation-v1.json"), "utf8"));
    const insert = db.prepare("INSERT OR REPLACE INTO conversations_v2 VALUES (?, ?, ?, ?, ?)");
    for (const [id, updated, key = cwd] of rows) insert.run(key, id, JSON.stringify({ ...native, conversation_id: id }), updated - 10, updated);
  } finally { db.close(); }
}
function config(over: Partial<CliBackendConfig> = {}): CliBackendConfig {
  return { workingDirectory: cwd, instanceDir: join(home, "instances", "worker"), instanceName: "worker",
    mcpServers: {}, instructions: "# fixture", peerWorkingDirectories: () => [], ...over };
}
function launch(backend: KiroBackend, over: Partial<CliBackendConfig> = {}): string {
  const cfg = config(over); backend.writeConfig(cfg); return backend.buildCommand(cfg);
}
function identity(): any {
  const name = createHash("sha256").update("worker").digest("hex").slice(0, 32) + ".json";
  return Object.values(JSON.parse(readFileSync(join(home, "kiro-identity/instances", name), "utf8")).keys)[0];
}

describe("pre-ledger upgrade adoption (#1624)", () => {
  it("no ledger file: records newest native cwd row, exclusive claim and ledger, then resumes exactly that id", () => {
    store([["old", 100], ["newest", 200], ["wrong-cwd", 999, join(root, "elsewhere")]]);
    expect(existsSync(join(home, "kiro-engine-ledger.json"))).toBe(false);
    const backend = new KiroBackend(config().instanceDir, compat);
    expect(launch(backend)).toContain(" --resume-id 'newest'");
    expect(identity()).toMatchObject({ id: "newest", engine: "v1", agentConfirmed: false });
    expect(readFileSync(join(home, "kiro-identity/claims/v1/newest"), "utf8")).toBe("worker\n");
    expect(readKiroLedger().worker?.lastLaunch.flags).toContain("--agent");
    store([["later", 300]]);
    expect(launch(backend)).toContain(" --resume-id 'newest'");
  });

  it.each(["literal", "symlink"])("shared canonical cwd (%s) starts durably fresh and warns once", kind => {
    store(); let other = cwd;
    if (kind === "symlink") { other = join(root, "alias"); symlinkSync(cwd, other, "dir"); }
    const backend = new KiroBackend(config().instanceDir, compat);
    const overrides = { peerWorkingDirectories: () => [other] };
    expect(launch(backend, overrides)).not.toContain("--resume");
    expect(identity()).toMatchObject({ id: null, known: ["newest", "old"] });
    expect(backend.consumeLaunchWarning() ?? "").toMatch(/shares|another.*directory/i);
    expect(launch(backend, overrides)).not.toContain("--resume");
    expect(backend.consumeLaunchWarning()).toBeNull();
  });

  it("a claimed newest conversation is not skipped to adopt an older one; ambiguity notice is once", () => {
    store(); mkdirSync(join(home, "kiro-identity/claims/v1"), { recursive: true });
    writeFileSync(join(home, "kiro-identity/claims/v1/newest"), "sibling\n");
    const backend = new KiroBackend(config().instanceDir, compat);
    expect(launch(backend)).not.toContain("--resume");
    expect(identity()).toMatchObject({ id: null });
    expect(backend.consumeLaunchWarning() ?? "").toMatch(/claim|another instance/i);
    rmSync(join(home, "kiro-identity/claims/v1/newest"));
    expect(launch(backend)).not.toContain("--resume");
    expect(backend.consumeLaunchWarning()).toBeNull();
  });

  it("skipResume leaves a durable fresh mark; a later launch never re-adopts the old conversation", () => {
    store(); const backend = new KiroBackend(config().instanceDir, compat);
    expect(launch(backend, { skipResume: true })).not.toContain("--resume");
    expect(identity()).toMatchObject({ id: null });
    expect(launch(backend)).not.toContain("--resume");
  });

  it("Kiro below 2.21 keeps plain --resume, no agent and no identity; upgrading Kiro adopts from its old-style ledger", () => {
    store();
    const old = probeKiroCliCompatibility("/fixture/kiro", () => "kiro-cli 2.20.9\n");
    expect(old.supportsInstanceAgent).toBe(false);
    const oldBackend = new KiroBackend(config().instanceDir, old);
    const oldCommand = launch(oldBackend);
    expect(oldCommand).toContain(" --resume"); expect(oldCommand).not.toContain("--agent ");
    expect(existsSync(join(home, "kiro-identity"))).toBe(false);
    expect(readKiroLedger().worker?.lastLaunch.flags).not.toContain("--agent");
    expect(launch(new KiroBackend(config().instanceDir, compat))).toContain(" --resume-id 'newest'");
  });

  it.each(["tui", "v3", "agent", "changed-cwd", "changed-profile"])("existing ledger (%s) cannot use the no-ledger fallback", shape => {
    store();
    recordKiroLaunch({ instance: "worker", workingDirectory: shape === "changed-cwd" ? join(root, "other") : cwd,
      credentialProfile: shape === "changed-profile" ? "other" : null, kiroVersion: "2.22.0",
      ui: shape === "tui" ? "tui" : shape === "v3" ? "v3" : "legacy",
      flags: shape === "agent" ? ["--agent-engine=v1", "--agent"] : ["--agent-engine=" + (shape === "tui" ? "v2" : shape === "v3" ? "v3" : "v1")] });
    expect(launch(new KiroBackend(config().instanceDir, compat))).not.toContain("--resume");
  });

  it.each([undefined, () => { throw new Error("unknown roster"); }])("unknown sibling roster cannot authorize adoption", peers => {
    store(); const backend = new KiroBackend(config().instanceDir, compat);
    expect(launch(backend, { peerWorkingDirectories: peers })).not.toContain("--resume");
    expect(identity()).toMatchObject({ id: null });
  });

  it("a damaged ledger is not evidence that there was no launch record", () => {
    store(); writeFileSync(join(home, "kiro-engine-ledger.json"), "{ broken");
    expect(launch(new KiroBackend(config().instanceDir, compat))).not.toContain("--resume");
  });

  it("an invalid own ledger entry is not dropped into the missing-entry fallback", () => {
    store(); writeFileSync(join(home, "kiro-engine-ledger.json"), JSON.stringify({ worker: { invalid: true } }));
    expect(launch(new KiroBackend(config().instanceDir, compat))).not.toContain("--resume");
  });

  it("a different instance's ledger entry does not prevent this pre-ledger instance's adoption", () => {
    store(); recordKiroLaunch({ instance: "other", workingDirectory: join(root, "different"), credentialProfile: null,
      kiroVersion: "2.22.0", ui: "legacy", flags: ["--agent-engine=v1"] });
    expect(launch(new KiroBackend(config().instanceDir, compat))).toContain(" --resume-id 'newest'");
  });

  it("an unreadable ledger is not absence", () => {
    store(); mkdirSync(join(home, "kiro-engine-ledger.json"));
    expect(launch(new KiroBackend(config().instanceDir, compat))).not.toContain("--resume");
  });

  it("a pre-ledger TUI launch adopts only the v2 store, never its Classic cwd conversation", async () => {
    store(); const sessions = join(root, "kiro/sessions/cli"); mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "tui-id.json"), JSON.stringify({ session_id: "tui-id", cwd,
      created_at: "2026-10-11T10:00:00Z", updated_at: "2026-10-11T11:00:00Z" }));
    const backend = new KiroBackend(config().instanceDir, compat), cfg = config({ kiroUi: "tui" });
    await backend.prepareLaunch(cfg); backend.writeConfig(cfg);
    expect(backend.buildCommand(cfg)).toContain(" --resume-id 'tui-id'");
    expect(identity()).toMatchObject({ id: "tui-id", engine: "v2" });
    expect(existsSync(join(home, "kiro-identity/claims/v1/newest"))).toBe(false);
  });

  it("rechecks current siblings after held v2 discovery, before any claim", async () => {
    let release!: (v: any) => void;
    vi.spyOn(sharedKiroV2StoreLane, "read").mockImplementation(() => new Promise(r => { release = r; }));
    let peers: string[] = [];
    const backend = new KiroBackend(config().instanceDir, compat), cfg = config({ kiroUi: "tui", peerWorkingDirectories: () => peers });
    const preparation = backend.prepareLaunch(cfg);
    expect(sharedKiroV2StoreLane.read).toHaveBeenCalledTimes(1);
    peers = [cwd];
    release({ kind: "ok", sessions: [{ id: "tui-id", updatedAt: 200, createdAt: 100 }], diagnostics: { reads: 1, hits: 0 } });
    await preparation; backend.writeConfig(cfg);
    expect(backend.buildCommand(cfg)).not.toContain("--resume");
    expect(existsSync(join(home, "kiro-identity/claims/v2/tui-id"))).toBe(false);
    expect(backend.consumeLaunchWarning() ?? "").toMatch(/shares/);
  });
});

describe("the full configured roster reaches launch admission", () => {
  function fleet(classicRows: Record<string, unknown> = {}): FleetManager {
    writeFileSync(join(home, "classicBot.yaml"), JSON.stringify({ defaults: { backend: "kiro-cli" }, channels: classicRows }));
    const fm = new FleetManager(home);
    fm.fleetConfig = { defaults: { backend: "kiro-cli" }, instances: { worker: { working_directory: cwd } } } as any;
    fm.classicChannels = new ClassicChannelManager(home, fm.logger);
    return fm;
  }
  it("counts stopped fleet and Classic defaults/overrides, excluding unrelated backends; honors reloads", async () => {
    const classicCwd = join(home, "workspaces", "classic"); mkdirSync(classicCwd, { recursive: true });
    const fm = fleet({ room: { channelId: "123", instanceName: "classic", createdBy: "fixture" },
      other: { channelId: "456", instanceName: "claude", backend: "claude-code" } });
    fm.fleetConfig!.instances.sibling = { working_directory: join(root, "fleet-peer") } as any;
    fm.fleetConfig!.instances.other = { backend: "codex", working_directory: join(root, "codex-peer") } as any;
    expect(fm.daemons.size).toBe(0);
    const callbacks: Array<(() => string[]) | undefined> = [];
    const original = Daemon.prototype.setPeerWorkingDirectories;
    vi.spyOn(Daemon.prototype, "setPeerWorkingDirectories").mockImplementation(function (this: Daemon, fn) { callbacks.push(fn); original.call(this, fn); });
    vi.spyOn(Daemon.prototype, "start").mockRejectedValue(new Error("fixture stops BEFORE spawning"));
    await fm.lifecycle.start("worker", fm.fleetConfig!.instances.worker!, false).catch(() => {});
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.()).toEqual([join(root, "fleet-peer"), classicCwd]);
    fm.fleetConfig!.instances.sibling!.working_directory = cwd;
    expect(callbacks[0]?.()).toEqual([cwd, classicCwd]);
    store(); const backend = new KiroBackend(config().instanceDir, compat);
    expect(launch(backend, { peerWorkingDirectories: callbacks[0] })).not.toContain("--resume");
    expect(backend.consumeLaunchWarning() ?? "").toMatch(/shares/);
  });

  it("a fleet cwd alias of a stopped Classic workspace blocks pre-ledger adoption", async () => {
    const classicCwd = join(home, "workspaces", "classic"); mkdirSync(classicCwd, { recursive: true });
    const alias = join(root, "classic-alias"); symlinkSync(classicCwd, alias, "dir"); cwd = alias;
    const fm = fleet({ room: { channelId: "123", instanceName: "classic", backend: "kiro-cli" } });
    const callbacks: Array<(() => string[]) | undefined> = [];
    vi.spyOn(Daemon.prototype, "setPeerWorkingDirectories").mockImplementation(fn => { callbacks.push(fn); });
    vi.spyOn(Daemon.prototype, "start").mockRejectedValue(new Error("fixture stops BEFORE spawning"));
    await fm.lifecycle.start("worker", fm.fleetConfig!.instances.worker!, false).catch(() => {});
    store();
    expect(launch(new KiroBackend(config().instanceDir, compat), { peerWorkingDirectories: callbacks[0] })).not.toContain("--resume");
  });

  it("a Classic instance sees configured fleet peers through the same lazy admission callback", async () => {
    const classicCwd = join(home, "workspaces", "worker"); mkdirSync(classicCwd, { recursive: true }); cwd = classicCwd;
    const fm = fleet({ room: { channelId: "123", instanceName: "worker", backend: "kiro-cli" } });
    fm.fleetConfig!.instances = { fleet: { backend: "kiro-cli", working_directory: cwd } } as any;
    const callbacks: Array<(() => string[]) | undefined> = [];
    vi.spyOn(Daemon.prototype, "setPeerWorkingDirectories").mockImplementation(fn => { callbacks.push(fn); });
    vi.spyOn(Daemon.prototype, "start").mockRejectedValue(new Error("fixture stops BEFORE spawning"));
    await fm.lifecycle.start("worker", { backend: "kiro-cli", working_directory: cwd } as any, false).catch(() => {});
    expect(callbacks[0]?.()).toEqual([cwd]); store();
    expect(launch(new KiroBackend(config().instanceDir, compat), { peerWorkingDirectories: callbacks[0] })).not.toContain("--resume");
  });

  it("the existing lifecycle warning hook records and surfaces the ambiguity notice", () => {
    const fm = fleet(), notify = vi.spyOn(fm, "notifyInstanceTopic").mockReturnValue(true);
    const insert = vi.fn(); (fm as any).eventLog = { insert };
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} });
    fm.lifecycle.attachLaunchWarningHandler("worker", daemon as any);
    store(); const backend = new KiroBackend(config().instanceDir, compat);
    launch(backend, { peerWorkingDirectories: () => [cwd] });
    const message = backend.consumeLaunchWarning();
    expect(typeof message).toBe("string");
    daemon.emit("backend_launch_warning", { message });
    expect(insert).toHaveBeenCalledWith("worker", "backend_launch_warning", { message });
    expect(notify).toHaveBeenCalledWith("worker", expect.stringContaining(message ?? ""));
  });

  it("an incompletely loaded roster fails closed instead of claiming a conversation", async () => {
    const fm = fleet(); fm.classicChannels = null;
    const callbacks: Array<(() => string[]) | undefined> = [];
    vi.spyOn(Daemon.prototype, "setPeerWorkingDirectories").mockImplementation(fn => { callbacks.push(fn); });
    vi.spyOn(Daemon.prototype, "start").mockRejectedValue(new Error("fixture stops BEFORE spawning"));
    await fm.lifecycle.start("worker", fm.fleetConfig!.instances.worker!, false).catch(() => {});
    store(); const backend = new KiroBackend(config().instanceDir, compat);
    expect(launch(backend, { peerWorkingDirectories: callbacks[0] })).not.toContain("--resume");
    expect(backend.consumeLaunchWarning() ?? "").toMatch(/could not verify/);
  });

  it("both locales identify the ambiguity without promising old history was deleted", () => {
    const saved = getLocale();
    try {
      for (const locale of ["en", "zh-TW"] as const) {
        setLocale(locale);
        for (const reason of ["shared_directory", "claimed_conversation", "unknown_peers"]) {
          const key = `kiro.upgrade_${reason}`;
          expect(t(key)).not.toBe(key);
        }
      }
    } finally { setLocale(saved); }
  });
});
