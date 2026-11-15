/**
 * M-3180: the in-session model / effort switch for CLIs other than codex (codex: codex-model-switch.ts, M-3175), one table entry per
 * CLI. The fleet splits a request into one-command steps; the daemon types a step only into an idle pane of a CLI whose RUNNING binary
 * is at the entry's minimum version, and asks the entry for a verdict on what the CLI shows (or records) after it — against what it
 * showed before the command, so an answer or footer already on screen cannot confirm it. Anything not confirmed is restarted, as before.
 */
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { basename } from "node:path";
import { compareVersions, versionOf } from "../cli-audited.js";
import { probeBackendVersion } from "../backend-availability.js";
import { readMuseCachedCatalog } from "./muse.js";
import { GROK_INLINE_MODEL_MIN, grokSwitchCommand, grokSwitchVerdict } from "./grok-model-switch.js";
import { readAgyCliEnv } from "./effort-metadata.js";
import { AGY_INLINE_MODEL_MIN, agySwitchCommand, agySwitchTarget, agySwitchVerdict } from "./agy-model-switch.js";

/** What one switch asks for: null leaves that one as the session has it. */
export interface CliSwitchWant { model: string | null; effort: string | null }
/** A verdict: switched (to `shown`), not what was asked (`shown`: what the CLI answered), or null (no answer yet). */
export type CliSwitchVerdict = { outcome: "switched"; shown: string } | { outcome: "mismatch"; shown: string } | null;
/** What the CLI showed before the command was typed (the scrollback around the composer) and, when the entry keeps one, its record checkpoint. */
export interface CliSwitchBefore { pane: string; record?: unknown }

export interface CliRuntimeSwitchEntry {
  /** The first RUNNING version with a one-command switch: one that changes the model, and one that changes only the effort. */
  minVersion: { model: string; effort: string };
  /** Is this executable (a /proc/<pid>/exe path) the CLI's own binary? */
  matchExe(exe: string): boolean;
  /** Its version from the executable's own name when the name carries it (the running file, whatever was installed since); else null. */
  versionFromExe?(exe: string): string | null;
  /** Resolve a model request with the effort a restart would launch; omitted keeps the CLI default behavior. */
  modelWant?(model: string, effort: string | null): CliSwitchWant;
  /** A request as one-command steps, in order. */
  steps(want: CliSwitchWant): CliSwitchWant[];
  /** The one command for a step; null when it cannot be one line the CLI parses (nothing is typed, the fleet restarts). */
  command(step: CliSwitchWant): string | null;
  /** Whether the CLI knows this model, when the CLI itself would take any name; false or null (cannot tell): not typed, restarted. */
  knownModel?(model: string): boolean | null;
  /** Optional: the CLI's own record position before the command (a log offset), given to verify. */
  checkpoint?(pane: string, cwd: string): Promise<unknown>;
  /** The verdict on `now` (the scrollback after the command) against `before`; null while there is none yet. */
  verify(step: CliSwitchWant, before: CliSwitchBefore, now: { pane: string }): CliSwitchVerdict | Promise<CliSwitchVerdict>;
}

const ONE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;

