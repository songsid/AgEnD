/**
 * The install half of `agend update` (#1446): install the target release, prove the installed `agend` is that
 * release and can load its native module, and only then clean up anything the old install left behind.
 *
 * Order is the point. The current install is never removed before the new one has succeeded: npm replaces a global
 * package in place — including a global `npm link` in the same prefix — and leaves it untouched when the install
 * fails (verified with a failing-preinstall package on npm 10). The old updater ran `npm unlink -g @songsid/agend`
 * first, on a check that matched every normal global install, so a failed install left no agend at all.
 *
 * Every command goes through an injected runner, so the sequence is testable without npm, nvm or a fleet.
 */
import { join } from "node:path";

export interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  /** Run a program; `inherit` streams its output to the terminal (npm's progress), otherwise it is captured. */
  run(command: string, args: string[], options?: { inherit?: boolean; timeoutMs?: number }): CommandResult;
  /** Progress for the operator, printed when it happens. */
  log(message: string): void;
}

export interface UpdateInstallPlan {
  /** The npm spec to install, e.g. `@songsid/agend@2.2.0`. */
  pkg: string;
  /** The exact version that spec must produce, or null when only a dist-tag is known. */
  targetVersion: string | null;
  /** The npm global prefix is not writable: install under nvm's Node 22 instead (no sudo). */
  viaNvm: boolean;
  /** `~/.nvm/nvm.sh`. */
  nvmSh: string;
}

export type UpdateInstallOutcome =
  | { ok: true; agendPath: string; version: string }
  | { ok: false; stage: "install" | "verify"; message: string };

/** Shell prefix that puts nvm's Node 22 on PATH for the rest of the same `bash -c` (nvm only changes its own shell). */
function nvmPrefix(plan: UpdateInstallPlan): string {
  return `source ${JSON.stringify(plan.nvmSh)} >/dev/null 2>&1 && nvm use 22 >/dev/null 2>&1 && `;
}

/**
 * Run `argv` in the environment the new `agend` will run in: the parent's PATH for a direct install, nvm's Node 22
 * for an nvm install — so `agend`'s `#!/usr/bin/env node` and a bare `node` resolve to the same interpreter.
 * Arguments travel as positional parameters, never spliced into the script.
 */
function inInstallEnv(runner: CommandRunner, plan: UpdateInstallPlan, argv: string[], options: { inherit?: boolean; timeoutMs?: number } = {}): CommandResult {
  if (!plan.viaNvm) return runner.run(argv[0]!, argv.slice(1), options);
  return runner.run("bash", ["-c", `${nvmPrefix(plan)}"$@"`, "bash", ...argv], options);
}

/**
 * How to run the NEW `agend` after the install: directly, or — for an nvm install — inside nvm's Node 22, because its
 * `#!/usr/bin/env node` would otherwise pick the parent's (old) Node from PATH (#1446 item 1). Append the subcommand.
 */
export function newAgendInvocation(plan: Pick<UpdateInstallPlan, "viaNvm" | "nvmSh">, agendPath: string): { command: string; args: string[] } {
  if (!plan.viaNvm) return { command: agendPath, args: [] };
  return { command: "bash", args: ["-c", `${nvmPrefix(plan as UpdateInstallPlan)}"$@"`, "bash", agendPath] };
}

/** `npm link` leaves a symlink to a source checkout outside any node_modules tree; a registry install is a directory. */
export function isLocalLinkTarget(entryIsSymlink: boolean, realTarget: string): boolean {
  return entryIsSymlink && !realTarget.split("/").includes("node_modules");
}

/** Proves the native module loads AND works: on Node 20 better-sqlite3 13 imports fine and then SIGSEGVs on open. */
export const NATIVE_CHECK_SCRIPT = [
  "const { createRequire } = require('node:module');",
  "const req = createRequire(require('node:path').join(process.argv[1], 'package.json'));",
  "const Database = req('better-sqlite3');",
  "const db = new Database(':memory:');",
  "if (db.prepare('select 1 as one').get().one !== 1) process.exit(3);",
  "db.close();",
  "process.stdout.write('native-ok');",
].join(" ");

