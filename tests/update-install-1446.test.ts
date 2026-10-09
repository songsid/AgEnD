/**
 * #1446: `agend update` must never remove the current install before the new one has succeeded, must verify the new
 * install in the environment it will run in (nvm's Node, #1446 item 1), must prove the version and a working native
 * module (item 3), and must report a definite systemd restart failure (item 4).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { systemdRestartOutcome } from "../src/service-installer.js";
import { isLocalLinkTarget, newAgendInvocation, runUpdateInstall, type CommandResult, type CommandRunner, type UpdateInstallPlan } from "../src/update-install.js";

const ok = (stdout = ""): CommandResult => ({ status: 0, signal: null, stdout, stderr: "" });
const failed = (status = 1, stderr = ""): CommandResult => ({ status, signal: null, stdout: "", stderr });
const PKG_ROOT = "/usr/lib/node_modules/@songsid/agend";

/** A scripted runner: answers by matching the joined command line, records every call in order. */
function scripted(answers: Array<[RegExp, CommandResult]>) {
  const calls: string[] = [];
  const logs: string[] = [];
  const runner: CommandRunner = {
    run: (command, args) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      return answers.find(([pattern]) => pattern.test(line))?.[1] ?? failed(127, `unscripted: ${line}`);
    },
    log: message => { logs.push(message); },
  };
  return { runner, calls, logs };
}

const direct: UpdateInstallPlan = { pkg: "@songsid/agend@2.2.0", targetVersion: "2.2.0", viaNvm: false, nvmSh: "/home/u/.nvm/nvm.sh" };
const viaNvm: UpdateInstallPlan = { ...direct, viaNvm: true };
const healthy = (version = "2.2.0"): Array<[RegExp, CommandResult]> => [
  [/^npm root -g$/, ok("/usr/lib/node_modules\n")],
  [/^readlink \/usr\/lib\/node_modules\/@songsid\/agend$/, failed()],            // a directory, not a link
  [/npm install -g/, ok()],
  [/command -v agend/, ok("/usr/bin/agend\n")],
  [/\/usr\/bin\/agend --version$/, ok(`${version}\n`)],
  [/^readlink -f \/usr\/bin\/agend$/, ok(`${PKG_ROOT}/dist/cli.js\n`)],
  [/node -e .*native-ok.* \/usr\/lib\/node_modules\/@songsid\/agend$/, ok("native-ok")],
  [/^sudo -n npm uninstall -g @songsid\/agend$/, ok()],
];
const isMutation = (line: string) => /\b(?:unlink|uninstall|install -g)\b/.test(line);

describe("P0: the current install is never removed before the new one has succeeded", () => {
  it("a normal global install (the old check took '@songsid' for a link) is installed over, nothing removed first", () => {
    const { runner, calls } = scripted(healthy());
    expect(runUpdateInstall(direct, runner)).toMatchObject({ ok: true, version: "2.2.0" });
    expect(calls.find(isMutation)).toBe("npm install -g @songsid/agend@2.2.0");
    expect(calls.some(line => /\bunlink\b/.test(line))).toBe(false);
  });

  it("a REAL local link is reported and installed over in place — still no unlink", () => {
    const { runner, calls, logs } = scripted([
      [/^readlink \/usr\/lib\/node_modules\/@songsid\/agend$/, ok("../../../../home/u/src/agend\n")],
      [/^readlink -f \/usr\/lib\/node_modules\/@songsid\/agend$/, ok("/home/u/src/agend\n")],
      ...healthy(),
    ]);
    expect(runUpdateInstall(direct, runner).ok).toBe(true);
    expect(logs.join("\n")).toContain("local npm link (/home/u/src/agend)");
    expect(calls.find(isMutation)).toBe("npm install -g @songsid/agend@2.2.0");
    expect(calls.some(line => /\bunlink\b/.test(line))).toBe(false);
  });

  it.each([["direct", direct], ["nvm", viaNvm]] as const)("a failed install (%s) touches nothing else", (_name, plan) => {
    const { runner, calls } = scripted([[/npm install -g/, failed(1, "preinstall guard")], ...healthy()]);
    const outcome = runUpdateInstall(plan, runner);
    expect(outcome).toMatchObject({ ok: false, stage: "install" });
    expect(calls.filter(isMutation)).toHaveLength(1);                 // the install, and nothing after it
    expect(calls.at(-1)).toMatch(/npm install -g/);
  });

  it("the update command no longer carries its own unlink step", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(cli).not.toMatch(/npm unlink -g @songsid\/agend/);
    expect(cli).not.toMatch(/resolved\.includes\("@songsid"\)/);
  });

  it.each([
    [false, "/usr/lib/node_modules/@songsid/agend", false],
    [true, "/home/u/Projects/AgEnD/", true],
    [true, "/home/u/.local/share/pnpm/global/5/node_modules/@songsid/agend", false],
  ])("isLocalLinkTarget(symlink=%s, %s) = %s", (symlink, target, expected) => {
    expect(isLocalLinkTarget(symlink, target)).toBe(expected);
  });
});

