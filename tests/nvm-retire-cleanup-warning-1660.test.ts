/**
 * #1660: on the nvm update route, a refused sudo removal of the old
 * root-owned copy is cleanup — not failure. The new version is installed,
 * verified and running, so the updater exits 0 with a warning plus a
 * verbatim manual command, and chat /update appends both to the same update
 * receipt once the retire outcome lands (separate lifecycles: the updater
 * retires only after the restart returns, so READY never waits for cleanup).
 * Every spawn and sudo below is stubbed; nothing touches npm, sudo or tmux.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { activateService } from "../src/service-activation.js";
import { FleetManager } from "../src/fleet-manager.js";
import { reportUpdateRestart } from "../src/update-check.js";
import { activationSettled, newAgendInvocation, retireSystemCopy, runUpdateInstall } from "../src/update-install.js";
import {
  beginFullRestartProgress,
  beginUpdateProgress,
  clearUpdateMarker,
  markCleanupPending,
  readUpdateProgress,
  updateReceiptOf,
  writeCleanupOutcome,
} from "../src/update-marker.js";
import { cleanupWatchVerdict, formatRestartProgressCompletion } from "../src/restart-progress.js";
import { setLocale } from "../src/locale.js";
import * as preimage from "../src/package-preimage.js";
import { activationWorld } from "./support/activation-world-1490.js";
import type { CommandResult, CommandRunner } from "../src/update-install.js";

const roots: string[] = [];
beforeEach(() => { setLocale("en"); });
afterEach(() => {
  setLocale("en");
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const NPM = "/home/u/.nvm/versions/node/v22.0.0/bin/npm";
const result = (status: number | null, stdout = ""): CommandResult => ({ status, signal: null, stdout, stderr: "" });

/** Split a shell line on single-quote-aware word boundaries (no execution). */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur = "", quote = false;
  for (const ch of line) {
    if (ch === "'") { quote = !quote; continue; }
    if (!quote && (ch === " " || ch === "\t")) { if (cur) { words.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}

/** Stub runner: sudo uninstall fails (not passwordless). No other sudo calls exist. */
function sudoRefusedRunner(seen: string[][]) {
  return {
    run: (command: string, args: string[]) => {
      seen.push([command, ...args]);
      if (command !== "sudo") throw Error(`unexpected program ${command}`);
      if (args[0] !== "-n") throw Error(`sudo without -n would prompt: ${args.join(" ")}`);
      if (args.includes("uninstall")) return result(1, "sudo: a password is required");
      throw Error(`unexpected sudo args ${args.join(" ")}`);
    },
    log: () => {},
  };
}

describe("retireSystemCopy: refused removal is a warning plus a verbatim command", () => {
  it("sudo-refused removal succeeds; the command is shell-quoted and single-word-safe", () => {
    const seen: string[][] = [];
    const logged: string[] = [];
    const out = retireSystemCopy({ ...sudoRefusedRunner(seen), log: (m) => logged.push(m) }, NPM);
    expect(out.ok).toBe(true);
    if (!out.ok) throw Error("expected ok:true");
    expect(out.warning).toContain("Old system install was not removed (sudo refused)");
    expect(out.warning).not.toContain(NPM);
    expect(out.cleanupCommand).toBe(`sudo '${NPM}' uninstall -g @songsid/agend`);
    expect(logged.filter(m => m.includes("⚠️") || m.includes("was not removed")),
      "the warning itself is printed once, by the caller (P3-1)").toEqual([]);
    expect(seen).toEqual([["sudo", "-n", NPM, "uninstall", "-g", "@songsid/agend"]]);
  });

  it("a spaced npm path stays one shell word in the manual command", () => {
    const spaced = "/home/u/with space/.nvm/versions/node/v22.0.0/bin/npm";
    const seen: string[][] = [];
    const out = retireSystemCopy({ ...sudoRefusedRunner(seen), log: () => {} }, spaced);
    expect(out.ok).toBe(true);
    if (!out.ok || !out.cleanupCommand) throw Error("expected ok:true with command");
    expect(shellWords(out.cleanupCommand)).toEqual(["sudo", spaced, "uninstall", "-g", "@songsid/agend"]);
  });

  it("successful removal has no warning and runs one sudo", () => {
    const seen: string[][] = [];
    const out = retireSystemCopy({
      run: (command: string, args: string[]) => { seen.push([command, ...args]); return result(0); },
      log: () => {},
    }, NPM);
    expect(out).toEqual({ ok: true });
    expect(seen).toEqual([["sudo", "-n", NPM, "uninstall", "-g", "@songsid/agend"]]);
  });

  it("missing npm path is still a failure (caller error, #1490)", () => {
    const out = retireSystemCopy({ run: () => result(0), log: () => {} }, undefined);
    expect(out.ok).toBe(false);
  });
});

describe("a real install failure still fails exactly as today", () => {
  it("failed npm install → {ok:false, stage:install}, no retire flag", () => {
    const runner: CommandRunner = {
      run: (command: string, args: string[]) => {
        if (command === "npm" && args[0] === "install") return result(1);
        return result(0);
      },
      log: () => {},
    };
    const outcome = runUpdateInstall(
      { pkg: "@songsid/agend@2.2.0", targetVersion: "2.2.0", viaNvm: false, nvmSh: "/none" }, runner);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw Error("expected failure");
    expect(outcome.stage).toBe("install");
    expect(outcome).not.toHaveProperty("retireSystemCopy");
  });
});

describe("cleanup receipt owner fence (update-marker helpers)", () => {
  function seed(target: { adapterId: string; chatId: string; messageId: string }, operation: "update" | "full-restart" = "update") {
    const dir = fs.mkdtempSync(join(tmpdir(), "agend-1660-receipt-")); roots.push(dir);
    if (operation === "update") beginUpdateProgress(dir, target);
    else beginFullRestartProgress(dir, target);
    return dir;
  }

  it("markCleanupPending returns the receipt and flags it", () => {
    const dir = seed({ adapterId: "a", chatId: "c", messageId: "m-1" });
    const receipt = markCleanupPending(dir);
    expect(receipt).not.toBeNull();
    expect(receipt).toMatchObject({ messageId: "m-1", operation: "update" });
    expect(readUpdateProgress(dir)?.progress.cleanup).toBe("pending");
  });

  it("write refuses a consumed marker (Prism a: fleet already cleared it)", () => {
    const dir = seed({ adapterId: "a", chatId: "c", messageId: "m-2" });
    const receipt = markCleanupPending(dir);
    clearUpdateMarker(dir);
    expect(writeCleanupOutcome(dir, receipt, { warning: "w", cleanupCommand: "c" })).toBe(false);
  });

  it("write refuses a replaced receipt (Prism b: full-restart adopted it)", () => {
    const dir = seed({ adapterId: "a", chatId: "c", messageId: "m-3" });
    const receipt = markCleanupPending(dir);
    clearUpdateMarker(dir);
    beginUpdateProgress(dir, { adapterId: "a", chatId: "c", messageId: "m-4" });
    expect(writeCleanupOutcome(dir, receipt, { warning: "w", cleanupCommand: "c" })).toBe(false);
    // The new receipt is untouched: no warning, no done flag.
    expect(readUpdateProgress(dir)?.progress.warning).toBeUndefined();
    expect(readUpdateProgress(dir)?.progress.cleanup).toBeUndefined();
  });

  it("write refuses a null receipt and lands on a match", () => {
    const dir = seed({ adapterId: "a", chatId: "c", messageId: "m-5" });
    expect(writeCleanupOutcome(dir, null, { warning: "w" })).toBe(false);
    const receipt = markCleanupPending(dir);
    expect(writeCleanupOutcome(dir, receipt, { warning: "w", cleanupCommand: "sudo x" })).toBe(true);
    const progress = readUpdateProgress(dir)?.progress;
    expect(progress?.warning).toBe("w");
    expect(progress?.cleanupCommand).toBe("sudo x");
    expect(progress?.cleanup).toBe("done");
  });

  it("cleanupCommand survives byte-exact (double spaces, long paths)", () => {
    const dir = seed({ adapterId: "a", chatId: "c", messageId: "m-6" });
    const receipt = markCleanupPending(dir);
    const cmd = `sudo '/home/u/with  two/.nvm/versions/node/v22.0.0/bin/npm' uninstall -g @songsid/agend`;
    const long = `sudo '/home/u/${"x".repeat(150)}/.nvm/versions/node/v22.23.3/bin/npm' uninstall -g @songsid/agend`;
    expect(writeCleanupOutcome(dir, receipt, { warning: "w", cleanupCommand: cmd })).toBe(true);
    expect(readUpdateProgress(dir)?.progress.cleanupCommand).toBe(cmd);
    const dir2 = seed({ adapterId: "a", chatId: "c", messageId: "m-7" });
    const receipt2 = markCleanupPending(dir2);
    expect(writeCleanupOutcome(dir2, receipt2, { warning: "w", cleanupCommand: long })).toBe(true);
    expect(readUpdateProgress(dir2)?.progress.cleanupCommand).toBe(long);
    expect(updateReceiptOf(null)).toBeNull();
  });
});

/** Exact production activateVerified closure with inert effects, adapted from activation-cli-1490. */
function cliRig(sudoUninstallStatus: number) {
  const root = fs.mkdtempSync(join(tmpdir(), "agend-1660-")); roots.push(root);
  const w = activationWorld(root), process = { exitCode: 0, getuid: () => 1000 };
  const console = { log: vi.fn(), error: vi.fn() }, stages: { stage: string; details?: unknown }[] = [], commands: string[][] = [];
  const source = fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.ES2022, true);
  const names = ["restartFleetForUpdate", "activateVerified", "refuses"];
  const closures = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast)) && node.initializer) closures.set(node.name.getText(ast), node.initializer.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast); for (const name of names) if (!closures.has(name)) throw Error(`CLI closure ${name} moved`);
  const spawnSync = vi.fn((command: string, args: string[]) => {
    commands.push([command, ...args]);
    if (command === "systemctl" || command === "busctl") return w.run(command, args);
    if (command === "sudo") {
      if (args.includes("uninstall")) return { ...w.result(), status: sudoUninstallStatus };
    }
    // viaNvm runs the verified binary through bash -c NVM_RUN_SCRIPT.
    if (command === "bash") {
      if (args.includes("restart")) { w.setRestart("restarted"); w.deps.restart(); return { ...w.result(), status: 0 }; }
      if (args.includes("install")) return w.deps.refresh();
      return w.result();
    }
    if (command !== w.entry) throw Error(`Unexpected inert program ${command}`);
    if (args[0] === "completion") return w.result();
    if (args[0] === "install") return w.deps.refresh();
    if (args[0] === "restart") {
      w.setRestart("restarted"); w.deps.restart();
      return { ...w.result(), status: 0 };
    }
    throw Error(`Unexpected inert CLI operation ${args[0]}`);
  });
  const dataDir = join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const modules: Record<string, unknown> = {
    "./update-install.js": { activationSettled, newAgendInvocation, retireSystemCopy },
    "./service-activation.js": { activateService },
    "./service-installer.js": { getSystemServicePath: () => null, getServicePath: () => w.unitPath, detectPlatform: () => "linux" },
    "./update-marker.js": {
      readUpdateProgress: () => readUpdateProgress(dataDir),
      setUpdateProgressStage: (dir: string, stage: string, details?: unknown) => { stages.push({ stage, details }); return true; },
      markCleanupPending: () => markCleanupPending(dataDir),
      writeCleanupOutcome: (dir: string, receipt: unknown, outcome: unknown) =>
        writeCleanupOutcome(dir, receipt as never, outcome as never),
    },
    "node:fs": fs, "./package-preimage.js": { restorePackagePreimage: vi.fn(preimage.restorePackagePreimage), prunePreimages: vi.fn(preimage.prunePreimages) },
  };
  const context = createContext({ process, console, join, Promise, DATA_DIR: dataDir, nvmSh: join(root, "unused-nvm.sh"), SYSTEMD_RESTART_TIMEOUT_MS: 1,
    spawnSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, realpathSync: fs.realpathSync, statSync: fs.statSync,
    withOrigin: () => ({}), setUpdateProgressStage: (dir: string, stage: string, details?: unknown) => { stages.push({ stage, details }); return true; }, clearUpdateMarker: vi.fn(),
    reportUpdateRestart: (value: number | null) => reportUpdateRestart(value, console),
    load: async (name: string) => { if (!(name in modules)) throw Error(`Unexpected inert import ${name}`); return modules[name]; },
    opts: { force: false },
  });
  const script = names.map(name => `const ${name} = ${closures.get(name)};`).join("\n");
  runInContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll("import(", "load("), context);
  const activate = runInContext("activateVerified", context) as (verified: unknown, viaNvm: boolean) => Promise<void>;
  const verified = { ...w.verified, agendPath: w.entry, version: "2.2.0", rollback: { root: w.npmRoot, prefix: w.prefix, preimage: w.preimage }, retireSystemCopy: true, npmPath: NPM };
  return { w, process, console, stages, commands, activate, verified, dataDir };
}