const normalizeVersion = (text: string): string => text.trim().replace(/^v/i, "");

export function runUpdateInstall(plan: UpdateInstallPlan, runner: CommandRunner): UpdateInstallOutcome {
  // A real local link is only reported: the install below replaces it in place, and a failed install leaves it.
  const root = runner.run("npm", ["root", "-g"], { timeoutMs: 15_000 });
  if (root.status === 0 && root.stdout.trim()) {
    const entry = join(root.stdout.trim(), "@songsid", "agend");
    const link = runner.run("readlink", [entry], { timeoutMs: 5_000 });
    if (link.status === 0) {
      const real = runner.run("readlink", ["-f", entry], { timeoutMs: 5_000 });
      if (real.status === 0 && isLocalLinkTarget(true, real.stdout.trim())) {
        runner.log(`  ⚠️  The global agend is a local npm link (${real.stdout.trim()}); the release install replaces it.`);
      }
    }
  }

  const install = plan.viaNvm
    ? runner.run("bash", ["-c", `source ${JSON.stringify(plan.nvmSh)} && nvm install 22 && nvm use 22 && npm install -g "$1"`, "bash", plan.pkg], { inherit: true })
    : runner.run("npm", ["install", "-g", plan.pkg], { inherit: true });
  if (install.status !== 0) {
    return {
      ok: false, stage: "install",
      message: plan.viaNvm ? "  Failed to install via nvm. The current install was not touched."
        : `  Failed to update; the current install was not touched. Try: npm install -g ${plan.pkg}`,
    };
  }

  const fail = (message: string): UpdateInstallOutcome => ({ ok: false, stage: "verify", message });
  const which = inInstallEnv(runner, plan, ["sh", "-c", "command -v agend"], { timeoutMs: 15_000 });
  const agendPath = which.stdout.trim().split("\n").pop() ?? "";
  if (which.status !== 0 || !agendPath) {
    return fail(`  ✗ Verification failed: agend not found in PATH after install.${plan.viaNvm ? " You may need to add nvm to your shell profile." : ""}`);
  }
  const versionRun = inInstallEnv(runner, plan, [agendPath, "--version"], { timeoutMs: 15_000 });
  if (versionRun.status !== 0) return fail(`  ✗ Verification failed: \`${agendPath} --version\` exited ${versionRun.status ?? versionRun.signal}.`);
  const version = normalizeVersion(versionRun.stdout);
  if (plan.targetVersion && version !== plan.targetVersion) {
    return fail(`  ✗ Verification failed: npm installed ${plan.pkg}, but \`agend\` on PATH (${agendPath}) is v${version}. Another install shadows it; remove that one and retry.`);
  }
  const real = runner.run("readlink", ["-f", agendPath], { timeoutMs: 5_000 });
  // <pkg>/dist/cli.js → <pkg>
  const pkgRoot = real.status === 0 ? real.stdout.trim().replace(/\/dist\/[^/]+$/, "") : "";
  if (!pkgRoot || pkgRoot === real.stdout.trim()) return fail(`  ✗ Verification failed: could not find the installed package behind ${agendPath}.`);
  const native = inInstallEnv(runner, plan, ["node", "-e", NATIVE_CHECK_SCRIPT, pkgRoot], { timeoutMs: 30_000 });
  if (native.status !== 0 || native.stdout.trim() !== "native-ok") {
    return fail(`  ✗ Verification failed: the installed package cannot open a database with this Node (${native.signal ?? `exit ${native.status}`}). ${native.stderr.trim().split("\n").pop() ?? ""}`.trimEnd());
  }

  // Only now is the new install proven: clean up the old system copy an nvm install leaves behind. Best effort, and
  // never waits for a password.
  if (plan.viaNvm) {
    runner.log("  Note: removing old system install (may require sudo)...");
    runner.run("sudo", ["-n", "npm", "uninstall", "-g", "@songsid/agend"], { inherit: true, timeoutMs: 10_000 });
  }
  return { ok: true, agendPath, version };
}
