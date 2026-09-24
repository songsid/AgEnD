import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackend, attachCodexSession, codexResumeClaimCommand, codexResumeDirectoryPromptState, codexResumeDirectoryVisible, codexResumeLockActive, codexResumeLockVisible } from "../src/backend/codex.js";
import { codexSessionForPane, codexSessionOwners, type CodexSessionRecord } from "../src/backend/codex-session.js";
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { InstanceLifecycle } from "../src/instance-lifecycle.js";

const SESSION = "01a0d2a2-325b-7d61-be56-f23c0470c199";
const dirs: string[] = [];
const originalHome = process.env.CODEX_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-resume-"));
  dirs.push(dir);
  const shared = join(dir, "shared");
  const instance = join(dir, "instance-a");
  const cwd = join(dir, "project");
  const proc = join(dir, "proc");
  const rollout = join(shared, "sessions", "2026", "09", "24", `rollout-${SESSION}.jsonl`);
  mkdirSync(join(shared, "sessions", "2026", "09", "24"), { recursive: true });
  mkdirSync(instance); mkdirSync(cwd); mkdirSync(proc);
  writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd } }) + "\nprivate transcript that must not be parsed\n");
  process.env.CODEX_HOME = shared;
  const record: CodexSessionRecord = { id: SESSION, owner: "instance-a", cwd, rolloutPath: rollout };
  return { dir, shared, instance, cwd, proc, rollout, record, backend: new CodexBackend(instance, proc) };
}

function processFixture(proc: string, pid: number, group: number, paths: string[]) {
  const path = join(proc, String(pid));
  mkdirSync(join(path, "fd"), { recursive: true });
  writeFileSync(join(path, "stat"), `${pid} (codex) S 1 ${group} ${group} 0 0 0 0\n`);
  paths.forEach((target, i) => symlinkSync(target, join(path, "fd", String(i))));
}

function persist({ instance, record }: ReturnType<typeof fixture>) {
  writeFileSync(join(instance, "session-id"), record.id);
  writeFileSync(join(instance, "codex-session.json"), JSON.stringify(record));
}

const config = (f: ReturnType<typeof fixture>) => ({
  workingDirectory: f.cwd, instanceDir: f.instance, instanceName: "instance-a", mcpServers: {},
});

