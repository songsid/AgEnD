/**
 * #2356: `agend fleet restart --reload` under the systemd user unit stopped the fleet for 7 hours. Its SIGUSR1 reload
 * made the fleet exit 0 (Restart=on-failure: no restart), and the CLI that was to start the next fleet in its own
 * process ran inside the unit's cgroup (an agent pane) and was killed with it. `agend restart` is now the only full
 * restart; `fleet restart` [--reload] [<name>] runs its code path, and nothing sends SIGUSR1.
 *
 * Nothing here can reach the real fleet or its service manager: the CLI runs with a PATH of stubs that record each call
 * and fail, a scratch HOME/AGEND_HOME, and a fleet.pid naming a throwaway child of this test.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_FILE, type AuditEntry } from "../src/fleet-control-audit.js";
import { FULL_RELOAD_UNDER_SYSTEMD_EXIT_CODE, agendSystemdUnitOf, fullReloadExitCode, redirectsToService, startedByServiceManager } from "../src/service-owner.js";

describe("agendSystemdUnitOf / fullReloadExitCode", () => {
  const USER = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/com.agend.fleet.service\n";
  const SYSTEM = "0::/system.slice/agend.service\n";

  it("names the AgEnD unit from the process's own cgroup (v2, v1, nested)", () => {
    expect(agendSystemdUnitOf(USER)).toBe("com.agend.fleet");
    expect(agendSystemdUnitOf(SYSTEM)).toBe("agend");
    expect(agendSystemdUnitOf("12:pids:/user.slice\n1:name=systemd:/user.slice/user-0.slice/user@0.service/com.agend.fleet.service\n")).toBe("com.agend.fleet");
    expect(agendSystemdUnitOf("0::/system.slice/agend.service/payload\n")).toBe("agend");
  });

  it("anything else is not an AgEnD unit", () => {
    for (const text of ["", "0::/\n", "0::/user.slice/user-1000.slice/session-3.scope\n", "0::/system.slice/myagend.service\n",
      "0::/system.slice/agend-web.service\n", "0::/user.slice/user@1000.service/app.slice/com.agend.fleet.service.d\n",
      "0::/user.slice/user@1000.service/app.slice/tmux-spawn-1.scope\n"]) {
      expect(agendSystemdUnitOf(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("a SIGUSR1 reload exits non-zero only under an AgEnD unit, so Restart=on-failure brings it back", () => {
    expect(FULL_RELOAD_UNDER_SYSTEMD_EXIT_CODE).not.toBe(0);
    expect(fullReloadExitCode(USER)).toBe(FULL_RELOAD_UNDER_SYSTEMD_EXIT_CODE);
    expect(fullReloadExitCode(SYSTEM)).toBe(FULL_RELOAD_UNDER_SYSTEMD_EXIT_CODE);
    expect(fullReloadExitCode("0::/user.slice/user-1000.slice/session-3.scope\n")).toBe(0);
    expect(fullReloadExitCode(null)).toBe(0);
  });
});

describe("fleet start / fleet stop by hand (#2356): who started it, and when they hand over", () => {
  const UNIT = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/com.agend.fleet.service\n";
  const SHELL = "0::/user.slice/user-1000.slice/session-3.scope\n";
  const by = (o: Partial<Parameters<typeof startedByServiceManager>[0]>) =>
    startedByServiceManager({ platform: "linux", env: {}, ownCgroup: SHELL, ppid: 4242, launchdLabel: "com.agend.fleet", ...o });

  it("the unit's ExecStart (its own cgroup) and the launchd job (XPC_SERVICE_NAME, or launchd as parent) are the manager's", () => {
    expect(by({ ownCgroup: UNIT })).toBe(true);
    expect(by({ ownCgroup: "0::/system.slice/agend.service\n" })).toBe(true);
    expect(by({ platform: "darwin", ownCgroup: null, env: { XPC_SERVICE_NAME: "com.agend.fleet" } })).toBe(true);
    expect(by({ platform: "darwin", ownCgroup: null, ppid: 1 })).toBe(true);
  });

  it("a shell, a terminal, another job or an unreadable cgroup is a hand-run", () => {
    expect(by({})).toBe(false);
    expect(by({ ownCgroup: null })).toBe(false);
    expect(by({ env: { XPC_SERVICE_NAME: "com.agend.fleet" } })).toBe(false);          // a launchd variable means nothing on Linux
    expect(by({ ppid: 1 })).toBe(false);                                                // nor does init as parent
    expect(by({ platform: "darwin", ownCgroup: null, env: { XPC_SERVICE_NAME: "com.apple.Terminal" } })).toBe(false);
    expect(by({ platform: "darwin", ownCgroup: UNIT })).toBe(false);                    // a cgroup means nothing on macOS
  });

  it("hands over only with a service installed; the manager's own start and AgEnD's marked start go ahead", () => {
    const go = (o: Partial<Parameters<typeof redirectsToService>[0]>) =>
      redirectsToService({ command: "start", directMarker: false, byServiceManager: false, installedServicePath: "/u/com.agend.fleet.service", ...o });
    expect(go({})).toBe(true);
    expect(go({ byServiceManager: true })).toBe(false);
    expect(go({ directMarker: true })).toBe(false);
    expect(go({ installedServicePath: null })).toBe(false);                             // Docker, manual, detached hosts
    // A service file the manager cannot run (written, never activated): `fleet start --direct` is the operator's way out.
    expect(go({ installedServicePath: "/u/com.agend.fleet.service", directMarker: true })).toBe(false);
    expect(go({ command: "stop" })).toBe(true);
    expect(go({ command: "stop", byServiceManager: true, directMarker: true })).toBe(true);   // no manager ever runs `fleet stop`
    expect(go({ command: "stop", installedServicePath: null })).toBe(false);
  });

  it("`fleet start --direct` is an operator's override: refused from an agent session or the fleet's own commands, before the hand-over", () => {
    const source = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
    const at = source.indexOf("if (opts?.direct && !forceAllowed()) {");
    expect(at).toBeGreaterThan(0);
    expect(source.slice(at, at + 300)).toContain("process.exit(1);");
    expect(at).toBeLessThan(source.indexOf("const direct = marked || !!opts?.direct;"));
    expect(source.indexOf("const direct = marked || !!opts?.direct;")).toBeLessThan(source.indexOf('if (!instance && redirectToService("start", [], direct)) return;'));
  });

  it("quickstart's failed service install names the way out, not a bare `agend start` that refuses", () => {
    const source = readFileSync(join(process.cwd(), "src", "quickstart.ts"), "utf8");
    const at = source.indexOf('t("qs.service_install_failed"');   // #2390: the line in the fleet's language
    const branch = source.slice(at, source.indexOf("printDashboard();", at));
    expect(branch).toContain('bold("agend fleet start --direct")');
    expect(branch).toContain("serviceFailed = true;");
    expect(branch).toContain("if (!serviceRunning && !serviceFailed) {");
  });

  it("AgEnD's own detached starts carry the marker, and fleet start drops it before anything it launches", () => {
    const source = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
    expect(source.match(/spawn\(start\.command, start\.args, \{ detached: true, stdio: "ignore", env: \{ \.\.\.process\.env, \[DIRECT_FLEET_START_ENV\]: "1" \} \}\)/g)).toHaveLength(2);
    expect(source.match(/selfCommand\(\["fleet", "start"\]\)/g)).toHaveLength(2);
    const at = source.indexOf("const marked = process.env[DIRECT_FLEET_START_ENV]");
    expect(source.slice(at, at + 200)).toContain("delete process.env[DIRECT_FLEET_START_ENV];");
    expect(at).toBeLessThan(source.indexOf("if (!claimFleetSingleton()) return;", at));
  });
});

describe("no code path sends SIGUSR1 any more", () => {
  it("src/ has no SIGUSR1 sender (only the fleet's own listener for older CLIs)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|js|cjs|mjs)$/.test(entry.name) && /kill\([^)]*SIGUSR1/.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    };
    walk(join(process.cwd(), "src"));
    expect(hits).toEqual([]);
  });

  it("quickstart's restart after a setup change is `agend restart`", () => {
    const source = readFileSync(join(process.cwd(), "src", "quickstart.ts"), "utf8");
    expect(source).toContain('delayedSelfCommand(2, ["restart"])');
    expect(source).not.toMatch(/"fleet",\s*"restart"/);
  });
});

describe("`agend fleet restart` runs `agend restart` (inert stubs)", () => {
  let inert: string;
  let home: string;
  let target: ChildProcess | null = null;
  let marker: string;
  beforeEach(() => {
    inert = mkdtempSync(join(tmpdir(), "agend-2356-"));
    home = join(inert, "home", ".agend");
    mkdirSync(join(inert, "bin")); mkdirSync(home, { recursive: true });
    marker = join(inert, "sigusr1");
    for (const command of ["systemctl", "launchctl", "loginctl", "journalctl", "sudo", "npm", "agend"]) {
      const path = join(inert, "bin", command);
      writeFileSync(path, `#!/bin/sh\necho "${command} $@" >> "${join(inert, "calls")}"\nexit 1\n`);
      chmodSync(path, 0o755);
    }
  });
  afterEach(() => {
    target?.kill("SIGKILL"); target = null;
    rmSync(inert, { recursive: true, force: true });
  });

  /** A live process in fleet.pid that records a SIGUSR1 — what the old reload sent the fleet. */
  async function fakeFleet(): Promise<number> {
    target = spawn(process.execPath, ["-e", `process.on("SIGUSR1", () => { require("fs").writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(9); }); setInterval(() => {}, 1000); process.send?.("up");`], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise<void>(resolve => target!.once("message", () => resolve()));
    writeFileSync(join(home, "fleet.pid"), String(target.pid));
    return target.pid!;
  }
  const calls = (): string => existsSync(join(inert, "calls")) ? readFileSync(join(inert, "calls"), "utf8") : "";
  const audit = (): AuditEntry[] => existsSync(join(home, AUDIT_FILE))
    ? readFileSync(join(home, AUDIT_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const run = (args: string[], instance: string | null) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
      env: { HOME: join(inert, "home"), AGEND_HOME: home, PATH: join(inert, "bin"), NOTIFY_SOCKET: "", ...(instance ? { AGEND_INSTANCE_NAME: instance } : {}) },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr });
      else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
      else reject(error);
    });
  });

  it.each([[["fleet", "restart", "--reload", "--yes"]], [["fleet", "restart", "--yes"]]])(
    "%j: a deprecation line, then exactly `agend restart --yes` — the same manager calls and exit code, no SIGUSR1", async args => {
      await fakeFleet();
      const shim = await run(args, "agend-leader");
      expect(shim.stderr).toContain("`agend fleet restart` is deprecated and goes away in 2.4");
      const shimCalls = calls();
      expect(shimCalls).toContain("systemctl");          // it asked the service manager first, as `agend restart` does
      expect(existsSync(marker)).toBe(false);            // the "fleet" never got SIGUSR1
      expect(target!.exitCode).toBeNull();
      expect(shim.stdout + shim.stderr).not.toContain("Starting with new code");
      expect(audit().map(entry => [entry.action, entry.outcome])).toEqual([["restart", "allowed"]]);

      rmSync(join(inert, "calls"), { force: true });
      if (!existsSync(join(home, "fleet.pid"))) writeFileSync(join(home, "fleet.pid"), String(target!.pid));
      const canonical = await run(["restart", "--yes"], "agend-leader");
      expect(calls()).toBe(shimCalls);
      expect(shim.code).toBe(canonical.code);
      expect(existsSync(marker)).toBe(false);
    });

  it("an operator's own `fleet restart --reload` (no session, no --yes) goes the same way", async () => {
    await fakeFleet();
    const result = await run(["fleet", "restart", "--reload"], null);
    expect(result.stderr).toContain("deprecated");
    expect(calls()).toContain("systemctl");
    expect(existsSync(marker)).toBe(false);
  });

  it("`--reload` with an instance name is still refused before anything", async () => {
    const result = await run(["fleet", "restart", "worker", "--reload", "--yes"], "agend-leader");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot combine with instance name");
    expect(calls()).toBe("");
  });

  it("`agend restart <name>` and the old `fleet restart <name>` restart one instance through the fleet's API only", async () => {
    const hits: string[] = [];
    const server: Server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { "Content-Type": "application/json" }).end("{}"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      writeFileSync(join(home, "fleet.yaml"), `health_port: ${port}\ninstances: {}\n`);
      const now = await run(["restart", "worker"], "agend-leader");
      const old = await run(["fleet", "restart", "worker"], "agend-leader");
      expect(now.stdout).toContain('Instance "worker" restarted (immediate)');
      expect(old.stderr).toContain("running `agend restart worker`");
      expect(old.stdout).toContain('Instance "worker" restarted (immediate)');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(hits).toEqual(["POST /restart/worker", "POST /restart/worker"]);
    expect(calls()).toBe("");                             // no service manager for one instance
    expect(audit().map(entry => [entry.action, entry.target, entry.outcome])).toEqual([
      ["instance-restart", "worker", "allowed"], ["instance-restart", "worker", "allowed"],
    ]);
  });

  it("`agend restart <name> --force` is refused: --force is about the service", async () => {
    const result = await run(["restart", "worker", "--force"], null);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--force applies to the whole service");
    expect(calls()).toBe("");
  });
});

