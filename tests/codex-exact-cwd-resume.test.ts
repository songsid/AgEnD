/**
 * #984 F3 phase 3.2: the Codex launch command resumes the exact-cwd session.
 *
 * The shared CODEX_HOME holds a state_5.sqlite built from the real
 * codex-cli 0.157.0 schema; every case calls the production buildCommand.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import type { CliBackend, CliBackendConfig } from "../src/backend/types.js";
import { Daemon } from "../src/daemon.js";
import { EventEmitter } from "node:events";
import { InstanceLifecycle, peerWorkingDirectories, type LifecycleContext } from "../src/instance-lifecycle.js";
import { FleetManager } from "../src/fleet-manager.js";
import { TmuxManager } from "../src/tmux-manager.js";

const SCHEMA = readFileSync(fileURLToPath(new URL("./fixtures/codex-0157-state5-schema.sql", import.meta.url)), "utf8");
const OWN = "019fa7a4-1632-7693-a160-ea92d168a15b";
const SIBLING = "019feff4-3ce1-7c23-a479-538b04b1dada";

let root: string;
let shared: string;
const originalCodexHome = process.env.CODEX_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-codex-exact-"));
  shared = join(root, "shared-codex-home");
  mkdirSync(shared);
  process.env.CODEX_HOME = shared;
});
afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Two git worktrees of one repository, like two AgEnD instances on one project. */
function worktrees(): { a: string; b: string } {
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"]);
  const a = join(root, "wa");
  const b = join(root, "wb");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", a, "-b", "wa"]);
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", b, "-b", "wb"]);
  return { a, b };
}

function writeState(threads: Array<{ id: string; cwd: string; recency: number }>, path = join(shared, "state_5.sqlite")): void {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  // has_user_event 0 + a first message: the shape real 0.157 sessions have (#1017).
  const insert = db.prepare(`
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, has_user_event, first_user_message, archived, recency_at_ms, updated_at_ms)
    VALUES (?, '/r.jsonl', 1, 1, 'cli', 'openai', ?, 't', 'danger-full-access', 'never', 0, 'a question', 0, ?, ?)
  `);
  for (const t of threads) insert.run(t.id, t.cwd, t.recency, t.recency);
  db.close();
}

function launch(workingDirectory: string, extra: Partial<CliBackendConfig> = {}) {
  const backend = new CodexBackend(join(root, "instances", "worker"));
  const cmd = backend.buildCommand({
    workingDirectory, instanceDir: join(root, "instances", "worker"), instanceName: "worker", mcpServers: {}, ...extra,
  });
  return { cmd, warning: backend.consumeLaunchWarning(), again: backend.consumeLaunchWarning() };
}

describe("Codex launch resumes this instance's own session (#984)", () => {
  it("resumes the exact-cwd thread, not the sibling worktree's newer one", () => {
    const { a, b } = worktrees();
    writeState([{ id: OWN, cwd: a, recency: 100 }, { id: SIBLING, cwd: b, recency: 900 }]);
    const { cmd, warning } = launch(a, { peerWorkingDirectories: () => [b] });
    expect(cmd).toContain(` resume '${OWN}' --dangerously-bypass-approvals-and-sandbox`);
    expect(cmd).not.toContain("--last");
    expect(cmd).not.toContain(SIBLING);
    expect(warning).toBeNull();
  });

  it("starts a new instance in a shared repository fresh instead of taking a sibling's session", () => {
    const { a, b } = worktrees();
    writeState([{ id: SIBLING, cwd: b, recency: 900 }]);
    const { cmd, warning } = launch(a, { peerWorkingDirectories: () => [b] });
    expect(cmd).not.toContain(" resume");
    expect(cmd).toContain("codex --dangerously-bypass-approvals-and-sandbox");
    expect(warning).toBeNull();
  });

  it("with an unreadable session DB starts fresh and warns when a sibling shares the repository", () => {
    const { a, b } = worktrees();
    const { cmd, warning, again } = launch(a, { peerWorkingDirectories: () => [b] });
    expect(cmd).not.toContain(" resume");
    expect(warning).toMatch(/could not be read/);
    expect(warning).toMatch(/NEW conversation/);
    expect(again).toBeNull();
  });

  it("with an unreadable session DB falls back to --last and warns when no sibling shares the repository", () => {
    const { a } = worktrees();
    const lone = join(root, "lone");
    mkdirSync(lone);
    const { cmd, warning } = launch(a, { peerWorkingDirectories: () => [lone] });
    expect(cmd).toContain(" resume --last --dangerously-bypass-approvals-and-sandbox");
    expect(warning).toMatch(/fell back to `codex resume --last`/);
  });

  it("with an unreadable session DB and no peer list refuses --last", () => {
    const { a } = worktrees();
    const { cmd, warning } = launch(a);
    expect(cmd).not.toContain(" resume");
    expect(warning).toMatch(/NEW conversation/);
  });

  it("skipResume stays a plain fresh launch and does not look at the session DB", () => {
    const { a } = worktrees();
    writeState([{ id: OWN, cwd: a, recency: 100 }]);
    const { cmd, warning } = launch(a, { skipResume: true, peerWorkingDirectories: () => { throw new Error("not consulted"); } });
    expect(cmd).not.toContain(" resume");
    expect(warning).toBeNull();
  });
});

