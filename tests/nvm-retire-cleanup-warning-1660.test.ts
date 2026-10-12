/**
 * #1660: on the nvm update route, a refused sudo removal of the old
 * root-owned copy is cleanup — not failure. The new version is installed,
 * verified and running, so the updater exits 0 with a warning that names the
 * manual removal, and chat /update reports success plus that cleanup line.
 * Every spawn and sudo below is stubbed; nothing touches npm, sudo or tmux.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { activateService } from "../src/service-activation.js";
import { reportUpdateRestart } from "../src/update-check.js";
import { activationSettled, newAgendInvocation, retireSystemCopy, runUpdateInstall } from "../src/update-install.js";
import { beginUpdateProgress, readUpdateProgress, setUpdateProgressStage as realSetStage } from "../src/update-marker.js";
import { formatRestartProgressCompletion } from "../src/restart-progress.js";
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

/** Stub runner: sudo uninstall fails (not passwordless), sudo root -g answers. */
function sudoRefusedRunner(seen: string[][], rootStdout: string | null) {
  return {
    run: (command: string, args: string[]) => {
      seen.push([command, ...args]);
      if (command !== "sudo") throw Error(`unexpected program ${command}`);
      if (args[0] !== "-n") throw Error(`sudo without -n would prompt: ${args.join(" ")}`);
      if (args.includes("uninstall")) return result(1, "sudo: a password is required");
      if (args.includes("root")) return rootStdout === null ? result(1, "sudo: a password is required") : result(0, rootStdout);
      throw Error(`unexpected sudo args ${args.join(" ")}`);
    },
    log: () => {},
  };
}

describe("retireSystemCopy: refused removal is a warning, not a failure", () => {
  it("sudo-refused removal succeeds with a warning naming the path and the manual command", () => {
    const seen: string[][] = [];
    const logs: string[] = [];
    const out = retireSystemCopy({ ...sudoRefusedRunner(seen, "/usr/local/lib/node_modules\n"), log: (m) => logs.push(m) }, NPM);
    expect(out.ok).toBe(true);
    if (!out.ok || !out.warning) throw Error("expected ok:true with warning");
    expect(out.warning).toContain("/usr/local/lib/node_modules/@songsid/agend");
    expect(out.warning).toContain(`sudo ${NPM} uninstall -g @songsid/agend`);
    expect(seen).toEqual([
      ["sudo", "-n", NPM, "uninstall", "-g", "@songsid/agend"],
      ["sudo", "-n", NPM, "root", "-g"],
    ]);
  });

  it("warning stands without the path when root lookup also fails", () => {
    const seen: string[][] = [];
    const out = retireSystemCopy({ ...sudoRefusedRunner(seen, null), log: () => {} }, NPM);
    expect(out.ok).toBe(true);
    if (!out.ok || !out.warning) throw Error("expected ok:true with warning");
    expect(out.warning).toContain(`sudo ${NPM} uninstall -g @songsid/agend`);
    expect(out.warning).not.toContain("still at");
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
        if (command === "npm" && args[0] === "install") return result(1, "", );
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
      if (args.includes("root")) return { ...w.result(), stdout: "/usr/local/lib/node_modules\n" };
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

describe("CLI: refused removal exits 0 with the warning recorded", () => {
  it("sudo-refused → exit 0, ⚠️ line, warning staged, sudo argv non-interactive", async () => {
    const h = cliRig(1);
    beginUpdateProgress(h.dataDir, { adapterId: "a", chatId: "c", messageId: "m" });
    await h.activate(h.verified, true);
    expect(h.process.exitCode).toBe(0);
    const logged = h.console.log.mock.calls.flat().join("\n");
    expect(logged).toContain("⚠️");
    expect(logged).toContain(`sudo ${NPM} uninstall -g @songsid/agend`);
    expect(h.console.error.mock.calls.flat().join("\n")).not.toContain("✗");
    const sudoCalls = h.commands.filter(c => c[0] === "sudo");
    expect(sudoCalls.length).toBeGreaterThan(0);
    for (const call of sudoCalls) expect(call[1]).toBe("-n");
    const warned = h.stages.filter(s => (s.details as { warning?: string } | undefined)?.warning);
    expect(warned.length).toBe(1);
    expect((warned[0].details as { warning: string }).warning).toContain("sudo");
  });
});

describe("chat /update shows success plus the cleanup line", () => {
  it("warning survives a marker stage round-trip", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "agend-1660-marker-")); roots.push(dir);
    beginUpdateProgress(dir, { adapterId: "a", chatId: "c", messageId: "m" });
    expect(realSetStage(dir, "starting", { warning: "remove it by hand: sudo x" })).toBe(true);
    expect(readUpdateProgress(dir)?.progress.warning).toBe("remove it by hand: sudo x");
  });

  it("complete summary carries the warning; absent without it; ignored off update mode", () => {
    const base = { running: 2, total: 2, version: "2.2.1", pausedNames: [] as string[] };
    const withWarning = formatRestartProgressCompletion("update", { ...base, warningText: "remove it by hand: sudo x" }, 0, 25_000);
    expect(withWarning).toContain("✅ Fleet restarted — v2.2.1, 2/2 instances running");
    expect(withWarning).toContain("⚠️ remove it by hand: sudo x");
    const plain = formatRestartProgressCompletion("update", base, 0, 25_000);
    expect(plain).not.toContain("⚠️");
    const restart = formatRestartProgressCompletion("restart", { ...base, warningText: "remove it by hand: sudo x" }, 0, 25_000);
    expect(restart).not.toContain("⚠️");
  });
});
