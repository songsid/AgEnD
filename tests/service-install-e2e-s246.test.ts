/**
 * M-3770 S-246, end to end: the real `agend install` (src/cli.ts under tsx) with a mock systemctl on PATH and a fake
 * hand-started fleet — a process whose command line is a fleet start, published in fleet.pid, that takes 2.5 s to exit
 * after SIGTERM (the old install waited two seconds and started the service anyway).
 *  - The service is enabled only after the old fleet has exited; fleet.pid is cleared.
 *  - A service manager that can't take the fleet (no user bus, as on a WSL without systemd) refuses before any signal:
 *    the fleet keeps running.
 *  - The service can't start after the stop: the hand-started fleet is started again (no down path).
 * No real fleet starts here: the "fleet" is an inert script, and the one start the no-down path makes is recorded by
 * the test process guard (AGEND_TEST_SELF_SPAWN_LOG) and runs nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const roots: string[] = [];
const fleets: ChildProcess[] = [];
afterEach(() => {
  for (const f of fleets.splice(0)) { try { f.kill("SIGKILL"); } catch { /* gone */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function rig() {
  const root = mkdtempSync(join(tmpdir(), "agend-s246-install-"));
  roots.push(root);
  const home = join(root, "home"), data = join(root, "agend-home"), bin = join(root, "bin"), fake = join(root, "fake");
  const events = join(root, "events.log");
  for (const d of [home, data, bin, fake]) mkdirSync(d, { recursive: true });
  // systemctl: every call, with the time, into the same events file the fake fleet writes.
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh
echo "systemctl $(date +%s%3N) $*" >> "$EVENTS"
if [ "$SYSTEMCTL_MODE" = "nobus" ]; then echo "Failed to connect to bus: No medium found" >&2; exit 1; fi
case "$SYSTEMCTL_MODE:$*" in "enable-fails:"*"enable --now"*) echo "mock enable failure" >&2; exit 1;; esac
case "$*" in *"show -p Type,NotifyAccess,"*) echo Type=notify; echo NotifyAccess=all;; esac
`);
  chmodSync(join(bin, "systemctl"), 0o755);
  // The fake hand-started fleet: `node <fake>/cli.js fleet start`, 2.5 s from SIGTERM to exit.
  writeFileSync(join(fake, "cli.js"), `const fs = require("fs"), ev = process.argv[4];
process.on("SIGTERM", () => { fs.appendFileSync(ev, "fleet " + Date.now() + " term\\n"); setTimeout(() => { fs.appendFileSync(ev, "fleet " + Date.now() + " exit\\n"); process.exit(0); }, 2500); });
setInterval(() => {}, 1000); fs.appendFileSync(ev, "fleet " + Date.now() + " up\\n");
`);
  const fleet = spawn(process.execPath, [join(fake, "cli.js"), "fleet", "start", events], { stdio: "ignore" });
  fleets.push(fleet);
  for (let i = 0; i < 100 && !(existsSync(events) && readFileSync(events, "utf8").includes(" up")); i++) await new Promise(r => setTimeout(r, 50));
  writeFileSync(join(data, "fleet.pid"), `${fleet.pid}\n`);
  const spawnLog = join(root, "self-spawn.log");
  const install = (mode = "ok") => spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "install"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HOME: home, AGEND_HOME: data, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, EVENTS: events,
      SYSTEMCTL_MODE: mode, NOTIFY_SOCKET: "", XDG_RUNTIME_DIR: join(root, "run"), AGEND_TEST_SELF_SPAWN_LOG: spawnLog },
  });
  const lines = () => readFileSync(events, "utf8").trim().split("\n");
  const at = (pattern: RegExp) => { const l = lines().find(x => pattern.test(x)); return l ? Number(l.split(" ")[1]) : NaN; };
  const spawned = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8") : "");
  return { data, fleet, install, lines, at, spawned };
}

describe("S-246: agend install hands a hand-started fleet over to the service", () => {
  it("the service is enabled only once the old fleet has exited (it took longer than the old two seconds)", async () => {
    const r = await rig();
    const result = r.install();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Stopping the hand-started fleet");
    expect(result.stdout).toContain("✅ Fleet service installed and running.");
    const term = r.at(/^fleet \d+ term$/), exit = r.at(/^fleet \d+ exit$/), enable = r.at(/enable --now com\.agend\.fleet$/);
    expect([term, exit, enable].every(Number.isFinite), r.lines().join("\n")).toBe(true);
    expect(exit - term).toBeGreaterThanOrEqual(2400);
    expect(enable).toBeGreaterThanOrEqual(exit);
    expect(existsSync(join(r.data, "fleet.pid"))).toBe(false);
    expect(r.spawned()).toBe("");                                          // nothing started by hand
  }, 90_000);

  it("a service manager that can't take it (no user bus): refused before any signal; the fleet keeps running, its fleet.pid kept", async () => {
    const r = await rig();
    const result = r.install("nobus");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Nothing was stopped: the fleet keeps running as it was.");
    expect(r.lines().some(l => / term$/.test(l))).toBe(false);
    expect(r.lines().some(l => /enable --now/.test(l))).toBe(false);
    expect(r.fleet.exitCode).toBeNull();
    expect(() => process.kill(r.fleet.pid!, 0)).not.toThrow();
    expect(readFileSync(join(r.data, "fleet.pid"), "utf8")).toBe(`${r.fleet.pid}\n`);
    expect(r.spawned()).toBe("");
  }, 90_000);

  it("no down path: the service can't start after the stop → the hand-started fleet is started again", async () => {
    const r = await rig();
    const result = r.install("enable-fails");
    expect(result.status).toBe(1);
    const exit = r.at(/^fleet \d+ exit$/), enable = r.at(/enable --now com\.agend\.fleet$/);
    expect(enable).toBeGreaterThanOrEqual(exit);
    expect(result.stderr).toContain("The fleet was started again as it ran before (not as a service).");
    expect(r.spawned()).toBe("agend fleet start\n");
  }, 90_000);
});
