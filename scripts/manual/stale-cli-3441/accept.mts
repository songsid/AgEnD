/** Isolated fake-npm replacement. Never runs the installed Claude CLI. Run with env -i and an owned HOME. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readlinkSync, renameSync, unlinkSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "../../../src/daemon.js";
import { ClaudeCodeBackend } from "../../../src/backend/claude-code.js";
import { TmuxManager } from "../../../src/tmux-manager.js";
const home = process.env.HOME!;
assert(home && home.includes("stale-cli-3441"), "requires an owned scratch HOME named stale-cli-3441");
const root = mkdtempSync(join(home, "rig-")), socket = `agend-3441-${process.pid}`, session = "fixture", sid = "11111111-2222-4333-8444-555555555555";
const source = fileURLToPath(new URL("./fake-claude.c", import.meta.url)), image = join(root, "fake-image");
execFileSync("cc", [source, "-o", image]);
TmuxManager.setSocketName(socket);
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" }).trim();
const write = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const receipts: any[] = [];
const pids = new Set<number>();
try {
  for (const mode of ["deleted-window", "minimum-updated", "minimum-outdated", "persistent-bad"]) {
    const dir = join(root, mode), pkg = join(dir, "node_modules/@anthropic-ai/claude-code"), bin = join(pkg, "bin/claude.exe"), inst = join(dir, "instance"), log = join(dir, "launches.log");
    mkdirSync(inst, { recursive: true });
    write(join(inst, "session-id"), sid);
    const install = (version: string) => { mkdirSync(dirname(bin), { recursive: true }); copyFileSync(image, bin); write(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version })); };
    install("2.1.220");
    process.env.RIG_LOG = log;
    const backend = new ClaudeCodeBackend(inst);
    backend.refreshLaunchBinary(bin);
    const command = backend.buildCommand.bind(backend);
    backend.buildCommand = config => `RIG_LOG=${JSON.stringify(log)} ${command(config)}`;
    const logs: any[] = [], logger = { info: (...a: any[]) => logs.push(a), warn: (...a: any[]) => logs.push(a), error: (...a: any[]) => logs.push(a), debug: () => { } };
    const d: any = new Daemon("fixture", { backend: "claude-code", working_directory: dir, log_level: "silent", lightweight: true, restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600000, max_age_hours: 0 } } as any, inst, false, backend, undefined, { child: () => logger } as any);
    d.tmuxSessionName = session;
    d.tmux = new TmuxManager(session, "");
    // The control adapter waits for actual owned pane output, not a synthetic ready verdict.
    d.controlClient = { registerWindow: async () => { }, unregisterWindow: () => { }, waitForIdle: async () => { }, waitForOutput: async () => {
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          if ((await d.tmux.capturePane()).includes("Fixture Claude ready"))
            return true;
          await new Promise(r => setTimeout(r, 20));
        }
        return false;
      } };
    // Resolve only our fake launcher; production path discovery is covered separately.
    d.refreshCliLaunchPath = async () => bin;
    const warnings: any[] = [];
    d.on("backend_launch_warning", (x: any) => warnings.push(x));
    const inspect = d.inspectCliLaunch.bind(d);
    let inspections = 0, oldExe = "", missing = false;
    d.inspectCliLaunch = async (path?: string) => {
      inspections++;
      if (inspections === 1 && mode !== "minimum-outdated") {
        const pid = await TmuxManager.getPanePid(session, d.tmux.getWindowId());
        assert(pid);
        pids.add(pid);
        const moved = join(dirname(pkg), ".claude-code-Rig123");
        renameSync(pkg, moved);
        unlinkSync(join(moved, "bin/claude.exe"));
        oldExe = readlinkSync(`/proc/${pid}/exe`);
        assert.match(oldExe, /\.claude-code-Rig123\/bin\/claude\.exe \(deleted\)$/);
        if (mode !== "deleted-window")
          install("2.1.319");
      }
      else if (inspections === 2 && mode === "deleted-window") {
        assert(missing, "first physical proof observed the missing stable launcher");
        install("2.1.319");
      }
      const got = await inspect(path);
      assert(got, "physical worker returned an owned executable proof");
      if (inspections === 1 && mode === "deleted-window") {
        assert.equal(got.installed, null);
        missing = true;
      }
      if (mode === "persistent-bad" && inspections === 3) {
        const moved = join(dirname(pkg), ".claude-code-Rig456");
        renameSync(pkg, moved);
        unlinkSync(join(moved, "bin/claude.exe"));
        return await inspect(path);
      }
      pids.add(got.process.pid);
      return got;
    };
    d.beginSpawn();
    if (mode === "minimum-updated" || mode === "minimum-outdated" || mode === "persistent-bad") {
      // Real launch/readiness first; invoke the production minimum-error dispatch afterwards.
      const guard = d.checkCliLaunchIntegrity;
      d.checkCliLaunchIntegrity = async () => { };
      assert.equal(await d.trySpawn(false), true);
      d.checkCliLaunchIntegrity = guard;
      d.endSpawn();
      if (mode === "persistent-bad") {
        await d.checkCliLaunchIntegrity(false);
        await d.checkCliLaunchIntegrity(false);
        assert.equal(d.cliLaunchIntegrityBlocked, true);
      }
      else {
        const ep = backend.getErrorPatterns().find(x => x.type === "outdated_cli")!;
        d.emitErrorPattern(ep, "minimum", "API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required", performance.now());
        await d.cliLaunchIntegrityFlight;
        // Repeated polls must not produce another attempt or notice.
        d.emitErrorPattern(ep, "minimum", "API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required", performance.now());
        await d.cliLaunchIntegrityFlight;
      }
    }
    else {
      assert.equal(await d.trySpawn(false), true);
      d.endSpawn();
    }
    const rows = readFileSync(log, "utf8").trim().split("\n"), starts = rows.filter(x => x.startsWith("START "));
    const count = mode === "minimum-outdated" ? 1 : 2;
    assert.equal(starts.length, count);
    if (count === 2)
      assert(starts[1]!.endsWith(sid), "replacement used exact retained session UUID");
    assert.equal(readFileSync(join(inst, "session-id"), "utf8"), sid);
    assert.equal(warnings.length, 1);
    const currentPid = await TmuxManager.getPanePid(session, d.tmux.getWindowId());
    assert(currentPid);
    pids.add(currentPid);
    receipts.push({ mode, starts, oldExe, inspections, missingStableTarget: missing, notices: warnings.map(x => x.message), sessionKept: true, spawning: d.spawning, logEntries: logs.length });
    await d.tmux.killWindow();
  }
}
finally {
  try {
    tmux("kill-server");
  }
  catch { }
  TmuxManager.setSocketName(null);
  const alive = [...pids].filter(pid => { try {
    process.kill(pid, 0);
    return true;
  }
  catch {
    return false;
  } });
  // Pane death is asynchronous. Wait boundedly for only these owned PIDs.
  const end = Date.now() + 5000;
  while (alive.some(pid => existsSync(`/proc/${pid}`)) && Date.now() < end)
    await new Promise(r => setTimeout(r, 20));
  const remaining = alive.filter(pid => existsSync(`/proc/${pid}`));
  console.log(JSON.stringify({ node: process.version, platform: process.platform, socket, receipts, cleanup: { remainingOwnedPids: remaining, scratchRemoved: true } }, null, 2));
  rmSync(root, { recursive: true, force: true });
  assert.equal(remaining.length, 0);
}
