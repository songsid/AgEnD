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
  /**
   * Run a program; `inherit` streams its output to the terminal (npm's progress), otherwise it is captured. `env` is
   * added to this process's environment for that one program (the install token goes to npm and nothing else).
   */
  run(command: string, args: string[], options?: { inherit?: boolean; timeoutMs?: number; env?: Record<string, string> }): CommandResult;
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
  /**
   * #1450 C1: take the prefix lock for the realpath'd npm prefix this install will change, before npm runs; its token
   * is handed to npm as AGEND_INSTALL_TOKEN. Omitted: no lock (tests of the order alone).
   */
  lock?(prefix: string): { ok: true; token: string } | { ok: false; reason: string };
}

export type UpdateInstallOutcome =
  | { ok: true; agendPath: string; version: string; dir: string; bin: string; entry: string; node: string }
  | { ok: false; stage: "lock" | "install" | "verify"; message: string };

/**
 * The `bash -c` script that puts nvm's Node 22 on PATH for the rest of the same shell (nvm only changes its own shell),
 * then runs the remaining arguments. The nvm.sh path is DATA — positional `$1`, never spliced into the script — so a
 * path with `$`, spaces or quotes is sourced as written (#1449 review). `--no-use` keeps nvm.sh from reading our
 * arguments or switching to its default before `nvm use 22`.
 */
export const NVM_RUN_SCRIPT = 'n=$1; shift; . "$n" --no-use >/dev/null 2>&1 && nvm use 22 >/dev/null 2>&1 && "$@"';
/** Getting nvm's Node 22, before its prefix can be locked and installed into: `$1` = nvm.sh, as data. */
export const NVM_PREPARE_SCRIPT = 'n=$1; . "$n" --no-use && nvm install 22';

/**
 * Run `argv` in the environment the new `agend` will run in: the parent's PATH for a direct install, nvm's Node 22
 * for an nvm install — so `agend`'s `#!/usr/bin/env node` and a bare `node` resolve to the same interpreter.
 */
function inInstallEnv(runner: CommandRunner, plan: UpdateInstallPlan, argv: string[], options: { inherit?: boolean; timeoutMs?: number; env?: Record<string, string> } = {}): CommandResult {
  if (!plan.viaNvm) return runner.run(argv[0]!, argv.slice(1), options);
  return runner.run("bash", ["-c", NVM_RUN_SCRIPT, "bash", plan.nvmSh, ...argv], options);
}

/**
 * How to run the NEW `agend` after the install: directly, or — for an nvm install — inside nvm's Node 22, because its
 * `#!/usr/bin/env node` would otherwise pick the parent's (old) Node from PATH (#1446 item 1). Append the subcommand.
 */
export function newAgendInvocation(plan: Pick<UpdateInstallPlan, "viaNvm" | "nvmSh">, agendPath: string): { command: string; args: string[] } {
  if (!plan.viaNvm) return { command: agendPath, args: [] };
  return { command: "bash", args: ["-c", NVM_RUN_SCRIPT, "bash", plan.nvmSh, agendPath] };
}

/** `npm link` leaves a symlink to a source checkout outside any node_modules tree; a registry install is a directory. */
export function isLocalLinkTarget(entryIsSymlink: boolean, realTarget: string): boolean {
  return entryIsSymlink && !realTarget.split("/").includes("node_modules");
}

/**
 * The identity of what npm installed: `$1` is the package directory in npm's global root. Prints its name, version, the
 * REAL path of its `agend` bin target, so PATH's `agend` can be held to that exact file, and of its canonical inner
 * entry `dist/cli.js` (#1450 C4: what a service starts; since the launcher, not the bin).
 */
export const PACKAGE_IDENTITY_SCRIPT = [
  "const fs = require('node:fs'), path = require('node:path');",
  "const dir = process.argv[1];",
  "const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));",
  "const bin = typeof p.bin === 'string' ? p.bin : (p.bin || {}).agend;",
  "const real = f => { try { return fs.realpathSync(f); } catch (e) { return null; } };",
  "process.stdout.write(JSON.stringify({ name: p.name, version: p.version, dir: fs.realpathSync(dir), bin: bin ? real(path.join(dir, bin)) : null, entry: real(path.join(dir, 'dist', 'cli.js')) }));",
].join(" ");

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

/**
 * Prove the package npm installed — read from npm's own global root and prefix in the install environment — is the
 * one `agend` on PATH runs, reports `plan.targetVersion` (when known) and opens a database on the interpreter its
 * shebang resolves to. Used after an install, and before restarting a fleet that predates an earlier install (#1449
 * review: an update whose verification failed must not be completed by simply running `agend update` again).
 */