describe("CLI: refused removal exits 0, prints once, records against its receipt", () => {
  it("sudo-refused → exit 0, one ⚠️ print, fenced marker write, sudo argv non-interactive", async () => {
    const h = cliRig(1);
    beginUpdateProgress(h.dataDir, { adapterId: "a", chatId: "c", messageId: "m" });
    await h.activate(h.verified, true);
    expect(h.process.exitCode).toBe(0);
    const logged = h.console.log.mock.calls.flat().join("\n");
    expect(logged.match(/⚠️/g)?.length, "exactly one warning print (P3-1)").toBe(1);
    expect(logged).toContain(`$ sudo '${NPM}' uninstall -g @songsid/agend`);
    expect(h.console.error.mock.calls.flat().join("\n")).not.toContain("✗");
    const sudoCalls = h.commands.filter(c => c[0] === "sudo");
    expect(sudoCalls.length).toBeGreaterThan(0);
    for (const call of sudoCalls) expect(call[1]).toBe("-n");
    const stored = readUpdateProgress(h.dataDir)?.progress;
    expect(stored?.cleanup).toBe("done");
    expect(stored?.warning).toContain("Old system install was not removed");
    expect(stored?.cleanupCommand).toBe(`sudo '${NPM}' uninstall -g @songsid/agend`);
  });
});

