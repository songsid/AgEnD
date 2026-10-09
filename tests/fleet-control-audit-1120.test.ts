import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOW_TEST_ENV, AUDIT_FILE, ORIGIN_ENV, appendAudit, describeCaller, describeSignalSource,
  gateFleetControl, judgeFleetControl, readRecentAudit, recordInstanceControl, recordInternalRequest,
  refusalMessage, withOrigin, type AuditEntry,
} from "../src/fleet-control-audit.js";

/**
 * #1120: who stopped / restarted / updated the fleet, and a confirmation when a fleet
 * agent's own session (or a test runner) is the one asking.
 *
 * Nothing here runs a command that could reach the real fleet or its service manager:
 * the CLI cases are `fleet stop` / `fleet restart` with no instance, against a scratch
 * AGEND_HOME with no fleet.pid — a refusal returns before anything happens, and an
 * allowed call only reports "not running". (2026-10-03: a harness that ran the real
 * `agend update` restarted the live fleet.)
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-1120-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const audit = (): AuditEntry[] =>
  existsSync(join(dir, AUDIT_FILE))
    ? readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line))
    : [];

describe("judgeFleetControl", () => {
  it("an ordinary interactive shell goes ahead", () => {
    expect(judgeFleetControl({}, false)).toEqual({ ok: true, via: "interactive" });
  });

  it("a fleet agent's session is refused without --yes, and allowed with it", () => {
    const env = { AGEND_INSTANCE_NAME: "agend-leader" };
    expect(judgeFleetControl(env, false)).toEqual({ ok: false, reason: "agent-session" });
    expect(judgeFleetControl(env, true)).toEqual({ ok: true, via: "yes" });
  });

  it("an empty AGEND_INSTANCE_NAME is not an agent session", () => {
    expect(judgeFleetControl({ AGEND_INSTANCE_NAME: "  " }, false).ok).toBe(true);
  });

  it("a test runner is refused, --yes or not, unless it says it means it", () => {
    expect(judgeFleetControl({ VITEST: "true" }, false)).toEqual({ ok: false, reason: "test-runner" });
    expect(judgeFleetControl({ VITEST: "true" }, true)).toEqual({ ok: false, reason: "test-runner" });
    expect(judgeFleetControl({ NODE_ENV: "test" }, true)).toEqual({ ok: false, reason: "test-runner" });
    expect(judgeFleetControl({ VITEST: "true", [ALLOW_TEST_ENV]: "1" }, false)).toEqual({ ok: true, via: "interactive" });
  });

  it.each(["0", "false", "", "  ", "yes", "true"])("the test opt-in is exactly \"1\", not %j", value => {
    expect(judgeFleetControl({ VITEST: "true", [ALLOW_TEST_ENV]: value }, true)).toEqual({ ok: false, reason: "test-runner" });
    expect(judgeFleetControl({ VITEST: "true", [ALLOW_TEST_ENV]: value, [ORIGIN_ENV]: "slash /update by 1:2" }, false))
      .toEqual({ ok: false, reason: "test-runner" });
  });

  it("the fleet's own spawn sites pass: they were authorised where they started", () => {
    expect(judgeFleetControl({ [ORIGIN_ENV]: "slash /update by 1:2", AGEND_INSTANCE_NAME: "x" }, false))
      .toEqual({ ok: true, via: "origin" });
    expect(judgeFleetControl({ [ORIGIN_ENV]: "  " , AGEND_INSTANCE_NAME: "x" }, false).ok).toBe(false);
  });

  it("…except under a test runner: a handler a test drives for real must not update the live fleet", () => {
    expect(judgeFleetControl({ [ORIGIN_ENV]: "slash /update by 1:2", VITEST: "true" }, false))
      .toEqual({ ok: false, reason: "test-runner" });
  });
});

describe("withOrigin", () => {
  it("makes a child of an agent session an authorised internal call, and leaves the rest of the env alone", () => {
    const env = withOrigin("agend-update", { AGEND_INSTANCE_NAME: "agend-leader", PATH: "/bin" });
    expect(env).toEqual({ AGEND_INSTANCE_NAME: "agend-leader", PATH: "/bin", [ORIGIN_ENV]: "agend-update" });
    expect(judgeFleetControl(env, false)).toEqual({ ok: true, via: "origin" });
  });
});

describe("describeCaller", () => {
  it("names this process and its parents, and what kind of session it is", () => {
    const caller = describeCaller({ AGEND_INSTANCE_NAME: "agend-leader", USER: "han" });
    expect(caller.pid).toBe(process.pid);
    expect(caller.chain[0]!.pid).toBe(process.pid);
    expect(caller.chain[0]!.command).not.toBe("");
    expect(caller.chain[1]!.pid).toBe(process.ppid);
    expect(caller.instance).toBe("agend-leader");
    expect(caller.user).toBe("han");
    expect(caller.origin).toBeNull();
  });

  it("is bounded", () => {
    expect(describeCaller({}, 1).chain).toHaveLength(1);
  });
});

describe("gateFleetControl", () => {
  it("records an allowed call BEFORE it goes ahead, with who is behind it", () => {
    const go = gateFleetControl(dir, "fleet-restart-reload", {}, { AGEND_HOME: dir });
    expect(go).toBe(true);
    const [entry] = audit();
    expect(entry).toMatchObject({ action: "fleet-restart-reload", outcome: "allowed", detail: "interactive" });
    expect(entry!.caller.chain[1]!.pid).toBe(process.ppid);
  });

  it("an agent session without --yes is refused, told why, and the refusal is on record", () => {
    const said: string[] = [];
    const go = gateFleetControl(dir, "restart", {}, { AGEND_INSTANCE_NAME: "agend-leader" }, m => said.push(m));
    expect(go).toBe(false);
    expect(said.join("\n")).toContain("agend-leader");
    expect(said.join("\n")).toContain("--yes");
    expect(said.join("\n")).toContain("backtick");
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({ action: "restart", outcome: "refused", detail: "agent-session" });
    expect(audit()[0]!.caller.instance).toBe("agend-leader");
  });

  it("with --yes it goes ahead and the audit says it was confirmed", () => {
    expect(gateFleetControl(dir, "update", { yes: true }, { AGEND_INSTANCE_NAME: "agend-leader" })).toBe(true);
    expect(audit()[0]).toMatchObject({ action: "update", outcome: "allowed", detail: "yes" });
  });

  it("a test-runner call is refused and says so", () => {
    const said: string[] = [];
    expect(gateFleetControl(dir, "update", { yes: true }, { VITEST: "true" }, m => said.push(m))).toBe(false);
    expect(said.join("\n")).toContain("test runner");
    expect(audit()[0]).toMatchObject({ outcome: "refused", detail: "test-runner" });
  });

  it("the origin marker authorises this command only: it is gone from the environment afterwards", () => {
    const env: NodeJS.ProcessEnv = { [ORIGIN_ENV]: "slash /update by 1:2", AGEND_INSTANCE_NAME: "agend-leader" };
    expect(gateFleetControl(dir, "update", {}, env)).toBe(true);
    expect(env[ORIGIN_ENV]).toBeUndefined();                       // what the command spawns next does not inherit it
    expect(judgeFleetControl(env, false)).toEqual({ ok: false, reason: "agent-session" });
    expect(audit()[0]!.caller.origin).toBe("slash /update by 1:2");   // …but the requester was recorded first
  });

  it("a refused call does not leave the marker behind either", () => {
    const env: NodeJS.ProcessEnv = { [ORIGIN_ENV]: "x", VITEST: "true" };
    expect(gateFleetControl(dir, "update", {}, env, () => {})).toBe(false);
    expect(env[ORIGIN_ENV]).toBeUndefined();
  });

  it("an unwritable data directory never stops a restart", () => {
    expect(gateFleetControl(join(dir, "missing", "deeper"), "fleet-stop", {}, {})).toBe(true);
  });
});

describe("the trail", () => {
  it("instance-level stop/restart are recorded and never blocked", () => {
    recordInstanceControl(dir, "instance-restart", "worker", { AGEND_INSTANCE_NAME: "agend-leader" });
    expect(audit()[0]).toMatchObject({ action: "instance-restart", target: "worker", outcome: "allowed" });
    expect(audit()[0]!.caller.instance).toBe("agend-leader");
  });

  it("the fleet names the requester when the signal arrives", () => {
    recordInternalRequest(dir, "update", "slash /update by telegram:42");
    const said = describeSignalSource(dir, "SIGTERM");
    expect(said).toContain("SIGTERM: requested by update");
    expect(said).toContain("slash /update by telegram:42");
  });

  it("an agent-session request is named with its session", () => {
    gateFleetControl(dir, "fleet-stop", { yes: true }, { AGEND_INSTANCE_NAME: "agend-leader" });
    expect(describeSignalSource(dir, "SIGTERM")).toContain("from agent session agend-leader");
  });

  it("an instance-level stop/restart is never named as the cause of a fleet signal", () => {
    gateFleetControl(dir, "fleet-restart-reload", { yes: true }, { AGEND_INSTANCE_NAME: "operator-session" });
    recordInstanceControl(dir, "instance-stop", "worker", { AGEND_INSTANCE_NAME: "agend-leader" });
    recordInstanceControl(dir, "instance-restart", "worker", { AGEND_INSTANCE_NAME: "agend-leader" });
    const said = describeSignalSource(dir, "SIGUSR1");
    expect(said).toContain("fleet-restart-reload");
    expect(said).not.toContain("instance-");
  });

  it("…and with only instance-level requests recorded, an outside signal is not blamed on one", () => {
    recordInstanceControl(dir, "instance-restart", "worker", {});
    expect(describeSignalSource(dir, "SIGTERM")).toContain("no fleet-control request recorded");
    expect(readRecentAudit(dir, 60_000)).toBeNull();
  });

  it("without a recent request it says so, so a service manager or kill is the next suspect", () => {
    expect(describeSignalSource(dir, "SIGTERM")).toContain("no fleet-control request recorded");
  });

  it("an old request, or a refused one, is not blamed", () => {
    gateFleetControl(dir, "restart", {}, { AGEND_INSTANCE_NAME: "a" }, () => {});          // refused
    expect(readRecentAudit(dir, 60_000)).toBeNull();
    gateFleetControl(dir, "fleet-stop", {}, {});
    expect(readRecentAudit(dir, 60_000)).not.toBeNull();
    expect(readRecentAudit(dir, 60_000, Date.now() + 10 * 60_000)).toBeNull();
  });

  it("a torn last line is skipped, not fatal", () => {
    gateFleetControl(dir, "fleet-stop", {}, {});
    writeFileSync(join(dir, AUDIT_FILE), `${readFileSync(join(dir, AUDIT_FILE), "utf8")}{"ts":"tor`, { flag: "w" });
    expect(readRecentAudit(dir, 60_000)).not.toBeNull();
  });

  it("the audit file is rotated, not grown for ever", () => {
    const big: AuditEntry = {
      ts: new Date().toISOString(), action: "fleet-stop", outcome: "allowed",
      caller: { ...describeCaller({}, 1), cwd: "x".repeat(600 * 1024) },
    };
    appendAudit(dir, big);
    appendAudit(dir, { ...big, caller: { ...big.caller, cwd: "" } });
    expect(existsSync(join(dir, `${AUDIT_FILE}.1`))).toBe(true);
    expect(audit()).toHaveLength(1);
  });

  it("the refusal text differs for the two causes", () => {
    expect(refusalMessage("fleet-stop", "agent-session", "a")).toContain("fleet agent session");
    expect(refusalMessage("fleet-stop", "test-runner", null)).toContain(ALLOW_TEST_ENV);
  });
});

describe("through the real CLI (scratch AGEND_HOME, nothing to stop)", () => {
  function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
    const merged: NodeJS.ProcessEnv = { ...process.env, AGEND_HOME: dir, NOTIFY_SOCKET: "", ...env };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return new Promise((resolve, reject) => {
      execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
        env: merged, timeout: 15_000,
      }, (error, stdout, stderr) => {
        if (!error) resolve({ code: 0, stdout, stderr });
        else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
        else reject(error);
      });
    });
  }
  const outOfTestRunner = { VITEST: undefined, VITEST_WORKER_ID: undefined, VITEST_POOL_ID: undefined, NODE_ENV: undefined };

  it.each([
    ["fleet", "stop"],
    ["fleet", "restart"],
    ["fleet", "restart", "--reload"],
  ])("`agend %s %s` from a fleet agent's session is refused before it does anything", async (...args) => {
    const result = await runCli(args, { ...outOfTestRunner, AGEND_INSTANCE_NAME: "agend-leader" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing");
    expect(result.stderr).toContain("agend-leader");
    expect(result.stdout + result.stderr).not.toContain("not running");   // it never got as far as looking
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({ outcome: "refused", detail: "agent-session" });
    expect(audit()[0]!.caller.chain.length).toBeGreaterThan(1);
  });

  it("with --yes the same session goes ahead (here: finds no fleet) and the audit says confirmed", async () => {
    const result = await runCli(["fleet", "stop", "--yes"], { ...outOfTestRunner, AGEND_INSTANCE_NAME: "agend-leader" });
    expect(result.stderr).toContain("Fleet is not running");
    expect(audit()[0]).toMatchObject({ action: "fleet-stop", outcome: "allowed", detail: "yes" });
  });

  it("a call from a test runner is refused", async () => {
    const result = await runCli(["fleet", "stop"], { VITEST: "true", AGEND_INSTANCE_NAME: undefined });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("test runner");
    expect(audit()[0]).toMatchObject({ outcome: "refused", detail: "test-runner" });
  });

  it("instance-level restart / stop are recorded and go through — to a local mock fleet, not the real one", async () => {
    const hits: string[] = [];
    const server: Server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { "Content-Type": "application/json" }).end("{}"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      writeFileSync(join(dir, "fleet.yaml"), `health_port: ${port}\ninstances: {}\n`);
      await runCli(["fleet", "restart", "worker"], { ...outOfTestRunner, AGEND_INSTANCE_NAME: "agend-leader" });
      await runCli(["fleet", "stop", "worker"], { ...outOfTestRunner, AGEND_INSTANCE_NAME: "agend-leader" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(hits).toEqual(["POST /restart/worker", "POST /stop/worker"]);
    expect(audit().map(entry => [entry.action, entry.target, entry.outcome, entry.caller.instance])).toEqual([
      ["instance-restart", "worker", "allowed", "agend-leader"],
      ["instance-stop", "worker", "allowed", "agend-leader"],
    ]);
  });

  it("an interactive user is not asked anything", async () => {
    const result = await runCli(["fleet", "stop"], { ...outOfTestRunner, AGEND_INSTANCE_NAME: undefined });
    expect(result.stderr).toContain("Fleet is not running");
    expect(audit()[0]).toMatchObject({ outcome: "allowed", detail: "interactive" });
  });
});

/**
 * The service-level commands (`stop`, `restart`, `update`) reach systemd and npm, so the CLI runs
 * with a PATH holding nothing but stubs that record the call and fail: if the gate were missing,
 * the command would walk into a stub (see `calls`), never into the real service. The `--yes`
 * controls prove the stubs really do intercept.
 */