describe("Codex explicit session identity", () => {
  it("never uses --last without an instance-owned session record", () => {
    const f = fixture();
    const command = f.backend.buildCommand(config(f));
    expect(command).not.toContain("resume --last");
    expect(command).not.toContain(" resume ");
    expect(f.backend.canResume(f.cwd)).toBe(false);
  });

  it("resumes only the exact UUID from a validated record and holds a cross-daemon claim", () => {
    const f = fixture(); persist(f);
    const command = f.backend.buildCommand(config(f));
    expect(command).toContain("codex resume");
    expect(command).toContain(SESSION);
    expect(command).not.toContain("--last");
    expect(command).toContain("flock -n -E 75");
    expect(command).toContain("[agend:codex-session-held]");
    expect(f.backend.canResume(f.cwd)).toBe(true);
    writeFileSync(join(f.instance, "session-id"), "other");
    expect(f.backend.canResume(f.cwd)).toBe(false);
  });

  it("uses a nonblocking OS claim on both supported platforms", () => {
    const path = "/tmp/agend-session-claim-test.lock";
    const linux = codexResumeClaimCommand("linux", path, "exit 0");
    const mac = codexResumeClaimCommand("darwin", path, "exit 0");
    expect(linux).toContain("flock -n -E 75");
    expect(mac).toContain("lockf -s -t 0 -k -w");
    for (const command of [linux, mac]) {
      expect(command).toContain("[agend:codex-session-held]");
      expect(command).toContain("agend_child_status");
    }
  });

  it.skipIf(process.platform !== "linux")("accepts the daemon environment prefix as a real shell command", () => {
    const f = fixture();
    const launch = codexResumeClaimCommand("linux", join(f.dir, "claim.lock"), "printf AGEND_READY");
    const prefixed = `TERM=xterm-256color AGEND_INSTANCE_NAME='instance-a' AGEND_HOME='${f.dir}' ${launch}`;
    const result = spawnSync("sh", ["-c", prefixed], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("AGEND_READY");
    expect(result.stderr).not.toContain("syntax error");
  });

  it.skipIf(process.platform !== "linux" || spawnSync("tmux", ["-V"]).status !== 0)(
    "starts an explicit resume through the daemon command builder and a real tmux pane", async () => {
      const f = fixture(); persist(f);
      const socketName = `agend913-${process.pid}-${Date.now()}`;
      const session = `agend913-${process.pid}`;
      const fakeCodex = join(f.dir, "fake-codex");
      writeFileSync(fakeCodex, "#!/bin/sh\nprintf 'AGEND_READY\\n'\nsleep 5\n", { mode: 0o755 });
      (f.backend as any).binaryPath = fakeCodex;
      vi.spyOn(f.backend, "getReadyPattern").mockReturnValue(/AGEND_READY/);
      const logger = { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as any;
      const control = { registerWindow: async () => {}, waitForOutput: async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return false;
      } } as any;
      const daemon = new Daemon("instance-a", {
        working_directory: f.cwd, backend: "codex", log_level: "silent",
        restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
        context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      } as any, f.instance, false, f.backend, control, logger);
      TmuxManager.setSocketName(socketName);
      (daemon as any).tmuxSessionName = session;
      (daemon as any).tmux = new TmuxManager(session, "");
      try {
        expect(await (daemon as any).trySpawnInsideGate(false, 2_000)).toBe(true);
        const pane = await (daemon as any).tmux.capturePane();
        expect(pane).toContain("AGEND_READY");
        expect(pane).not.toContain("syntax error");
      } finally {
        await TmuxManager.killSession(session).catch(() => {});
        TmuxManager.setSocketName(null);
      }
    },
  );

  it("checkpoints the replacement pane after a wake and resumes its new UUID", async () => {
    const f = fixture(); persist(f);
    const nextId = "01a0d2a2-325b-7d61-be56-f23c0470c200";
    const nextRollout = join(f.shared, "sessions", "2026", "09", "24", `rollout-${nextId}.jsonl`);
    writeFileSync(nextRollout, JSON.stringify({ type: "session_meta", payload: { id: nextId, cwd: f.cwd } }) + "\n");
    const lock = join(f.shared, "thread-writer-locks", `${nextId}.lock`);
    mkdirSync(join(f.shared, "thread-writer-locks"), { recursive: true });
    writeFileSync(lock, "");
    processFixture(f.proc, 4422, 888, [lock, nextRollout]);
    f.backend.setActivePanePid(777); // the pane that was paused is gone
    const logger = { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as any;
    const daemon = new Daemon("instance-a", {
      working_directory: f.cwd, backend: "codex", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, f.instance, false, f.backend, undefined, logger);
    (daemon as any).tmux = { getWindowId: () => "@wake" };
    vi.spyOn(daemon as any, "trySpawnInsideGate").mockResolvedValue(true);
    vi.spyOn(daemon as any, "resumeRuntimeMonitors").mockImplementation(() => {});
    (daemon as any).pauseWakeState = "paused";
    (daemon as any).autoPauseController.markPaused();
    const panePid = vi.spyOn(TmuxManager, "getPanePid").mockResolvedValue(888);
    try {
      await daemon.wake(1_000);
      expect(daemon.isPaused).toBe(false);
      expect(panePid).toHaveBeenCalled();
      expect(readFileSync(join(f.instance, "session-id"), "utf8")).toBe(nextId);
      expect(f.backend.buildCommand(config(f))).toContain("codex resume");
      expect(f.backend.buildCommand(config(f))).toContain(nextId);
      expect(f.backend.buildCommand(config(f))).not.toContain(SESSION);
    } finally { panePid.mockRestore(); }
  });

  it.skipIf(process.platform !== "linux")("atomically refuses a second concurrent resumer", async () => {
    const f = fixture();
    const lock = join(f.dir, "claim.lock");
    const ready = join(f.dir, "claim-ready");
    const holder = spawn("flock", ["-n", lock, "sh", "-c", `touch '${ready}'; sleep 0.4`], { stdio: "ignore" });
    try {
      for (let n = 0; n < 40 && !existsSync(ready); n++) await new Promise(r => setTimeout(r, 10));
      expect(existsSync(ready)).toBe(true);
      const second = spawnSync("sh", ["-c", codexResumeClaimCommand("linux", lock, "exit 0")], { encoding: "utf8" });
      expect(second.status).toBe(75);
      expect(second.stdout).toContain("[agend:codex-session-held]");
    } finally {
      if (holder.exitCode === null) await new Promise<void>(resolve => holder.once("exit", () => resolve()));
    }
  });

  it.skipIf(process.platform !== "darwin")("smoke-tests macOS lockf contention and ps/lsof live-owner release", async () => {
    const f = fixture();
    const claim = join(f.dir, "claim.lock");
    const ready = join(f.dir, "ready");
    const holder = spawn("sh", ["-c", codexResumeClaimCommand("darwin", claim,
      `touch '${ready}'; sleep 2`)], { stdio: "ignore" });
    try {
      for (let n = 0; n < 50 && !existsSync(ready); n++) await new Promise(r => setTimeout(r, 20));
      expect(existsSync(ready)).toBe(true);
      expect(spawnSync("sh", ["-c", codexResumeClaimCommand("darwin", claim, "true")]).status).toBe(75);
    } finally {
      if (holder.exitCode === null) await new Promise<void>(resolve => holder.once("exit", () => resolve()));
    }
    expect(spawnSync("sh", ["-c", codexResumeClaimCommand("darwin", claim, "true")]).status).toBe(0);

    const fakeCodex = join(f.dir, "codex");
    const writerLock = join(f.dir, `${SESSION}.lock`);
    writeFileSync(writerLock, "");
    copyFileSync("/bin/sleep", fakeCodex); chmodSync(fakeCodex, 0o755);
    const rolloutFd = openSync(f.rollout, "r");
    const lockFd = openSync(writerLock, "r");
    const owner = spawn(fakeCodex, ["2"], { stdio: ["ignore", "ignore", "ignore", rolloutFd, lockFd] });
    closeSync(rolloutFd); closeSync(lockFd);
    try {
      let seen = false;
      for (let n = 0; n < 30 && !seen; n++) {
        seen = codexSessionOwners(SESSION).includes(owner.pid!);
        if (!seen) await new Promise(r => setTimeout(r, 30));
      }
      expect(seen).toBe(true);
    } finally {
      if (owner.exitCode === null) {
        owner.kill();
        await new Promise<void>(resolve => owner.once("exit", () => resolve()));
      }
    }
    expect(codexSessionOwners(SESSION)).not.toContain(owner.pid);
  });

  it("rejects a copied owner record or a rollout whose metadata was changed", () => {
    const f = fixture(); persist(f);
    writeFileSync(join(f.instance, "codex-session.json"), JSON.stringify({ ...f.record, owner: "instance-b" }));
    expect(f.backend.canResume(f.cwd)).toBe(false);
    persist(f);
    writeFileSync(f.rollout, JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: "/other/project" } }) + "\n");
    expect(f.backend.canResume(f.cwd)).toBe(false);
  });

  it("holds an owned UUID when the rollout format becomes unknown, without overwriting identity", async () => {
    const f = fixture(); persist(f);
    const original = readFileSync(join(f.instance, "codex-session.json"), "utf8");
    writeFileSync(f.rollout, JSON.stringify({ type: "session_meta_vNext", payload: { id: SESSION, cwd: f.cwd } }) + "\n");
    expect(f.backend.hasSessionIdentity()).toBe(true);
    expect(f.backend.hasInvalidSessionIdentity(f.cwd)).toBe(true);
    expect(f.backend.canResume(f.cwd)).toBe(false);
    expect(() => f.backend.buildCommand(config(f))).toThrow("identity could not be verified");
    expect(() => f.backend.buildCommand({ ...config(f), skipResume: true })).toThrow("identity could not be verified");
    writeFileSync(join(f.instance, "window-id"), "@old");
    const logger = { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), warn: vi.fn() } as any;
    const daemon = new Daemon("instance-a", {
      working_directory: f.cwd, backend: "codex", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, f.instance, false, f.backend, undefined, logger);
    await expect(InstanceLifecycle.startOrDispose(daemon, "instance-a", logger)).rejects.toThrow("identity could not be verified");
    expect(readFileSync(join(f.instance, "window-id"), "utf8")).toBe("@old");
    expect(readFileSync(join(f.instance, "codex-session.json"), "utf8")).toBe(original);
    expect(readFileSync(join(f.instance, "session-id"), "utf8")).toBe(SESSION);
  });

  it("discovers the actual pane's lock+rollout, not the latest session by CWD", () => {
    const f = fixture();
    const lock = join(f.dir, "codex-home", "thread-writer-locks", `${SESSION}.lock`);
    mkdirSync(join(f.dir, "codex-home", "thread-writer-locks"), { recursive: true });
    writeFileSync(lock, "");
    processFixture(f.proc, 4411, 777, [lock, f.rollout]);
    processFixture(f.proc, 5522, 888, [lock]); // another process can share the same CWD
    expect(codexSessionForPane(777, f.shared, f.proc)).toEqual({ id: SESSION, cwd: f.cwd, rolloutPath: f.rollout });
    expect(codexSessionForPane(888, f.shared, f.proc)).toBeNull();
    expect(codexSessionOwners(SESSION, f.proc)).toEqual([4411, 5522]);
    f.backend.setActivePanePid(777);
    expect(f.backend.getSessionId()).toBe(SESSION);
    expect(JSON.parse(readFileSync(join(f.instance, "codex-session.json"), "utf8"))).toEqual(f.record);
  });

  it("refuses ambiguous old and new writer-lock pairs instead of choosing fd order", () => {
    const f = fixture();
    const second = "01a0d2a2-325b-7d61-be56-f23c0470c200";
    const secondRollout = join(f.shared, "sessions", "2026", "09", "24", `rollout-${second}.jsonl`);
    writeFileSync(secondRollout, JSON.stringify({ type: "session_meta", payload: { id: second, cwd: f.cwd } }) + "\n");
    const firstLock = join(f.dir, `${SESSION}.lock`);
    const secondLock = join(f.dir, `${second}.lock`);
    writeFileSync(firstLock, ""); writeFileSync(secondLock, "");
    processFixture(f.proc, 4411, 777, [firstLock, secondLock, f.rollout, secondRollout]);
    expect(codexSessionForPane(777, f.shared, f.proc)).toBeNull();
  });

  it("holds a live owner; a stale lock file alone is not an owner", () => {
    const f = fixture(); persist(f);
    const lock = join(f.dir, "codex-home", "thread-writer-locks", `${SESSION}.lock`);
    mkdirSync(join(f.dir, "codex-home", "thread-writer-locks"), { recursive: true });
    writeFileSync(lock, "");
    expect(f.backend.resumeOwner(f.cwd)).toBeNull();
    processFixture(f.proc, 3322, 3322, [lock]);
    expect(f.backend.resumeOwner(f.cwd)).toBe(3322);
  });

  it("allows only an explicit stopped-instance UUID attach, preserving old rollouts", () => {
    const f = fixture();
    expect(() => attachCodexSession(f.instance, f.shared, f.cwd, "not-an-id")).toThrow("UUID");
    writeFileSync(join(f.instance, "window-id"), "@1");
    expect(() => attachCodexSession(f.instance, f.shared, f.cwd, SESSION)).toThrow("Stop this instance");
    rmSync(join(f.instance, "window-id"));
    // A PID marker appears before the pane exists; fail closed during startup.
    writeFileSync(join(f.instance, "daemon.pid"), String(process.pid));
    expect(() => attachCodexSession(f.instance, f.shared, f.cwd, SESSION)).toThrow("daemon PID marker");
    rmSync(join(f.instance, "daemon.pid"));
    const other = join(f.dir, "other");
    mkdirSync(other);
    expect(() => attachCodexSession(f.instance, f.shared, other, SESSION)).toThrow("different repository");
    attachCodexSession(f.instance, f.shared, f.cwd, SESSION);
    expect(f.backend.canResume(f.cwd)).toBe(true);
    expect(readFileSync(f.rollout, "utf8")).toContain("private transcript");
  });
});