describe("`fleet start` / `fleet stop` by hand with a user unit installed (inert stubs)", () => {
  let inert: string;
  let home: string;
  beforeEach(() => {
    inert = mkdtempSync(join(tmpdir(), "agend-2356-svc-"));
    home = join(inert, "home", ".agend");
    mkdirSync(join(inert, "bin")); mkdirSync(home, { recursive: true });
    // A user unit (Linux) and a LaunchAgent plist (macOS): `agend` finds "a service is installed" on either platform.
    mkdirSync(join(inert, "home", ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(inert, "home", ".config", "systemd", "user", "com.agend.fleet.service"), "[Service]\nExecStart=/x/agend fleet start\n");
    mkdirSync(join(inert, "home", "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(inert, "home", "Library", "LaunchAgents", "com.agend.fleet.plist"), "<plist/>\n");
    for (const command of ["systemctl", "launchctl", "loginctl", "journalctl", "sudo", "npm", "agend", "tmux"]) {
      const path = join(inert, "bin", command);
      writeFileSync(path, `#!/bin/sh\necho "${command} $@" >> "${join(inert, "calls")}"\nexit 1\n`);
      chmodSync(path, 0o755);
    }
  });
  afterEach(() => { rmSync(inert, { recursive: true, force: true }); });
  const calls = (): string => existsSync(join(inert, "calls")) ? readFileSync(join(inert, "calls"), "utf8") : "";
  const run = (args: string[], instance: string | null) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
      env: { HOME: join(inert, "home"), AGEND_HOME: home, PATH: join(inert, "bin"), NOTIFY_SOCKET: "", ...(instance ? { AGEND_INSTANCE_NAME: instance } : {}) },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr });
      else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
      else reject(error);
    });
  });
  const service = process.platform === "darwin" ? "launchctl" : "systemctl";

  // `fleet start` itself cannot be run from a test (the test process guard refuses any `agend fleet start`): its hand-over
  // is the same redirectToService() as `fleet stop` below, decided by redirectsToService() above, and rehearsed live.
  it("both hand-overs are the same helper, only without an instance name", () => {
    const source = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
    expect(source).toContain('if (!instance && redirectToService("start", [], direct)) return;');
    expect(source).toContain('if (!instance && redirectToService("stop", opts?.yes ? ["--yes"] : [], false)) return;');
  });

  it("a service file the manager cannot run: `agend start` refuses a fleet beside it and names `fleet start --direct`", async () => {
    const result = await run(["start"], null);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refusing to start a detached duplicate");
    expect(result.stderr).toContain("If the service cannot run on this host, start the fleet without it: agend fleet start --direct");
    expect(existsSync(join(home, "fleet.pid"))).toBe(false);
  });

  it("`fleet stop` runs `agend stop` with its gate: refused without --yes from an agent session, the service stopped with it", async () => {
    const refused = await run(["fleet", "stop"], "agend-leader");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("Refusing `agend stop`");
    expect(calls()).toBe("");
    const confirmed = await run(["fleet", "stop", "--yes"], "agend-leader");
    expect(confirmed.stderr).toContain("running `agend stop --yes`");
    expect(calls()).toContain(process.platform === "darwin" ? "launchctl bootout" : "systemctl --user stop com.agend.fleet");
    const audit = readFileSync(join(home, AUDIT_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line) as AuditEntry);
    expect(audit.map(entry => [entry.action, entry.outcome])).toEqual([["stop", "refused"], ["stop", "allowed"]]);
  });

  it("`fleet stop <name>` still goes to the running fleet's API, never to the service", async () => {
    const hits: string[] = [];
    const server: Server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { "Content-Type": "application/json" }).end("{}"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      writeFileSync(join(home, "fleet.yaml"), `health_port: ${port}\ninstances: {}\n`);
      const stopped = await run(["fleet", "stop", "worker"], "agend-leader");
      expect(stopped.stdout).toContain('Instance "worker" stopped');
      expect(stopped.stderr).not.toContain("An AgEnD service is installed");
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(hits).toEqual(["POST /stop/worker"]);
    expect(calls()).toBe("");
  });
});