describe("cleanupWatchVerdict: the post-completion watch state machine", () => {
  const target = { adapterId: "a", chatId: "c", messageId: "m-1" };
  function markerWith(progress: Record<string, unknown>, startedAt = 1_000_000) {
    return { startedAt, pid: 1, progress: { operation: "update", stage: "starting", target, ...progress } } as never;
  }
  const receipt = { startedAt: 1_000_000, messageId: "m-1", operation: "update" } as const;

  it("append when the owed outcome lands on the same receipt", () => {
    expect(cleanupWatchVerdict(
      markerWith({ cleanup: "done", warning: "w", cleanupCommand: "sudo x" }), { ...receipt }, 1_000_001))
      .toEqual({ action: "append", warning: "w", cleanupCommand: "sudo x" });
  });

  it("release on done-silent and on updater death past the max age", () => {
    expect(cleanupWatchVerdict(markerWith({ cleanup: "done" }), { ...receipt }, 1_000_001))
      .toEqual({ action: "release" });
    expect(cleanupWatchVerdict(
      markerWith({ cleanup: "pending" }), { ...receipt }, 1_000_000 + 15 * 60_000 + 1))
      .toEqual({ action: "release" });
  });

  it("drop on gone or replaced receipts; wait while fresh and pending", () => {
    expect(cleanupWatchVerdict(null, { ...receipt }, 1_000_001)).toEqual({ action: "drop" });
    expect(cleanupWatchVerdict(
      markerWith({ cleanup: "pending" }, 2_000_000), { ...receipt }, 2_000_001)).toEqual({ action: "drop" });
    expect(cleanupWatchVerdict(
      { startedAt: 1_000_000, pid: 1, progress: { operation: "full-restart", stage: "stopping", target } } as never,
      { ...receipt }, 1_000_001)).toEqual({ action: "drop" });
    expect(cleanupWatchVerdict(markerWith({ cleanup: "pending" }), { ...receipt }, 1_000_001))
      .toEqual({ action: "wait" });
    expect(cleanupWatchVerdict(markerWith({}), { ...receipt }, 1_000_001)).toEqual({ action: "wait" });
  });

  it("age boundary: exactly at the max age still appends, one millisecond later releases", () => {
    const done = markerWith({ cleanup: "done", warning: "w", cleanupCommand: "sudo x" });
    expect(cleanupWatchVerdict(done, { ...receipt }, 1_000_000 + 15 * 60_000))
      .toEqual({ action: "append", warning: "w", cleanupCommand: "sudo x" });
    expect(cleanupWatchVerdict(done, { ...receipt }, 1_000_000 + 15 * 60_000 + 1))
      .toEqual({ action: "release" });
  });
});