describe("item 1: an nvm install is verified, restarted and cleaned up inside nvm's Node 22", () => {
  it("every check after the install runs through `nvm use 22`, and the old system copy goes only after they pass", () => {
    const { runner, calls } = scripted(healthy());
    expect(runUpdateInstall(viaNvm, runner).ok).toBe(true);
    const afterInstall = calls.slice(calls.findIndex(line => /npm install -g/.test(line)) + 1);
    for (const check of [/command -v agend/, /--version/, /node -e/]) {
      const line = afterInstall.find(l => check.test(l))!;
      expect(line, String(check)).toMatch(/^bash -c source "\/home\/u\/\.nvm\/nvm\.sh" >\/dev\/null 2>&1 && nvm use 22 >\/dev\/null 2>&1 && "\$@" bash /);
    }
    const uninstall = calls.findIndex(line => /sudo -n npm uninstall/.test(line));
    expect(uninstall).toBeGreaterThan(calls.findIndex(line => /node -e/.test(line)));
    expect(uninstall).toBe(calls.length - 1);
  });

  it("a failed verification keeps the old system copy", () => {
    const { runner, calls } = scripted([[/node -e/, { status: null, signal: "SIGSEGV", stdout: "", stderr: "" }], ...healthy()]);
    expect(runUpdateInstall(viaNvm, runner)).toMatchObject({ ok: false, stage: "verify" });
    expect(calls.some(line => /uninstall/.test(line))).toBe(false);
  });

  it("the new agend's later commands (install, completion, restart) run in the same environment", () => {
    expect(newAgendInvocation(direct, "/usr/bin/agend")).toEqual({ command: "/usr/bin/agend", args: [] });
    const nvm = newAgendInvocation(viaNvm, "/home/u/.nvm/versions/node/v22.14.0/bin/agend");
    expect(nvm.command).toBe("bash");
    expect(nvm.args).toEqual(["-c", 'source "/home/u/.nvm/nvm.sh" >/dev/null 2>&1 && nvm use 22 >/dev/null 2>&1 && "$@"', "bash", "/home/u/.nvm/versions/node/v22.14.0/bin/agend"]);
  });
});

describe("item 3: verification proves the version and a working native module", () => {
  it("another agend shadowing the new one on PATH (other version) fails verification", () => {
    const { runner } = scripted(healthy("2.1.12"));
    const outcome = runUpdateInstall(direct, runner);
    expect(outcome).toMatchObject({ ok: false, stage: "verify" });
    expect(!outcome.ok && outcome.message).toContain("is v2.1.12");
  });

  it("--version passing is not enough: a SIGSEGV opening the database fails verification", () => {
    const { runner } = scripted([[/node -e/, { status: null, signal: "SIGSEGV", stdout: "", stderr: "" }], ...healthy()]);
    const outcome = runUpdateInstall(direct, runner);
    expect(outcome).toMatchObject({ ok: false, stage: "verify" });
    expect(!outcome.ok && outcome.message).toContain("cannot open a database");
  });

  it("an unknown target version (a dist-tag only) still needs the native check", () => {
    const { runner, calls } = scripted(healthy("2.2.1"));
    expect(runUpdateInstall({ ...direct, targetVersion: null, pkg: "@songsid/agend@latest" }, runner)).toMatchObject({ ok: true, version: "2.2.1" });
    expect(calls.some(line => /node -e/.test(line))).toBe(true);
  });
});

describe("item 4: systemctl restart outcomes", () => {
  it("our wait running out is indeterminate; systemctl's own error is a failure", () => {
    expect(systemdRestartOutcome("agend", false, vi.fn())).toBe("restarted");
    expect(systemdRestartOutcome("agend", false, () => { throw Object.assign(new Error("spawnSync systemctl ETIMEDOUT"), { code: "ETIMEDOUT" }); })).toBe("timed-out");
    expect(systemdRestartOutcome("agend", false, () => { throw Object.assign(new Error("Command failed"), { status: 1 }); })).toBe("failed");
  });
});

// The real thing, offline: npm on a scratch prefix, local tarballs, the production runner shape.
describe("real npm (scratch prefix, local tarballs): a failed install leaves the current one in place", () => {
  const root = mkdtempSync(join(tmpdir(), "agend-1446-npm-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, "prefix");
  const env = { ...process.env, npm_config_prefix: prefix, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  const pack = (version: string, preinstall?: string): string => {
    const dir = join(root, `src-${version}`);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@songsid/agend", version, bin: { agend: "dist/cli.js" }, ...(preinstall ? { scripts: { preinstall } } : {}) }));
    writeFileSync(join(dir, "dist", "cli.js"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)})\n`);
    chmodSync(join(dir, "dist", "cli.js"), 0o755);
    const out = execFileSync("npm", ["pack", "--silent", "--pack-destination", root], { cwd: dir, env, encoding: "utf8" }).trim().split("\n").pop()!;
    return join(root, out);
  };
  const runner: CommandRunner = {
    run: (command, args) => {
      const r = spawnSync(command, args, { encoding: "utf8", env: { ...env, PATH: `${join(prefix, "bin")}:${process.env.PATH}` } });
      return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    log: () => {},
  };

  it("current 2.1.12 stays installed and runnable when 2.2.0's preinstall fails", () => {
    execFileSync("npm", ["install", "-g", pack("2.1.12")], { env, stdio: "ignore" });
    const outcome = runUpdateInstall({ pkg: pack("2.2.0", "exit 1"), targetVersion: "2.2.0", viaNvm: false, nvmSh: "/nonexistent" }, runner);
    expect(outcome).toMatchObject({ ok: false, stage: "install" });
    expect(existsSync(join(prefix, "lib", "node_modules", "@songsid", "agend", "package.json"))).toBe(true);
    expect(execFileSync(join(prefix, "bin", "agend"), { encoding: "utf8" }).trim()).toBe("2.1.12");
  }, 120_000);
});