describe("real Codex 0.156 resume panes", () => {
  const cwdPane = readFileSync(new URL("./fixtures/codex-0156-resume-cwd.pane.txt", import.meta.url), "utf8");
  const lockPane = readFileSync(new URL("./fixtures/codex-0156-resume-locked.pane.txt", import.meta.url), "utf8");

  it("parses the true directory menu and only auto-selects current for its owned session", () => {
    const state = codexResumeDirectoryPromptState(cwdPane);
    expect(state).toEqual({ active: true, safeChoice: true,
      sessionCwd: "/home/han/Projects/AgEnD-agend-dev-sol", currentCwd: "/tmp/agend913-modal-probe" });
    const f = fixture();
    const auto = f.backend.getStartupDialogs().find(d => d.autoResolutionKey === "codex-verified-resume-directory")!;
    (f.backend as any).resumeRecord = { ...f.record, cwd: state.sessionCwd };
    (f.backend as any).authorizedTrust = { cwd: state.currentCwd, root: state.currentCwd };
    expect(auto.isActive?.(cwdPane)).toBe(true);
    expect(auto.keys).toEqual(["Down", "Enter"]);
    (f.backend as any).resumeRecord = null;
    expect(auto.isActive?.(cwdPane)).toBe(false);
    expect(f.backend.getStartupDialogs().some(d => d.holdOnly && d.isActive?.(cwdPane))).toBe(true);
  });

  it("never auto-selects a reordered, unknown-cursor, foreign-path, or transcript menu", () => {
    const f = fixture();
    const auto = f.backend.getStartupDialogs().find(d => d.autoResolutionKey === "codex-verified-resume-directory")!;
    (f.backend as any).resumeRecord = { ...f.record, cwd: "/home/han/Projects/AgEnD-agend-dev-sol" };
    (f.backend as any).authorizedTrust = { cwd: "/tmp/agend913-modal-probe", root: "/tmp/agend913-modal-probe" };
    for (const pane of [
      cwdPane.replace("› 1. Use session", "  1. Use session"),
      cwdPane.replace("  2. Use current", "› 2. Use current"),
      cwdPane.replace("  3. Always use session directory", "  3. Always use current directory"),
      cwdPane.replace("/tmp/agend913-modal-probe)", "/tmp/foreign-project)"),
      `${cwdPane}\n› Ask Codex to do anything\n`,
    ]) expect(auto.isActive?.(pane)).toBe(false);
    const hold = f.backend.getStartupDialogs().find(d => d.holdOnly && d.description.includes("resume directory"))!;
    const unknownVariant = cwdPane.replace("enter continue · esc use session · ctrl+c quit", "enter continue · esc cancel · ctrl+c quit");
    expect(codexResumeDirectoryPromptState(unknownVariant).active).toBe(false);
    expect(codexResumeDirectoryVisible(unknownVariant)).toBe(true);
    expect(hold.isActive?.(unknownVariant)).toBe(true);
    expect(codexResumeDirectoryVisible(`${cwdPane}\n› Ask Codex to do anything`)).toBe(false);
  });

  it("recognizes the true live lock screen as hold-only, never sends R", () => {
    expect(codexResumeLockActive(lockPane)).toBe(true);
    const f = fixture();
    const lock = f.backend.getRuntimeDialogs().find(d => d.description.includes("another app"))!;
    expect(lock.holdOnly).toBe(true);
    expect(lock.blocksDelivery).toBe(true);
    expect(lock.keys).toEqual([]);
    expect(lock.isActive?.(lockPane)).toBe(true);
    expect(lock.isActive?.(lockPane.replace("r retry   esc/ctrl+c/q exit   ctrl+t transcript", "press R to retry"))).toBe(true);
    expect(codexResumeLockVisible(`${lockPane}\n› Ask Codex to do anything`)).toBe(false);
    expect(codexResumeLockActive(`${lockPane}\n› Ask Codex to do anything`)).toBe(false);
  });
});