describe("cleanup watch wiring on the fleet (Prism a/b)", () => {
  const target = { adapterId: "a", chatId: "c", messageId: "m-1" };
  const summary = { running: 2, total: 2, version: "2.2.1", pausedNames: [] as string[] };

  function fleetWithMarker() {
    const dir = fs.mkdtempSync(join(tmpdir(), "agend-1660-fleet-")); roots.push(dir);
    beginUpdateProgress(dir, target);
    const receipt = markCleanupPending(dir);
    if (!receipt) throw Error("pending not marked");
    writeCleanupOutcome(dir, receipt, { warning: "Old system install was not removed (sudo refused); remove it by hand.", cleanupCommand: "sudo x" });
    const fm = new FleetManager(dir) as any;
    const edits: string[] = [];
    fm.adapters = new Map([["a", { editMessage: async (_c: string, _m: string, text: string) => { edits.push(text); } }]]);
    fm.updateCleanupWatch = { receipt, summary };
    return { fm, dir, receipt, edits };
  }

  it("arming the watch starts the monitor (Prism a)", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "agend-1660-arm-")); roots.push(dir);
    const fm = new FleetManager(dir) as any;
    expect(fm.updateProgressTimer).toBeNull();
    fm.armCleanupWatch({ startedAt: 1, messageId: "m", operation: "update" }, summary);
    expect(fm.updateCleanupWatch).not.toBeNull();
    expect(fm.updateProgressTimer, "monitor runs so the owed outcome is actually watched").not.toBeNull();
    clearInterval(fm.updateProgressTimer);
    fm.updateProgressTimer = null;
    fm.updateCleanupWatch = null;
  });

  it("append delivers to the adapter and releases our receipt", async () => {
    const { fm, dir, receipt, edits } = fleetWithMarker();
    await fm.appendCleanupWarning(target, { receipt, summary }, "Old system install was not removed (sudo refused); remove it by hand.", "sudo x");
    expect(edits.length).toBe(1);
    expect(edits[0]).toContain("✅ AgEnD updated");
    expect(edits[0]).toContain("⚠️ Old system install was not removed");
    expect(edits[0]).toContain("`$ sudo x`");
    expect(readUpdateProgress(dir)).toBeNull();
    expect(fm.updateCleanupWatch).toBeNull();
  });

  it("a newer receipt landing mid-edit is left entirely alone (Prism b)", async () => {
    const { fm, dir, receipt, edits } = fleetWithMarker();
    fm.adapters.get("a").editMessage = async () => {
      edits.push("edit");
      // B's full-restart receipt lands while A's edit is in flight.
      clearUpdateMarker(dir);
      beginFullRestartProgress(dir, { adapterId: "a", chatId: "c", messageId: "m-B" });
    };
    await fm.appendCleanupWarning(target, { receipt, summary }, "w", "sudo x");
    expect(edits.length).toBe(1);
    const current = readUpdateProgress(dir);
    expect(current?.progress.operation).toBe("full-restart");
    expect(current?.progress.target.messageId).toBe("m-B");
    expect(fm.updateCleanupWatch).toBeNull();
  });
});

describe("chat /update shows success plus the cleanup lines", () => {
  it("complete summary carries warning and command; absent without them; ignored off update mode", () => {
    const base = { running: 2, total: 2, version: "2.2.1", pausedNames: [] as string[] };
    const cmd = `sudo '/home/u/${"x".repeat(150)}/.nvm/versions/node/v22.23.3/bin/npm' uninstall -g @songsid/agend`;
    const withWarning = formatRestartProgressCompletion(
      "update", { ...base, warningText: "Old system install was not removed (sudo refused); remove it by hand.", warningCommand: cmd }, 0, 25_000);
    expect(withWarning).toContain("✅ AgEnD updated to v2.2.1; 2/2 agents running");
    expect(withWarning).toContain("⚠️ Old system install was not removed");
    expect(withWarning).toContain(`\`$ ${cmd}\``);
    const plain = formatRestartProgressCompletion("update", base, 0, 25_000);
    expect(plain).not.toContain("⚠️");
    expect(plain).not.toContain("$ sudo");
    const restart = formatRestartProgressCompletion(
      "restart", { ...base, warningText: "w", warningCommand: "c" }, 0, 25_000);
    expect(restart).not.toContain("⚠️");
  });
});
