/**
 * #1811: a configured `effort`, as a launch flag. Before this only kiro-cli and muse launched with it; codex,
 * claude-code, grok and antigravity saved it and launched without (codex's `/effort` restarted into nothing).
 *
 * A stored effort must never break a launch. The flag is passed only when
 *  - this binary advertises it: its own `--help` lists the flag (an older CLI without it would refuse the unknown
 *    option and not start — verified: grok 1.0.46 and agy 1.3.4 exit on an unknown flag, claude 2.1.299 too), and
 *  - the level is one it takes: the values its help lists (claude, agy), grok's known three (its help lists none,
 *    and it takes any string at parse time — verified with 1.0.46), or for codex the levels the model's own catalog
 *    entry lists (codex 0.162.1 launches with any `model_reasoning_effort`, "bogus" included, and the API would
 *    refuse it at the first turn).
 * Anything else launches without the flag and says why in a quiet note (daemon.log and the Log tab), never a channel
 * notice. A resumed session gets the flag too (verified: claude `--continue`/`--resume` with `--effort`, codex
 * `resume <id>` with `-c`). The runtime `/effort` paste is unchanged.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { measureSyncWork } from "../sync-work-attribution.js";
import { EFFORT_CAPABILITIES, CANONICAL_EFFORT } from "./effort-metadata.js";
import { t } from "../locale.js";
import { shellQuote } from "./types.js";

/** What a launch does with a configured effort: the argument to append (with its leading space), or why none. */
export interface LaunchEffort { arg: string | null; note: string | null }

export type HelpRunner = (binary: string, args: string[]) => string;

const defaultRun: HelpRunner = (binary, args) => execFileSync(binary, args, {
  encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
});

/** `--help` per binary FILE: the path and what is there (size, mtime) — an update gives a new answer. */
const helpCache = new Map<string, string | null>();

/** The binary's `--help`, read once per binary file; null when it cannot be read (then no flag is passed). */
export function cliHelp(binaryPath: string, run: HelpRunner = defaultRun): string | null {
  let key: string;
  try {
    const st = statSync(binaryPath);
    key = `${binaryPath}\u0000${st.size}\u0000${st.mtimeMs}`;
  } catch { return null; }                                         // not a file we can identify: never guess
  if (helpCache.has(key)) return helpCache.get(key)!;
  let help: string | null = null;
  try { help = measureSyncWork("backend.effortHelp", () => run(binaryPath, ["--help"])); } catch { help = null; }
  helpCache.set(key, help);
  return help;
}

/** For tests: forget what was read. */
export function resetCliHelpCache(): void { helpCache.clear(); }

/**
 * Whether the help lists `flag` as an option, and the values it gives for it: the first `(a, b, c)` or `(a|b|c)`
 * list in the option's own entry (its row and the description lines under it), in canonical order. `levels: null`
 * when the entry names none.
 */
export function helpOption(help: string, flag: string): { listed: boolean; levels: string[] | null } {
  const lines = help.split("\n");
  const at = lines.findIndex(line => new RegExp(`^\\s*(?:-\\w,\\s*)?${flag.replace(/[-]/g, "\\-")}(?=[\\s,=<]|$)`).test(line));
  if (at < 0) return { listed: false, levels: null };
  const entry: string[] = [lines[at]!];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*-{1,2}\w/.test(line)) break;                            // the next option
    entry.push(line);
  }
  const list = /\(([a-z]+(?:\s*[,|]\s*[a-z]+)+)\)/.exec(entry.join(" "));
  if (!list) return { listed: true, levels: null };
  const offered = new Set(list[1]!.split(/\s*[,|]\s*/));
  return { listed: true, levels: CANONICAL_EFFORT.filter(level => offered.has(level)) };
}

/** The effort, if it is one of AgEnD's levels at all (normalized), else null. */
function canonical(effort: string): string | null {
  const level = effort.trim().toLowerCase();
  return (CANONICAL_EFFORT as readonly string[]).includes(level) ? level : null;
}

const skip = (backend: string, effort: string, why: string): LaunchEffort =>
  ({ arg: null, note: t("effort.launch_skipped", effort, backend, why) });

/**
 * claude-code (`--effort`), grok (`--reasoning-effort`) and antigravity (`--effort`): the flag when this binary's help
 * lists it and the level is one it takes.
 */
export function flagEffort(
  backend: "claude-code" | "grok" | "antigravity", effort: string | undefined, binaryPath: string, run?: HelpRunner,
): LaunchEffort {
  if (!effort) return { arg: null, note: null };
  const level = canonical(effort);
  if (!level) return skip(backend, effort, t("effort.launch_not_a_level", CANONICAL_EFFORT.join(", ")));
  const flag = backend === "grok" ? "--reasoning-effort" : "--effort";
  const help = cliHelp(binaryPath, run);
  if (help === null) return skip(backend, level, t("effort.launch_no_help"));
  const option = helpOption(help, flag);
  if (!option.listed) return skip(backend, level, t("effort.launch_no_flag", flag));
  // grok's help lists no values (and it takes any string): only the levels AgEnD knows it has.
  const levels = option.levels ?? (backend === "grok" ? [...EFFORT_CAPABILITIES.grok.levels] : null);
  if (!levels) return skip(backend, level, t("effort.launch_no_levels", flag));
  if (!levels.includes(level)) return skip(backend, level, t("effort.launch_level_not_offered", levels.join(", ")));
  return { arg: ` ${flag} ${level}`, note: null };
}

/**
 * codex: `-c model_reasoning_effort="<level>"` when the model's own catalog entry lists the level. `-c` is in every
 * codex AgEnD runs; what it does not check is the value, so the catalog is the gate.
 */
export function codexEffort(
  effort: string | undefined, catalog: { model: string | null; levels: string[] | null; unproven?: boolean },
): LaunchEffort {
  if (!effort) return { arg: null, note: null };
  const level = canonical(effort);
  if (!level) return skip("codex", effort, t("effort.launch_not_a_level", CANONICAL_EFFORT.join(", ")));
  if (catalog.unproven) return skip("codex", level, t("effort.launch_codex_model_unproven"));
  if (!catalog.levels) return skip("codex", level, t("effort.launch_codex_unknown_model", catalog.model ?? "—"));
  if (!catalog.levels.includes(level)) return skip("codex", level, t("effort.launch_level_not_offered", catalog.levels.join(", ")));
  return { arg: ` -c ${shellQuote(`model_reasoning_effort="${level}"`)}`, note: null };
}
