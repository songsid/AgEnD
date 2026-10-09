/**
 * #1450 C6, "Restart refuses an unverified transition", path 1: restart an UNCHANGED loaded job. Before `agend restart`
 * stops anything, the definition the service manager has LOADED must start exactly what this package's own selection
 * protocol (C2) expects, run fresh now:
 *   - its selected interpreter, NAMED (a 2.1-format definition — a script as argv[0], its Node left to `env node` and
 *     the unit's PATH — never matches: after the hop that is the old Node running the new package);
 *   - this package's canonical entry, then exactly `fleet start`;
 *   - no interpreter-affecting environment, and the bundled runtime's directory on no PATH;
 *   - and the loaded definition is the file on disk (no reload pending).
 * Otherwise the restart refuses, signalling and stopping nothing. `--force` is for operators; an updater never uses it.
 * (Path 2, launchd's planned activation of a proven new plist, is the update flow's — not this module.)
 */
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonicalCliEntry } from "./cli-entry.js";
import {
  INTERPRETER_ENV, parseLaunchctlPrint, parsePlist, readLoadedUnit, sameJob,
  type ActivationTuple, type TupleDeps,
} from "./service-activation.js";
import type { CommandResult } from "./update-install.js";

export interface ExpectedTuple {
  /** The selected interpreter, a realpath. */
  node: string;
  /** canonicalCliEntry(): `<pkg>/dist/cli.js`. */
  entry: string;
}

export type Judgement = { ok: true } | { ok: false; reason: string };

interface Selection { ok: boolean; node?: string; reason?: string; recovery?: string }

/** What this package's launcher would choose right now (launcher/runtime-select.cjs, C2). */
export function expectedTuple(
  select: (launcherDir: string) => Selection = launcherDir => createRequire(import.meta.url)("../launcher/runtime-select.cjs").selectRuntime(launcherDir),
  entry: string = canonicalCliEntry(),
): { ok: true; expected: ExpectedTuple } | { ok: false; reason: string } {
  const chosen = select(join(dirname(dirname(entry)), "launcher"));
  if (!chosen.ok || !chosen.node) return { ok: false, reason: `AgEnD cannot start here: ${chosen.reason ?? "no Node was selected"}${chosen.recovery ? ` (to repair: ${chosen.recovery})` : ""}` };
  return { ok: true, expected: { node: chosen.node, entry } };
}

/** Does a definition's tuple start exactly the expected one, with its interpreter named? */
export function judgeTuple(tuple: ActivationTuple, expected: ExpectedTuple, deps: Pick<TupleDeps, "realpath">): Judgement {
  for (const key of INTERPRETER_ENV) {
    if (tuple.env[key] !== undefined) return { ok: false, reason: `it sets ${key}` };
  }
  const runtimeDir = dirname(expected.node);
  if (runtimeDir.includes("/node_modules/") && (tuple.env.PATH ?? "").split(":").includes(runtimeDir)) {
    return { ok: false, reason: `its PATH contains AgEnD's own runtime directory (${runtimeDir})` };
  }
  const program = deps.realpath(tuple.program);
  if (program !== expected.node) {
    return program === expected.entry
      ? { ok: false, reason: `it runs ${tuple.program} as a script, leaving its Node to PATH (the format before AgEnD named its Node); run \`agend install\` to refresh it` }
      : { ok: false, reason: `it runs ${tuple.program}, not the selected Node ${expected.node}` };
  }
  const [, entry, ...rest] = tuple.argv;
  if (!entry || deps.realpath(entry) !== expected.entry) return { ok: false, reason: `it starts ${entry ?? "nothing"}, not ${expected.entry}` };
  if (rest.length !== 2 || rest[0] !== "fleet" || rest[1] !== "start") return { ok: false, reason: `its arguments are ${JSON.stringify(rest)}, not ["fleet","start"]` };
  return { ok: true };
}

/** systemd: the LOADED unit (D-Bus, after any reload), and no reload pending. */
export function guardSystemd(run: (command: string, args: string[]) => CommandResult, user: boolean, unit: string, expected: ExpectedTuple, deps: Pick<TupleDeps, "realpath">): Judgement {
  const loaded = readLoadedUnit(run, user, unit);
  if (!loaded.ok) return { ok: false, reason: `the loaded ${unit} cannot be read: ${loaded.reason}` };
  if (loaded.unit.needDaemonReload) return { ok: false, reason: `${unit} changed on disk and is not reloaded (a reload is pending or failed)` };
  const judged = judgeTuple(loaded.unit.tuple, expected, deps);
  return judged.ok ? judged : { ok: false, reason: `the loaded ${unit} ${judged.reason}` };
}

/** launchd: the loaded job (`launchctl print`) and the plist on disk must agree, and start the expected tuple. */
export function guardLaunchd(
  run: (command: string, args: string[]) => CommandResult, target: string, plistPath: string, readFile: (path: string) => string | null,
  expected: ExpectedTuple, deps: Pick<TupleDeps, "realpath">,
): Judgement {
  const printed = run("launchctl", ["print", target]);
  if (printed.status !== 0 || printed.signal !== null) return { ok: false, reason: `launchctl print ${target} did not complete` };
  const loaded = parseLaunchctlPrint(printed.stdout).tuple;
  if (!loaded) return { ok: false, reason: `the loaded ${target} cannot be read` };
  const xml = readFile(plistPath);
  const onDisk = xml === null ? null : parsePlist(xml);
  if (!onDisk || !sameJob(loaded, onDisk)) return { ok: false, reason: `the job launchd has loaded is not the one ${plistPath} describes` };
  const judged = judgeTuple(loaded, expected, deps);
  return judged.ok ? judged : { ok: false, reason: `the loaded ${target} ${judged.reason}` };
}

/** Detached: the restart starts `<this Node> <entry> fleet start` (selfCommand); this Node must be the selected one. */
export function guardDetached(execPath: string, expected: ExpectedTuple, deps: Pick<TupleDeps, "realpath">): Judgement {
  const node = deps.realpath(execPath);
  return node === expected.node ? { ok: true } : { ok: false, reason: `this command runs on ${execPath}, not the selected Node ${expected.node}; run it as \`agend restart\`` };
}
