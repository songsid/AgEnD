/**
 * #984 F3 phase 3.3: the real Codex CLI resumes the instance's OWN session.
 *
 * Opt-in (`AGEND_CODEX_E2E=1`, a codex-cli from SUPPORTED_CODEX on PATH). It reproduces the
 * incident with nothing shared with the operator's setup except the login:
 * a throwaway AGEND_HOME and shared CODEX_HOME, one git repo with worktrees A
 * and B, and a synthetic thread in each — B's newer, which is exactly what
 * made `codex resume --last` in A pick B's session. The production backend
 * writes A's config and builds A's launch command; the real CLI runs on a
 * private tmux socket. No prompt is ever sent, so no model turn is spent.
 *
 * Login: `AGEND_CODEX_E2E_AUTH` (default ~/.codex/auth.json) is SYMLINKED,
 * never copied — a copied refresh token that rotates would log out the real
 * one. Resuming a thread does not call the model.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const AUTH = process.env.AGEND_CODEX_E2E_AUTH || join(homedir(), ".codex", "auth.json");

function codexVersion(): string | null {
  try {
    return execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}
const version = process.env.AGEND_CODEX_E2E === "1" ? codexVersion() : null;
/** Codex versions this real-CLI test is run against before AgEnD claims support. */
const SUPPORTED_CODEX = /\b0\.(?:155|156|157|158|159)\.\d+\b/;
const enabled = !!version && SUPPORTED_CODEX.test(version) && existsSync(AUTH);

const SCHEMA = readFileSync(fileURLToPath(new URL("./fixtures/codex-0157-state5-schema.sql", import.meta.url)), "utf8");
const MIGRATIONS = readFileSync(fileURLToPath(new URL("./fixtures/codex-0157-state5-migrations.sql", import.meta.url)), "utf8");
const A_ID = "019fa7a4-0000-7000-8000-00000000a984";
const B_ID = "019feff4-0000-7000-8000-00000000b984";
const A_MARK = "E2E-OWN-THREAD-A984";
const B_MARK = "E2E-SIBLING-THREAD-B984";

let root = "";
let socket = "";
const saved = { AGEND_HOME: process.env.AGEND_HOME, CODEX_HOME: process.env.CODEX_HOME };

/** A minimal rollout Codex 0.157 renders on resume: one user turn, one answer. */
function writeRollout(shared: string, id: string, cwd: string, mark: string, at: string): string {
  const dir = join(shared, "sessions", "2026", "09", "29");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${at.replace(/[:.]/g, "-")}-${id}.jsonl`);
  const turn = `turn-${id.slice(-4)}`;
  const lines = [
    { type: "session_meta", payload: { session_id: id, id, timestamp: at, cwd, originator: "codex-tui", cli_version: "0.157.0", source: "cli", thread_source: "user", model_provider: "openai" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `question ${mark}` }] } },
    { type: "event_msg", payload: { type: "user_message", message: `question ${mark}`, images: [] } },
    { type: "event_msg", payload: { type: "agent_message", message: `answer ${mark}` } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${mark}` }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: `answer ${mark}` } },
  ].map(line => JSON.stringify({ timestamp: at, ...line }));
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function writeState(shared: string, rows: Array<{ id: string; cwd: string; rollout: string; mark: string; recency: number }>): void {
  const db = new Database(join(shared, "state_5.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  db.exec(MIGRATIONS);
  // has_user_event 0 with a first message: what real 0.157 sessions carry (#1017).
  const insert = db.prepare(`
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, has_user_event, archived, cli_version, first_user_message, preview,
      recency_at, recency_at_ms, updated_at_ms, created_at_ms)
    VALUES (@id, @rollout, @s, @s, 'cli', 'openai', @cwd, @title, 'danger-full-access', 'never', 0, 0,
      '0.157.0', @title, @title, @s, @recency, @recency, @recency)
  `);
  for (const r of rows) {
    insert.run({ id: r.id, rollout: r.rollout, cwd: r.cwd, title: `question ${r.mark}`, s: Math.floor(r.recency / 1000), recency: r.recency });
  }
  db.close();
}

/**
 * A synthetic thread has no token usage yet, so the footer carries only the
 * warning badge and no Context item — the same shape as the post-fork screen.
 * The daemon accepts it through #978's stable unknown-layout proof.
 */
function isIdle(backend: { getReadyPattern(): RegExp; getBusyPattern(): RegExp; isStableUnknownLayoutIdlePane(p: string): boolean }, pane: string): boolean {
  if (backend.getBusyPattern().test(pane)) return false;
  return backend.getReadyPattern().test(pane) || backend.isStableUnknownLayoutIdlePane(pane);
}

const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 10_000 });