export function verifyInstalledPackage(plan: UpdateInstallPlan, runner: CommandRunner): UpdateInstallOutcome {
  const fail = (message: string): UpdateInstallOutcome => ({ ok: false, stage: "verify", message });
  const run = (argv: string[], timeoutMs = 15_000) => inInstallEnv(runner, plan, argv, { timeoutMs });
  const out = (r: CommandResult) => r.stdout.trim().split("\n").pop()?.trim() ?? "";

  // What npm installed, read from npm's own global root and prefix in the install environment — not from whatever
  // `agend` happens to win PATH (#1449 review: a same-version checkout earlier on PATH must not pass).
  const rootRun = run(["npm", "root", "-g"]);
  const prefixRun = run(["npm", "prefix", "-g"]);
  if (rootRun.status !== 0 || prefixRun.status !== 0 || !out(rootRun) || !out(prefixRun)) {
    return fail("  ✗ Verification failed: could not ask npm where it installed the package.");
  }
  const pkgDir = join(out(rootRun), "@songsid", "agend");
  const identityRun = run(["node", "-e", PACKAGE_IDENTITY_SCRIPT, pkgDir]);
  let identity: { name?: string; version?: string; dir?: string; bin?: string | null; entry?: string | null } = {};
  try { identity = JSON.parse(out(identityRun)); } catch { /* checked below */ }
  if (identityRun.status !== 0 || identity.name !== "@songsid/agend" || !identity.version || !identity.dir || !identity.bin || !identity.entry) {
    return fail(`  ✗ Verification failed: ${pkgDir} is not an installed @songsid/agend package.`);
  }
  const version = normalizeVersion(identity.version);
  if (plan.targetVersion && version !== plan.targetVersion) {
    return fail(`  ✗ Verification failed: npm installed v${version} at ${pkgDir}, not v${plan.targetVersion}.`);
  }
  const agendPath = join(out(prefixRun), "bin", "agend");
  const binReal = runner.run("readlink", ["-f", agendPath], { timeoutMs: 5_000 });
  if (binReal.status !== 0 || out(binReal) !== identity.bin) {
    return fail(`  ✗ Verification failed: ${agendPath} does not lead to the installed package (${identity.bin}).`);
  }
  // The `agend` the operator, the service refresh and the restart will run must be that same file.
  const which = run(["sh", "-c", "command -v agend"]);
  const onPath = out(which);
  const onPathReal = onPath ? runner.run("readlink", ["-f", onPath], { timeoutMs: 5_000 }) : null;
  if (which.status !== 0 || !onPathReal || onPathReal.status !== 0 || out(onPathReal) !== identity.bin) {
    return fail(`  ✗ Verification failed: npm installed v${version} at ${pkgDir}, but \`agend\` on PATH is ${onPath || "missing"}${onPathReal?.status === 0 ? ` (${out(onPathReal)})` : ""}. Another install shadows it; remove that one and retry.${plan.viaNvm && !onPath ? " You may need to add nvm to your shell profile." : ""}`);
  }
  const versionRun = run([agendPath, "--version"]);
  if (versionRun.status !== 0) return fail(`  ✗ Verification failed: \`${agendPath} --version\` exited ${versionRun.status ?? versionRun.signal}.`);
  if (normalizeVersion(out(versionRun)) !== version) {
    return fail(`  ✗ Verification failed: \`${agendPath} --version\` printed ${out(versionRun)}, but the installed package is v${version}.`);
  }
  const native = run(["node", "-e", NATIVE_CHECK_SCRIPT, identity.dir], 30_000);
  if (native.status !== 0 || out(native) !== "native-ok") {
    return fail(`  ✗ Verification failed: the installed package cannot open a database with this Node (${native.signal ?? `exit ${native.status}`}). ${native.stderr.trim().split("\n").pop() ?? ""}`.trimEnd());
  }

  // The interpreter that ran the native proof — the one `agend`'s `#!/usr/bin/env node` resolves to here. Activation
  // requires the service to run on exactly this one (service-activation.ts).
  const nodeRun = run(["sh", "-c", "command -v node"]);
  const nodeReal = out(nodeRun) ? runner.run("readlink", ["-f", out(nodeRun)], { timeoutMs: 5_000 }) : null;
  if (nodeRun.status !== 0 || !nodeReal || nodeReal.status !== 0 || !out(nodeReal)) {
    return fail("  ✗ Verification failed: could not resolve the Node the installed package runs on.");
  }
  return { ok: true, agendPath, version, dir: identity.dir, bin: identity.bin, entry: identity.entry, node: out(nodeReal) };
}

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

  if (plan.viaNvm && runner.run("bash", ["-c", NVM_PREPARE_SCRIPT, "bash", plan.nvmSh], { inherit: true }).status !== 0) {
    return { ok: false, stage: "install", message: "  Failed to install Node 22 via nvm. The current install was not touched." };
  }
  // C1: lock the prefix npm is about to change — read in the install environment, as npm itself sees it — before npm.
  const env: Record<string, string> = {};
  if (plan.lock) {
    const prefix = inInstallEnv(runner, plan, ["npm", "prefix", "-g"], { timeoutMs: 15_000 });
    const where = prefix.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (prefix.status !== 0 || !where) return { ok: false, stage: "lock", message: "  ✗ Could not ask npm which prefix it installs into; nothing was changed." };
    const lock = plan.lock(where);
    if (!lock.ok) return { ok: false, stage: "lock", message: `  ✗ Not updating: ${lock.reason}. Nothing was changed.` };
    env.AGEND_INSTALL_TOKEN = lock.token;
  }
  const install = inInstallEnv(runner, plan, ["npm", "install", "-g", plan.pkg], { inherit: true, env });
  if (install.status !== 0) {
    return {
      ok: false, stage: "install",
      message: plan.viaNvm ? "  Failed to install via nvm. The current install was not touched."
        : `  Failed to update; the current install was not touched. Try: npm install -g ${plan.pkg}`,
    };
  }

  const verified = verifyInstalledPackage(plan, runner);
  if (!verified.ok) return verified;

  // Only now is the new install proven: clean up the old system copy an nvm install leaves behind. Best effort, and
  // never waits for a password.
  if (plan.viaNvm) {
    runner.log("  Note: removing old system install (may require sudo)...");
    runner.run("sudo", ["-n", "npm", "uninstall", "-g", "@songsid/agend"], { inherit: true, timeoutMs: 10_000 });
  }
  return verified;
}
