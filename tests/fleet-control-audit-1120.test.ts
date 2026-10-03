import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      writeFileSync(path, `#!/bin/sh\necho "${command} $@" >> "${join(inert, "calls")}"\nexit 1\n`);
      chmodSync(path, 0o755);
    }
  });
  afterEach(() => { rmSync(inert, { recursive: true, force: true }); });

  const calls = (): string => existsSync(join(inert, "calls")) ? readFileSync(join(inert, "calls"), "utf8") : "";
  const run = (args: string[], instance: string | null) => new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
      // env replaced, not extended: no VITEST, no real PATH, a scratch HOME
      env: {
        HOME: join(inert, "home"), AGEND_HOME: join(inert, "home", ".agend"), PATH: join(inert, "bin"), NOTIFY_SOCKET: "",
        ...(instance ? { AGEND_INSTANCE_NAME: instance } : {}),
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
});