// ── muse ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Rig (scripts/manual/muse-version-audit/switch.sh; 1.4.4, 1.4.6, 1.4.20, offline): `/model ID` answers `Model set to ID for this session
// (saved model unchanged)` and keeps the effort; `/effort LEVEL` answers nothing; both show at once in the footer `MODEL · EFFORT · <cwd> · …`.
// A bad level is refused (`◆ unsupported reasoning effort …`); ANY model id is taken (`/model nosuch-model` too), so the fleet checks the
// name against muse's catalog first. `/model ID` is a one-command switch from 1.4.6 (1.4.4 answers `◆ model catalog has no visible
// models`, its picker); `/effort LEVEL` is in 1.4.4 already. The next request carried the switched model and effort (the mock's log).
const MUSE_EFFORT = /^(?:minimal|low|medium|high|xhigh|max|ultra)$/;
const MUSE_MODEL_SET = /^ {0,2}Model set to (\S+) for this session \(saved model unchanged\)\s*$/;
const MUSE_REFUSAL = /^◆ (unsupported reasoning effort .*|model catalog has no visible models.*)$/;
/** The footer's model and effort: the last `MODEL · EFFORT · …` row. */
export function museFooter(pane: string): { model: string; effort: string } | null {
  const rows = pane.replace(/\r/g, "").split("\n");
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = /^\s*(\S+) · (minimal|low|medium|high|xhigh|max|ultra) · /.exec(rows[i]!);
    if (m) return { model: m[1]!, effort: m[2]! };
  }
  return null;
}
const count = (pane: string, re: RegExp) => pane.replace(/\r/g, "").split("\n").filter(row => re.test(row)).length;
const newest = (pane: string, re: RegExp): RegExpExecArray | null => {
  const rows = pane.replace(/\r/g, "").split("\n");
  for (let i = rows.length - 1; i >= 0; i--) { const m = re.exec(rows[i]!); if (m) return m; }
  return null;
};
export const MUSE_RUNTIME_SWITCH: CliRuntimeSwitchEntry = {
  minVersion: { model: "1.4.6", effort: "1.4.4" },
  // The launcher (`muse`, a bash script) execs `muse-bin-<version>`: the running process is that file.
  matchExe: exe => /\/muse-bin-\d+\.\d+\.\d+[^/]*$/.test(exe),
  versionFromExe: exe => versionOf(basename(exe).replace(/^muse-bin-/, "")),
  steps: want => want.model !== null && want.effort !== null ? [{ model: want.model, effort: null }, { model: null, effort: want.effort }] : [want],
  command: step => step.model !== null ? (ONE_TOKEN.test(step.model) && step.effort === null ? `/model ${step.model}` : null)
    : step.effort !== null && MUSE_EFFORT.test(step.effort) ? `/effort ${step.effort}` : null,
  // Only muse's own cached catalog can say (its fallback list is a guess): a name it does not list keeps the restart.
  knownModel: model => { const rows = readMuseCachedCatalog(); return rows ? rows.some(row => row.id === model) : null; },
  verify(step, before, now) {
    if (count(now.pane, MUSE_REFUSAL) > count(before.pane, MUSE_REFUSAL)) return { outcome: "mismatch", shown: newest(now.pane, MUSE_REFUSAL)![1]! };
    const footer = museFooter(now.pane);
    if (step.model !== null) {
      // A NEW answer naming the model, and the footer on it: an older answer or footer for the same model is not this switch.
      if (count(now.pane, MUSE_MODEL_SET) <= count(before.pane, MUSE_MODEL_SET)) return null;
      const set = newest(now.pane, MUSE_MODEL_SET)![1]!;
      if (set !== step.model) return { outcome: "mismatch", shown: set };
      return footer?.model === step.model ? { outcome: "switched", shown: `${footer.model} ${footer.effort}` } : null;
    }
    // The effort has no answer line: the footer is muse's record of it (a level already in force is that level).
    return footer && footer.effort === step.effort ? { outcome: "switched", shown: `${footer.model} ${footer.effort}` } : null;
  },
};

/** Grok: exact fresh model/effort response; transient notices may replace earlier notices. */
export const GROK_RUNTIME_SWITCH: CliRuntimeSwitchEntry = {
  minVersion: { model: GROK_INLINE_MODEL_MIN, effort: GROK_INLINE_MODEL_MIN },
  matchExe: exe => /\/grok(?:-\d+\.\d+\.\d+[^/]*)?$/.test(exe),
  modelWant: (model, effort) => ({ model, effort }),
  steps: want => [want],
  command: grokSwitchCommand,
  verify: (want, before, now) => grokSwitchVerdict(want, before.pane, now.pane),
};

