import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackend, attachCodexSession, codexResumeClaimCommand, codexResumeDirectoryPromptState, codexResumeDirectoryVisible, codexResumeLockActive, codexResumeLockVisible } from "../src/backend/codex.js";
import { codexSessionForPane, codexSessionOwners, type CodexSessionRecord } from "../src/backend/codex-session.js";

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

  it("rejects a copied owner record or a rollout whose metadata was changed", () => {
    const f = fixture(); persist(f);
    writeFileSync(join(f.instance, "codex-session.json"), JSON.stringify({ ...f.record, owner: "instance-b" }));
    expect(f.backend.canResume(f.cwd)).toBe(false);
    persist(f);
    writeFileSync(f.rollout, JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: "/other/project" } }) + "\n");
    expect(f.backend.canResume(f.cwd)).toBe(false);
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