describe.skipIf(!enabled)("real codex 0.157: an instance in a git worktree resumes its own session (#984)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agend-codex-e2e-984-"));
    socket = `agend-e2e-984-${process.pid}`;
    process.env.AGEND_HOME = join(root, "agend");
    process.env.CODEX_HOME = join(root, "shared-codex-home");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    symlinkSync(AUTH, join(process.env.CODEX_HOME, "auth.json"));
  });
  afterAll(() => {
    try { tmux("kill-server"); } catch { /* not started */ }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("launches `resume <A's id>` and reaches A's ready composer with no picker and no lock screen", async () => {
    const { CodexBackend } = await import("../src/backend/codex.js");
    const shared = process.env.CODEX_HOME!;
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.email=e2e@agend", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init"]);
    const a = join(root, "worktree-a");
    const b = join(root, "worktree-b");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", a, "-b", "wa"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", b, "-b", "wb"]);
    const now = Date.now();
    writeState(shared, [
      { id: A_ID, cwd: a, mark: A_MARK, recency: now - 3_600_000, rollout: writeRollout(shared, A_ID, a, A_MARK, new Date(now - 3_600_000).toISOString()) },
      { id: B_ID, cwd: b, mark: B_MARK, recency: now, rollout: writeRollout(shared, B_ID, b, B_MARK, new Date(now).toISOString()) },
    ]);

    const instanceDir = join(root, "agend", "instances", "worker-a");
    mkdirSync(instanceDir, { recursive: true });
    const backend = new CodexBackend(instanceDir);
    const config = { workingDirectory: a, instanceDir, instanceName: "worker-a", mcpServers: {}, peerWorkingDirectories: () => [b] };
    backend.writeConfig(config);
    backend.preTrust(a);
    const cmd = backend.buildCommand(config);
    expect(cmd).toContain(` resume '${A_ID}' `);
    expect(cmd).not.toContain("--last");
    expect(backend.consumeLaunchWarning()).toBeNull();

    tmux("new-session", "-d", "-s", "e2e", "-x", "120", "-y", "36", "-c", a, `${cmd}; sleep 600`);
    const dialogs = backend.getRuntimeDialogs();
    let pane = "";
    // Every frame that shows the resume-loading status must hold input: the
    // composer is already drawn but not live (0.154 swallowed Enter here), and
    // a header redesign (0.159 dropped the box) silently disabled the guard.
    const loadingFrames: Array<{ pane: string; held: boolean }> = [];
    const transients = backend.getInputUnavailableTransients();
    const deadline = Date.now() + 45_000;
    for (;;) {
      pane = tmux("capture-pane", "-p", "-t", "e2e");
      const held = dialogs.filter(d => d.holdOnly && (d.isActive ? d.isActive(pane) : d.pattern.test(pane)));
      const ready = isIdle(backend, pane);
      if ((ready && pane.includes(A_MARK)) || held.length > 0 || Date.now() > deadline) break;
      if (/^ {2}Resuming session…\s*$/m.test(pane)) {
        loadingFrames.push({ pane, held: transients.some(t => (t.isActive ? t.isActive(pane) : t.pattern.test(pane))) });
      }
      await new Promise(r => setTimeout(r, 50));
    }

    expect(loadingFrames.length, "no resume-loading frame was observed").toBeGreaterThan(0);
    const unheld = loadingFrames.find(f => !f.held);
    expect(unheld?.pane ?? null, "a resume-loading frame did not hold input").toBeNull();
    expect(pane, pane).toContain(A_MARK);
    expect(pane, pane).not.toContain(B_MARK);
    expect(pane, pane).not.toMatch(/Working directory · resume/);
    expect(pane, pane).not.toMatch(/open in another app/);
    expect(isIdle(backend, pane), pane).toBe(true);
  }, 90_000);
});