/** agy: exact catalog labels in its fresh command response, captured on 1.4.7 and 1.5.9. */
export const AGY_RUNTIME_SWITCH: CliRuntimeSwitchEntry = {
  minVersion: { model: AGY_INLINE_MODEL_MIN, effort: AGY_INLINE_MODEL_MIN },
  matchExe: exe => /\/agy$/.test(exe),
  modelWant: (model, effort) => ({ model, effort }),
  steps: want => [want],
  command: want => agySwitchCommand(want, readAgyCliEnv()?.models ?? []),
  knownModel: model => { const env = readAgyCliEnv(); return env ? agySwitchTarget({ model, effort: null }, env.models) !== null : null; },
  verify: (want, before, now) => agySwitchVerdict(want, before.pane, now.pane, readAgyCliEnv()?.models ?? []),
};


/** The CLIs whose model/effort changes use a verified in-session switch. */
export const CLI_RUNTIME_SWITCH: Readonly<Record<string, CliRuntimeSwitchEntry>> = Object.freeze({ muse: MUSE_RUNTIME_SWITCH, antigravity: AGY_RUNTIME_SWITCH, grok: GROK_RUNTIME_SWITCH });

export function cliSwitchAllowed(entry: CliRuntimeSwitchEntry, step: CliSwitchWant, version: string | null): boolean {
  const v = versionOf(version);
  return v !== null && compareVersions(v, step.model !== null ? entry.minVersion.model : entry.minVersion.effort) >= 0;
}

export interface RunningVersionDeps {
  procRoot?: string;
  /** The version of an executable when its name carries none; production: probeBackendVersion (disk first, netless, never a vendor update). */
  probe?: (backend: string, exe: string) => Promise<string | null>;
}

/**
 * The version of the CLI a pane is RUNNING: the pane's process and those under it whose executable `matchExe` accepts, which must be one
 * file that is still the one on disk (an update that replaced it leaves `(deleted)` or another inode: the running one is then unknown);
 * its version from its own name when it carries one, else probeBackendVersion. Null whenever that cannot be proven.
 */
export async function cliRunningVersion(panePid: number, spec: { backend: string; matchExe(exe: string): boolean; versionFromExe?(exe: string): string | null },
  deps: RunningVersionDeps = {}): Promise<string | null> {
  const proc = deps.procRoot ?? "/proc";
  const probe = deps.probe ?? probeBackendVersion;
  let entries: string[] = [];
  try { entries = await readdir(proc); } catch { return null; }
  const children = new Map<number, number[]>();
  for (const e of entries.slice(0, 65536)) {
    if (!/^\d+$/.test(e)) continue;
    let ppid: number | null = null;
    try { ppid = Number(/^PPid:\s+(\d+)$/m.exec(await readFile(`${proc}/${e}/status`, "utf8"))?.[1] ?? NaN) || null; } catch { /* gone */ }
    if (ppid !== null) children.set(ppid, [...(children.get(ppid) ?? []), Number(e)]);
  }
  const exes = new Set<string>();
  const queue = [panePid], seen = new Set<number>();
  while (queue.length && seen.size < 512) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    queue.push(...(children.get(pid) ?? []));
    // The pane's own process too: tmux (or its `sh -c`) may exec the CLI itself, which is then the pane pid (a shell never matches).
    let exe: string;
    try { exe = await readlink(`${proc}/${pid}/exe`); } catch { continue; }
    const deleted = exe.endsWith(" (deleted)");
    if (!spec.matchExe(deleted ? exe.slice(0, -" (deleted)".length) : exe)) continue;
    if (deleted) return null;
    try {
      const [running, onDisk] = await Promise.all([stat(`${proc}/${pid}/exe`), stat(exe)]);
      if (running.ino !== onDisk.ino || running.dev !== onDisk.dev) return null;
    } catch { return null; }
    exes.add(exe);
  }
  if (exes.size !== 1) return null;
  const exe = [...exes][0]!;
  return spec.versionFromExe?.(exe) ?? versionOf(await probe(spec.backend, exe).catch(() => null));
}