describe("the service-level commands, behind inert stubs", () => {
  let inert: string;
  beforeEach(() => {
    inert = mkdtempSync(join(tmpdir(), "agend-1120-inert-"));
    mkdirSync(join(inert, "bin")); mkdirSync(join(inert, "home"));
    for (const command of ["systemctl", "npm", "sudo", "launchctl", "agend", "loginctl", "journalctl"]) {
      const path = join(inert, "bin", command);
      // npm also answers `prefix -g` (the scratch dir): the update locks that prefix before it installs (#1450 C1).
      const prefixAnswer = command === "npm" ? `[ "$1 $2" = "prefix -g" ] && { echo '${inert}'; exit 0; }\n` : "";
      writeFileSync(path, `#!/bin/sh\n${prefixAnswer}echo "${command} $@ ORIGIN=$AGEND_RESTART_ORIGIN" >> "${join(inert, "calls")}"\nexit 1\n`);
      chmodSync(path, 0o755);
    }
  });
  afterEach(() => { rmSync(inert, { recursive: true, force: true }); });

  const calls = (): string => existsSync(join(inert, "calls")) ? readFileSync(join(inert, "calls"), "utf8") : "";
  const run = (args: string[], instance: string | null, extraEnv: Record<string, string> = {}) => new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
      // env replaced, not extended: no VITEST, no real PATH, a scratch HOME
      env: {
        HOME: join(inert, "home"), AGEND_HOME: join(inert, "home", ".agend"), PATH: join(inert, "bin"), NOTIFY_SOCKET: "",
        ...(instance ? { AGEND_INSTANCE_NAME: instance } : {}),
        ...extraEnv,
      },
      timeout: 30_000,
    }, (error, _stdout, stderr) => {
      if (!error) resolve({ code: 0, stderr });
      else if (typeof error.code === "number") resolve({ code: error.code, stderr });
      else reject(error);
    });
  });

  it.each(["stop", "restart", "update"])("`agend %s` from a fleet agent's session is refused before it reaches a service manager or npm", async command => {
    const result = await run([command], "agend-leader");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Refusing \`agend ${command}\``);
    expect(calls()).toBe("");
  });

  it("an internal origin lets the command through but is not handed to what it starts", async () => {
    await run(["update"], "agend-leader", { AGEND_RESTART_ORIGIN: "slash /update by discord:admin" });
    expect(calls()).toContain("npm install");                       // it went ahead without --yes
    expect(calls()).toMatch(/npm install .*ORIGIN=\n/);              // …and npm, like any replacement fleet, saw no marker
    expect(calls()).not.toContain("slash /update");
  });

  it("control: with --yes `restart` does reach the (stubbed) service manager", async () => {
    await run(["restart", "--yes"], "agend-leader");
    expect(calls()).toContain("systemctl");
  });

  it("control: with --yes `update` does reach the (stubbed) npm", async () => {
    await run(["update", "--yes"], "agend-leader");
    expect(calls()).toContain("npm install");
  });

  it("an interactive user is not asked: `stop` just looks for a service", async () => {
    const result = await run(["stop"], null);
    expect(result.stderr).not.toContain("Refusing");
    expect(calls()).toBe("");
  });

  it("`agend update --yes` from an agent session: its own restart step is not refused as a second command", async () => {
    // Already up to date, but the running "fleet" started before the install — the one path that goes
    // straight to the restart step. The "fleet" is a decoy process; the CLI is a scratch copy of the
    // source whose mtime is in the future (= installed after the decoy started).
    const copy = join(inert, "copy");
    mkdirSync(copy);
    cpSync(join(process.cwd(), "src"), join(copy, "src"), { recursive: true });
    cpSync(join(process.cwd(), "launcher"), join(copy, "launcher"), { recursive: true });   // its own selection (#1450 C2)
    cpSync(join(process.cwd(), "package.json"), join(copy, "package.json"));
    symlinkSync(join(process.cwd(), "node_modules"), join(copy, "node_modules"));
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(copy, "src", "cli.ts"), future, future);
    const version = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version as string;
    // The copy is also what npm reports as the installed global package (#1449: before restarting a fleet that
    // predates the install, the update verifies that package and restarts through ITS `agend`): its bin is a wrapper
    // that runs this source through tsx, and that is the `agend` on PATH.
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    writeFileSync(join(copy, "package.json"), JSON.stringify({ ...manifest, bin: { agend: "bin/agend" } }));
    mkdirSync(join(copy, "bin"));
    // An installed package always has its canonical entry (#1450 C4); the update verifies it exists.
    mkdirSync(join(copy, "dist"));
    writeFileSync(join(copy, "dist", "cli.js"), "");
    // `install` is a no-op here (no service in this scratch HOME: the restart takes the detached path, whose
    // authorisation is what this test is about); everything else runs this source.
    writeFileSync(join(copy, "bin", "agend"), `#!/bin/sh\n[ "$1" = install ] && exit 0\nexec '${process.execPath}' --import tsx '${join(copy, "src", "cli.ts")}' "$@"\n`);
    chmodSync(join(copy, "bin", "agend"), 0o755);
    const globalRoot = join(inert, "global", "lib", "node_modules");
    mkdirSync(join(globalRoot, "@songsid"), { recursive: true });
    symlinkSync(copy, join(globalRoot, "@songsid", "agend"));
    mkdirSync(join(inert, "global", "bin"));
    symlinkSync(join(copy, "bin", "agend"), join(inert, "global", "bin", "agend"));   // the bin link npm makes
    rmSync(join(inert, "bin", "agend"));
    symlinkSync(join(copy, "bin", "agend"), join(inert, "bin", "agend"));
    for (const tool of ["sh", "readlink"]) symlinkSync(execFileSync("which", [tool], { encoding: "utf8" }).trim(), join(inert, "bin", tool));
    symlinkSync(process.execPath, join(inert, "bin", "node"));
    writeFileSync(join(inert, "bin", "npm"), `#!/bin/sh
case "$1 $2" in
  "view "*) echo ${version}; exit 0;;
  "root -g") echo '${globalRoot}'; exit 0;;
  "prefix -g") echo '${join(inert, "global")}'; exit 0;;
esac
echo "npm $@" >> "${join(inert, "calls")}"
exit 1
`);
    mkdirSync(join(inert, "home", ".agend"), { recursive: true });
    symlinkSync(execFileSync("which", ["ps"], { encoding: "utf8" }).trim(), join(inert, "bin", "ps"));   // process start time
    const decoy: ChildProcess = spawn("bash", ["-c", 'exec -a "agend fleet start" sleep 120'], { stdio: "ignore" });
    try {
      writeFileSync(join(inert, "home", ".agend", "fleet.pid"), `${decoy.pid}\n`);
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        // NODE_OPTIONS so the restart child the update spawns (a plain `node cli.ts restart`) can run the .ts too
        execFile(process.execPath, [join(copy, "src", "cli.ts"), "update", "--yes"], {
          // The detached restart's own `fleet start` (#1450 C5: this Node on the copy's cli.ts) is recorded by the test
          // process guard and never runs.
          env: { NODE_OPTIONS: "--import tsx", HOME: join(inert, "home"), AGEND_HOME: join(inert, "home", ".agend"), PATH: join(inert, "bin"), NOTIFY_SOCKET: "", AGEND_INSTANCE_NAME: "agend-leader", AGEND_TEST_SELF_SPAWN_LOG: join(inert, "self-spawn.log") },
          timeout: 60_000,
        }, (error, stdout, stderr) => {
          if (!error) resolve({ code: 0, stdout, stderr });
          else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
          else reject(error);
        });
      });
      expect(result.stdout + result.stderr, result.stdout + result.stderr).toContain("verified — restarting the fleet onto it"); // it reached the restart step
      expect(result.stderr).not.toContain("Refusing");
      const trail = readFileSync(join(inert, "home", ".agend", AUDIT_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line) as AuditEntry);
      expect(trail.map(entry => [entry.action, entry.outcome, entry.detail])).toEqual([
        ["update", "allowed", "yes"],
        ["restart", "allowed", "origin"],                                  // the child restart, authorised by the update
      ]);
      expect(readFileSync(join(inert, "self-spawn.log"), "utf8")).toBe("agend fleet start\n");   // …which restarted the fleet
    } finally {
      decoy.kill("SIGKILL");
    }
  });
});