describe("the daemon surfaces a launch fallback (#984)", () => {
  it("passes the peer list to the backend and emits the backend's launch warning before the window starts", async () => {
    const dir = mkdtempSync(join(root, "daemon-"));
    const daemon = new Daemon("worker", {
      working_directory: dir, backend: "codex", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, join(dir, "instance"), false, undefined, undefined, pino({ level: "silent" }) as any) as any;
    mkdirSync(join(dir, "instance"), { recursive: true });
    const seen: CliBackendConfig[] = [];
    daemon.backend = {
      binaryName: "codex",
      writeConfig: vi.fn(),
      buildCommand: vi.fn((config: CliBackendConfig) => { seen.push(config); return "codex"; }),
      consumeLaunchWarning: vi.fn(() => "session DB unreadable — started fresh"),
    } as unknown as CliBackend;
    daemon.setPeerWorkingDirectories(() => ["/w/sibling"]);
    const warnings: unknown[] = [];
    daemon.on("backend_launch_warning", (event: unknown) => warnings.push(event));
    vi.spyOn(TmuxManager, "ensureSession").mockRejectedValue(new Error("stop after the command is built"));

    await expect(daemon.trySpawnInsideGate()).rejects.toThrow(/stop after the command/);
    expect(seen[0]?.peerWorkingDirectories?.()).toEqual(["/w/sibling"]);
    expect(warnings).toEqual([{ name: "worker", message: "session DB unreadable — started fresh" }]);
  });
});

describe("the lifecycle feeds peers and notifies the operator (#984)", () => {
  it("lists only the OTHER instances on the same backend that have a working directory", () => {
    const fleet = {
      defaults: { backend: "codex" },
      instances: {
        self: { working_directory: "/w/self" },
        sibling: { working_directory: "/w/sibling" },
        explicit: { backend: "codex", working_directory: "/w/explicit" },
        claude: { backend: "claude-code", working_directory: "/w/claude" },
        nowhere: { backend: "codex" },
      },
    } as any;
    expect(peerWorkingDirectories(fleet, "self", "codex")).toEqual(["/w/sibling", "/w/explicit"]);
    expect(peerWorkingDirectories(null, "self", "codex")).toEqual([]);
  });

  it("posts a launch fallback to the instance topic and records it", () => {
    const notifyInstanceTopic = vi.fn(() => true);
    const eventLogInsert = vi.fn();
    const lifecycle = new InstanceLifecycle({
      fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      eventLog: { insert: eventLogInsert },
      isPlannedRestart: () => false,
      notifyInstanceTopic,
      webhookEmit() {}, clearCancelButton() {}, checkModelFailover() {}, setTopicIcon() {},
      restartSingleInstance: vi.fn(async () => {}),
    } as unknown as LifecycleContext);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} });
    lifecycle.attachLaunchWarningHandler("worker", daemon as any);

    daemon.emit("backend_launch_warning", { name: "worker", message: "started a NEW conversation" });

    expect(eventLogInsert).toHaveBeenCalledWith("worker", "backend_launch_warning", { message: "started a NEW conversation" });
    expect(notifyInstanceTopic).toHaveBeenCalledWith("worker", expect.stringMatching(/worker.*started a NEW conversation/));
  });
});

describe("lifecycle.start hands the peer list to the daemon it creates (#984)", () => {
  it("wires the fleet's other codex instances' directories before the daemon starts", async () => {
    const self = join(root, "self");
    const sibling = join(root, "sibling");
    mkdirSync(self);
    const fm = new FleetManager(join(root, "fleet"));
    const worker = { backend: "codex", working_directory: self } as any;
    (fm as any).fleetConfig = {
      defaults: {},
      instances: { worker, sibling: { backend: "codex", working_directory: sibling }, other: { backend: "claude-code", working_directory: "/w/claude" } },
    };
    const peers: Array<(() => string[]) | undefined> = [];
    const setPeers = Daemon.prototype.setPeerWorkingDirectories;
    vi.spyOn(Daemon.prototype, "setPeerWorkingDirectories").mockImplementation(function (this: Daemon, fn) {
      peers.push(fn);
      setPeers.call(this, fn);
    });
    vi.spyOn(Daemon.prototype, "start").mockRejectedValue(new Error("stop before spawning"));

    await fm.lifecycle.start("worker", worker, false).catch(() => {});

    expect(peers).toHaveLength(1);
    expect(peers[0]?.()).toEqual([sibling]);
  });
});

