/**
 * #1829, the minimum remedies:
 *  ⑥ a re-run that finds the target installed and NO fleet running must not say "Already up to date" — the pure
 *    predicate here; the real `agend update` runs in coredump-hotfix-1125.test.ts (no fleet.pid, a gone pid, a stale
 *    pid naming another process, an install that does not verify);
 *  - a failed chat /update names the one-line fix for the cases AgEnD knows (a small lookup over #1820's run output).
 * Never spawns the real `agend update`.
 */
import { EventEmitter } from "node:events";
import { closeSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PID, fleetProvenStopped, pidAlive, readFleetPidEvidence } from "../src/update-check.js";
import { openUpdateLog, updateFixHint, updateLogPath, watchUpdateLaunch } from "../src/update-launch.js";

describe("fleetProvenStopped (#1829 ⑥)", () => {
  const FLEET = "node /usr/lib/node_modules/@songsid/agend/dist/cli.js fleet start";
  const isFleet = (line: string) => /\bagend\b.*\bfleet start\b/.test(line) || line.includes("cli.js fleet start");
  const check = (pid: number | null, alive: boolean, line: string) =>
    fleetProvenStopped({ pid, alive: () => alive, commandLine: () => line, isFleetProcess: isFleet });

  it("stopped: no fleet.pid, a pid that is gone, a live pid that is another process", () => {
    expect(check(null, true, FLEET)).toBe(true);
    expect(check(4242, false, FLEET)).toBe(true);
    expect(check(4242, true, "/usr/bin/python3 some-tool.py")).toBe(true);
  });

  it("not proven stopped: a live fleet, or a live pid whose command line cannot be read", () => {
    expect(check(4242, true, FLEET)).toBe(false);
    expect(check(4242, true, "")).toBe(false);
  });
});

describe("pidAlive (#1829 review): only ESRCH proves a pid gone", () => {
  const throwing = (err: unknown) => () => { throw err; };
  it("ESRCH → gone; success, EPERM, or a refused argument → not proven gone", () => {
    expect(pidAlive(4242, throwing(Object.assign(new Error("x"), { code: "ESRCH" })))).toBe(false);
    expect(pidAlive(4242, () => true)).toBe(true);
    expect(pidAlive(4242, throwing(Object.assign(new Error("x"), { code: "EPERM" })))).toBe(true);
    expect(pidAlive(4242, throwing(Object.assign(new TypeError("x"), { code: "ERR_INVALID_ARG_TYPE" })))).toBe(true);
    expect(pidAlive(2147483648)).toBe(true);                              // the real call refuses it: not "gone"
  });
  it("the real call: a pid that exists, and one that does not", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2147483646)).toBe(false);                             // in range, no such process
  });
});