/** #1034: exercise the real daemon path, plus the embedded --no-daemon control. */
// Every SUPPORTED_CODEX version, not 0.157 alone: the fleet runs 0.159 and the
// daemon path must be proven on what it runs (verified on 0.159.2).
describe.skipIf(!enabled)("real codex: private app-server runtime directories (#1034)", () => {
  const runtimeDirs = ["app-server-daemon", "app-server-control"] as const;
  let runtimeRoot = "";
  let privateHome = "";

  beforeEach(() => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "agend-1034-e2e-"));
    privateHome = "";
    socket = `agend-e2e-1034-${process.pid}`;
    process.env.AGEND_HOME = join(runtimeRoot, "agend");
    process.env.CODEX_HOME = join(runtimeRoot, "shared");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    symlinkSync(AUTH, join(process.env.CODEX_HOME, "auth.json"));
    writeFileSync(join(process.env.CODEX_HOME, "config.toml"), "[features]\ndaemon_auto_start = true\n");
    for (const name of runtimeDirs) {
      mkdirSync(join(process.env.CODEX_HOME, name), { mode: 0o700 });
      writeFileSync(join(process.env.CODEX_HOME, name, "source-marker"), name);
    }
  });

  afterEach(() => {
    try { tmux("kill-server"); } catch { /* not started */ }
    // Kill only the daemon scoped to this test's private home, never the user's.
    if (privateHome && existsSync(join(privateHome, "app-server-daemon"))
      && !lstatSync(join(privateHome, "app-server-daemon")).isSymbolicLink()) {
      try {
        // The CLI normally grants 60s on stop. This throwaway daemon has no
        // model turn to preserve; use its supported setting for bounded cleanup.
        const settingsPath = join(privateHome, "app-server-daemon", "settings.json");
        let settings = {};
        try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* defaults */ }
        writeFileSync(settingsPath, JSON.stringify({ ...settings, shutdownGraceSeconds: 0 }), { mode: 0o600 });
        execFileSync("codex", ["app-server", "daemon", "stop"], {
          env: { ...process.env, CODEX_HOME: privateHome }, timeout: 15_000, stdio: "ignore",
        });
      } catch { /* no daemon if the TUI failed before auto-start */ }
      // `daemon stop` leaves the updater running. Verify this test's managed
      // executable before terminating either remaining PID from its records.
      for (const name of ["daemon.pid", "daemon-updater.pid"]) {
        let pid: number;
        try { pid = JSON.parse(readFileSync(join(privateHome, "app-server-daemon", name), "utf8")).pid; }
        catch { continue; }
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        let command: string;
        try { command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 }).trim(); }
        catch { continue; } // already exited
        expect(command.startsWith(join(privateHome, "packages") + "/"), command).toBe(true);
        try { process.kill(pid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (runtimeRoot) rmSync(runtimeRoot, { recursive: true, force: true });
  }, 30_000);

  it.each(["fresh", "legacy-links", "no-daemon", "unfixed-links", "unfixed-no-daemon"] as const)("checks resume with %s and leaves shared runtime contents intact", async mode => {
    const { CodexBackend } = await import("../src/backend/codex.js");
    const shared = process.env.CODEX_HOME!;
    const cwd = join(runtimeRoot, "repo");
    execFileSync("git", ["init", "-q", cwd]);
    const id = "019fa7a4-0000-7000-8000-000000001034";
    const mark = "E2E-RESUMED-THREAD-1034";
    const now = Date.now();
    writeState(shared, [{ id, cwd, mark, recency: now, rollout: writeRollout(shared, id, cwd, mark, new Date(now).toISOString()) }]);
    const instanceDir = join(runtimeRoot, "agend", "instances", "runtime-worker-t1503382598640996543");
    mkdirSync(instanceDir, { recursive: true });
    if (mode === "legacy-links") {
      const legacy = join(instanceDir, "codex-home");
      mkdirSync(legacy);
      for (const name of runtimeDirs) symlinkSync(join(shared, name), join(legacy, name), "dir");
    }
    const backend = new CodexBackend(instanceDir);
    privateHome = CodexBackend.shortHomeFor(instanceDir);
    const config = { workingDirectory: cwd, instanceDir, instanceName: "runtime-worker", mcpServers: {} };
    backend.writeConfig(config);
    backend.preTrust(cwd);
    for (const name of runtimeDirs) expect(() => lstatSync(join(privateHome, name))).toThrow(/ENOENT/);
    if (mode.startsWith("unfixed-")) {
      // Positive control: recreate the old mirror pass's links AFTER preparation.
      for (const name of runtimeDirs) symlinkSync(join(shared, name), join(privateHome, name), "dir");
    }
    // 0.157 excludes daemon auto-start for these CLI overrides (its
    // daemon_startup::config_exclusion). The private config already disables
    // update checks. Omit the overrides here to exercise a managed daemon.
    const command = backend.buildCommand(config)
      .replace(" -c check_for_update_on_startup=false", "")
      .replace(" -c features.instant_interrupt=false", "")
      + (mode.includes("no-daemon") ? " --no-daemon" : "");
    expect(command).toContain(` resume '${id}' `);
    tmux("new-session", "-d", "-s", "e2e", "-x", "120", "-y", "36", "-c", cwd, `${command}; sleep 600`);
    let pane = "";
    const socketDirError = /socket\s+directory path exists and is not a directory/;
    const deadline = Date.now() + 45_000;
    for (;;) {
      pane = tmux("capture-pane", "-p", "-t", "e2e");
      if ((isIdle(backend, pane) && pane.includes(mark))
        || socketDirError.test(pane) || Date.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const name of runtimeDirs) {
      expect(lstatSync(join(shared, name)).isDirectory()).toBe(true);
      expect(readFileSync(join(shared, name, "source-marker"), "utf8")).toBe(name);
      expect(readdirSync(join(shared, name))).toEqual(["source-marker"]);
    }
    if (mode === "unfixed-links") {
      expect(pane, pane).toMatch(socketDirError);
      expect(pane, pane).not.toContain(mark);
      return;
    }
    expect(pane, pane).not.toMatch(socketDirError);
    expect(pane, pane).toContain(mark);
    expect(isIdle(backend, pane), pane).toBe(true);
    if (!mode.includes("no-daemon")) {
      for (const name of runtimeDirs) {
        expect(lstatSync(join(privateHome, name)).isSymbolicLink()).toBe(false);
        expect(lstatSync(join(privateHome, name)).isDirectory()).toBe(true);
      }
      const daemonVersion = JSON.parse(execFileSync("codex", ["app-server", "daemon", "version"], {
        env: { ...process.env, CODEX_HOME: privateHome }, encoding: "utf8", timeout: 10_000,
      }));
      // The managed daemon is the CLI under test, whichever supported version.
      expect(daemonVersion.appServerVersion).toBe(version!.match(/\d+\.\d+\.\d+/)![0]);
    }
  }, 90_000);
});