describe("a launch warning from the FIRST spawn reaches the operator (#984)", () => {
  it.each([false, true])("is recorded and posted when Daemon.start emits it (planned restart: %s)", async (planned) => {
    const self = join(root, "self");
    mkdirSync(self);
    const fm = new FleetManager(join(root, "fleet"));
    const worker = { backend: "codex", working_directory: self } as any;
    (fm as any).fleetConfig = { defaults: {}, instances: { worker } };
    const eventLogInsert = vi.fn();
    (fm as any).eventLog = { insert: eventLogInsert };
    const notifyInstanceTopic = vi.spyOn(fm as any, "notifyInstanceTopic").mockReturnValue(true);
    vi.spyOn(fm as any, "isPlannedRestart").mockReturnValue(planned);
    // Exactly where production emits it: synchronously inside Daemon.start's
    // first spawn, before lifecycle.start has attached its incident handlers.
    vi.spyOn(Daemon.prototype, "start").mockImplementation(async function (this: Daemon) {
      this.emit("backend_launch_warning", { name: "worker", message: "session DB unreadable — started a NEW conversation" });
      throw new Error("stop after the first spawn");
    });

    await fm.lifecycle.start("worker", worker, false).catch(() => {});

    expect(eventLogInsert).toHaveBeenCalledWith("worker", "backend_launch_warning",
      { message: "session DB unreadable — started a NEW conversation" });
    expect(notifyInstanceTopic).toHaveBeenCalledWith("worker", expect.stringContaining("started a NEW conversation"));
  });
});

describe("the lookup reads the state DB Codex actually writes (#1028)", () => {
  const savedAgendHome = process.env.AGEND_HOME;
  beforeEach(() => { process.env.AGEND_HOME = join(root, "agend"); });
  afterEach(() => { if (savedAgendHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedAgendHome; });

  /** An instance whose CODEX_HOME exists, as after its first launch. */
  function instance() {
    const instanceDir = join(root, "agend", "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    const backend = new CodexBackend(instanceDir);
    const home = (backend as unknown as { isolatedCodexHome: string }).isolatedCodexHome;
    mkdirSync(home, { recursive: true });
    const build = (workingDirectory: string, peers: string[]) => {
      const cmd = backend.buildCommand({ workingDirectory, instanceDir, instanceName: "worker", mcpServers: {}, peerWorkingDirectories: () => peers });
      return { cmd, warning: backend.consumeLaunchWarning() };
    };
    return { backend, home, instanceDir, build };
  }

  it("resumes from a private DB in the instance home when the shared home has none", () => {
    // The shared home had no state DB at the instance's first launch, so
    // Codex created its own in the instance home — and has used it since.
    const { a, b } = worktrees();
    const { home, build } = instance();
    writeState([{ id: OWN, cwd: a, recency: 100 }], join(home, "state_5.sqlite"));
    const { cmd, warning } = build(a, [b]);
    expect(cmd).toContain(` resume '${OWN}' `);
    expect(cmd).not.toContain("--last");
    expect(warning).toBeNull();
  });

  it("prefers the instance's own DB over the shared one: only its threads can be resumed from that home", () => {
    const { a, b } = worktrees();
    const { home, build } = instance();
    writeState([{ id: OWN, cwd: a, recency: 100 }], join(home, "state_5.sqlite"));
    writeState([{ id: SIBLING, cwd: a, recency: 900 }]); // newer, but in a DB this home does not use
    const { cmd } = build(a, [b]);
    expect(cmd).toContain(` resume '${OWN}' `);
    expect(cmd).not.toContain(SIBLING);
  });

  it("follows the usual link to the shared DB", () => {
    const { a, b } = worktrees();
    writeState([{ id: OWN, cwd: a, recency: 100 }]);
    const { backend, instanceDir, build } = instance();
    backend.writeConfig({ workingDirectory: a, instanceDir, instanceName: "worker", mcpServers: {} });
    const { cmd, warning } = build(a, [b]);
    expect(cmd).toContain(` resume '${OWN}' `);
    expect(warning).toBeNull();
  });

  it.each([
    ["a row for the same working directory", true],
    ["no row for it", false],
  ] as const)("a private DB that exists but cannot be read stays unreadable even when the shared DB has %s", (_label, sharedHasRow) => {
    // The shared file is not what this home resumes from: answering from it
    // would silently resume a session this CODEX_HOME cannot see, or
    // silently start fresh without the warning.
    const { a, b } = worktrees();
    const { home, build } = instance();
    writeFileSync(join(home, "state_5.sqlite"), "this is not a SQLite database");
    writeState(sharedHasRow ? [{ id: SIBLING, cwd: a, recency: 900 }] : [{ id: SIBLING, cwd: b, recency: 900 }]);
    const { cmd, warning } = build(a, [b]);
    expect(cmd).not.toContain(" resume '");
    expect(cmd).not.toContain(SIBLING);
    expect(warning).toMatch(/could not be read/);
  });

  it("a private DB with a schema this code does not know stays unreadable too", () => {
    const { a, b } = worktrees();
    const { home, build } = instance();
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT)"); // drifted schema
    db.close();
    writeState([{ id: SIBLING, cwd: a, recency: 900 }]);
    const { cmd, warning } = build(a, [b]);
    expect(cmd).not.toContain(SIBLING);
    expect(warning).toMatch(/could not be read/);
  });

  it("with no DB in either home stays unreadable and keeps the warned fallback", () => {
    const { a, b } = worktrees();
    const { build } = instance();
    const { cmd, warning } = build(a, [b]);
    expect(cmd).not.toContain(" resume");
    expect(warning).toMatch(/could not be read/);
  });
});