describe("readFleetPidEvidence (#1829 review): only a missing file is 'missing'", () => {
  const thrown = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
  it("ENOENT → missing; a whole positive pid → valid", () => {
    expect(readFleetPidEvidence("/x", thrown("ENOENT"))).toEqual({ kind: "missing" });
    expect(readFleetPidEvidence("/x", () => "4242\n")).toEqual({ kind: "valid", pid: 4242 });
    expect(readFleetPidEvidence("/x", () => " 17 ")).toEqual({ kind: "valid", pid: 17 });
  });
  it("unreadable, a directory, empty or malformed → unknown (never 'stopped')", () => {
    for (const code of ["EACCES", "EISDIR", "EIO"]) expect(readFleetPidEvidence("/x", thrown(code)), code).toEqual({ kind: "unknown" });
    for (const text of ["", "\n", "abc", "12 34", "0", "-5", "12abc", "1e3", "99999999999", "2147483648", "4294967295", "9999999999"]) {
      expect(readFleetPidEvidence("/x", () => text), JSON.stringify(text)).toEqual({ kind: "unknown" });
    }
  });
  it("the pid range process.kill takes: 2147483647 is the last valid one, 2147483648 the first unknown (review)", () => {
    expect(MAX_PID).toBe(2_147_483_647);
    expect(readFleetPidEvidence("/x", () => "2147483647")).toEqual({ kind: "valid", pid: 2147483647 });
    expect(readFleetPidEvidence("/x", () => "2147483648")).toEqual({ kind: "unknown" });
    expect(() => process.kill(2147483648, 0)).toThrow();                  // Node refuses it before asking the OS
  });

  it("the real file system: a missing file and a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1829-pid-"));
    try {
      expect(readFleetPidEvidence(join(dir, "fleet.pid"))).toEqual({ kind: "missing" });
      expect(readFleetPidEvidence(dir)).toEqual({ kind: "unknown" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

const ENOTEMPTY_10 = [
  "  Updating AgEnD v2.2.0-beta.10 → v2.2.0-beta.11...",
  "npm error code ENOTEMPTY",
  "npm error syscall rename",
  "npm error path /usr/lib/node_modules/@songsid/agend",
  "npm error dest /usr/lib/node_modules/@songsid/.agend-pW3rL0aX",
  "npm error errno -39",
  "npm error ENOTEMPTY: directory not empty, rename '/usr/lib/node_modules/@songsid/agend' -> '/usr/lib/node_modules/@songsid/.agend-pW3rL0aX'",
  "npm error A complete log of this run can be found in: /root/.npm/_logs/2026-10-14T13_00_00_000Z-debug-0.log",
].join("\n");
const RM = (dir: string) => `remove the directory an interrupted install left, then update again: \`rm -rf '${dir}' && agend update\``;

describe("updateFixHint (#1829): a small lookup", () => {
  it("npm ENOTEMPTY: remove exactly the directory npm names (npm 10 `dest`, npm 9 `ERR!`, or its rename message)", () => {
    expect(updateFixHint(ENOTEMPTY_10)).toBe(RM("/usr/lib/node_modules/@songsid/.agend-pW3rL0aX"));
    expect(updateFixHint(ENOTEMPTY_10.replace(/^npm error/gm, "npm ERR!"))).toBe(RM("/usr/lib/node_modules/@songsid/.agend-pW3rL0aX"));
    const renameOnly = ENOTEMPTY_10.split("\n").filter(l => !/ dest /.test(l)).join("\n");
    expect(updateFixHint(renameOnly)).toBe(RM("/usr/lib/node_modules/@songsid/.agend-pW3rL0aX"));
    // The bundled Node package's own staging directory is AgEnD's too.
    const runtime = ENOTEMPTY_10.replace(/\.agend-pW3rL0aX/g, ".agend-node-linux-x64-Qx_9-aZ1");
    expect(updateFixHint(runtime)).toBe(RM("/usr/lib/node_modules/@songsid/.agend-node-linux-x64-Qx_9-aZ1"));
  });

  it("ENOTEMPTY naming anything that is not AgEnD's own staging directory → no command at all", () => {
    for (const dest of [
      "/usr/lib/node_modules/.agend-pW3rL0aX",                // not under @songsid
      "/usr/lib/node_modules/@other/.agend-pW3rL0aX",         // another scope
      "/usr/lib/node_modules/@songsid/agend",                 // the package itself, not a staging copy
      "/usr/lib/node_modules/@songsid/.agend-*",              // a pattern
      "/usr/lib/node_modules/@songsid/.agend-a b",            // whitespace
      "/usr/lib/node_modules/@songsid/.agend-a'x",            // a quote
      "/usr/lib/node_modules/@songsid/.agend-$(id)",          // shell expansion
      "node_modules/@songsid/.agend-pW3rL0aX",                // relative
      "/usr/lib/node_modules/@songsid/.agend-pW3rL0aX ",      // trailing space: another name, never trimmed into this one
      " /usr/lib/node_modules/@songsid/.agend-pW3rL0aX",      // leading space
      "/usr/lib/node_modules/@songsid/.agend-pW3rL0aX\t",     // trailing tab
    ]) {
      const out = ENOTEMPTY_10.replace(/\/usr\/lib\/node_modules\/@songsid\/\.agend-pW3rL0aX/g, dest);
      expect(updateFixHint(out), dest).toBeNull();
    }
  });

  it("busless activation refusal → the one-time manual hop, with the target the updater printed", () => {
    const out = "  Updating AgEnD v2.2.0-beta.9 → v2.2.0-beta.11...\n  ✗ Restart refused: systemd does not know com.agend.fleet.service.\n";
    expect(updateFixHint(out)).toBe("`npm i -g @songsid/agend@2.2.0-beta.11 && agend restart`");
    expect(updateFixHint("  Updating AgEnD to beta...\n✗ systemd does not know com.agend.fleet.service")).toBe("`npm i -g @songsid/agend@beta && agend restart`");
    expect(updateFixHint("✗ systemd does not know com.agend.fleet.service")).toBe("`npm i -g @songsid/agend@<version> && agend restart`");
    // A target that is not a plain version or tag never reaches the command.
    expect(updateFixHint("  Updating AgEnD to beta;rm...\n✗ systemd does not know x")).toBe("`npm i -g @songsid/agend@<version> && agend restart`");
  });

  it("agend gone → reinstall it, ahead of anything else in the output", () => {
    expect(updateFixHint(ENOTEMPTY_10, { agendGone: true })).toBe("`npm install -g @songsid/agend@2.2.0-beta.11`");
    expect(updateFixHint("", { agendGone: true })).toBe("`npm install -g @songsid/agend@<version>`");
  });

  it("anything else → null (the generic advice stays)", () => {
    expect(updateFixHint("npm error code EACCES\nnpm error syscall mkdir")).toBeNull();
    expect(updateFixHint("")).toBeNull();
    expect(updateFixHint("the conversation mentioned ENOTEMPTY and systemd")).toBeNull();
  });
});

describe("watchUpdateLaunch: the fix goes into the failure message", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-1829-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const fakeChild = () => new EventEmitter() as any;
  const run = (output: string, agendPath?: string, beforeExit?: () => void) => {
    const logPath = updateLogPath(dir);
    const log = openUpdateLog(logPath, "--- /update test ---")!;
    writeFileSync(logPath, output, { flag: "a" });
    closeSync(log.fd);
    const child = fakeChild();
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath, log.offset, agendPath);
    beforeExit?.();
    child.emit("exit", 1, null);
    return messages;
  };

  it("ENOTEMPTY → `Fix: …rm -rf '<that dir>'…`, instead of the generic shell advice", () => {
    const [message] = run(ENOTEMPTY_10);
    expect(message).toContain(`Fix: ${RM("/usr/lib/node_modules/@songsid/.agend-pW3rL0aX")}`);
    expect(message).not.toContain("host shell");
  });

  it("the agend it launched is gone afterwards → reinstall; one that was never there is not 'gone'", () => {
    const agend = join(dir, "agend");
    writeFileSync(agend, "#!/bin/sh\n");
    const [gone] = run("  Updating AgEnD v2.2.0-beta.10 → v2.2.0-beta.11...\nnpm error code E500\n", agend, () => unlinkSync(agend));
    expect(gone).toContain("Fix: `npm install -g @songsid/agend@2.2.0-beta.11`");
    const [never] = run("npm error code E500\n", join(dir, "never-there"));
    expect(never).toContain("Run `agend update` from a host shell.");
    expect(never).not.toContain("Fix:");
  });

  it("an unknown failure keeps the generic advice", () => {
    const [message] = run("npm error code EACCES\nnpm error syscall mkdir\n");
    expect(message).toContain("Run `agend update` from a host shell.");
    expect(message).not.toContain("Fix:");
  });
});
