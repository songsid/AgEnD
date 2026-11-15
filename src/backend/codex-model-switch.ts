/**
 * M-3175: codex's in-session model and reasoning switch, `/model NAME --reasoning=LEVEL` (and `/model --reasoning=LEVEL` for the
 * effort alone). It arrived in codex 0.164.0 (openai/codex #54378, 2026-10-15; 0.163.0 does not have it). On an older codex the
 * same line is NOT a command: 0.163.0 sends `/model gpt-… --reasoning=high` to the model as a user prompt (rig, M-3175). So the
 * switch is typed only into a codex whose RUNNING binary is known to be 0.164.0 or later; anything unknown keeps the restart.
 *
 * What codex does with it (0.164.0 … 0.169.0, source and rig): a session-only selection — the thread's settings are updated, the
 * history gains `• Model changed to MODEL EFFORT for this session only`, and the rollout (once it exists) gains an
 * `event_msg` `thread_settings_applied` with the new `model` and `reasoning_effort` at once, even mid-turn. A name or level the
 * model catalog does not list is refused with a `■ …` line and nothing changes. A `/model NAME` WITHOUT `--reasoning` resets the
 * effort to that model's default, so a model switch carries the effort a restart would launch with.
 */
import { open, readdir, readFile, readlink, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "../child-process.js";
import { compareVersions, versionOf } from "../cli-audited.js";

/** The first codex release with the inline `/model NAME --reasoning=LEVEL` (openai/codex #54378). */
export const CODEX_INLINE_MODEL_MIN = "0.164.0";

export function codexSupportsInlineModel(version: string | null | undefined): boolean {
  const v = versionOf(version ?? null);
  return v !== null && compareVersions(v, CODEX_INLINE_MODEL_MIN) >= 0;
}

/** A model id codex can be told on one line (its own ids: `gpt-6.1-sol`, `provider/model`); nothing a shell or the TUI parses. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const EFFORT = /^(?:none|minimal|low|medium|high|xhigh|max|ultra)$/;

/**
 * The line to type. `model` null: the effort alone, on the model the session runs. `effort` null: the model alone — codex then
 * takes the model's default effort, as a launch without an effort does. Null when either is not something codex parses as one token.
 */
export function codexModelCommand(model: string | null, effort: string | null): string | null {
  if (model !== null && !MODEL_ID.test(model)) return null;
  if (effort !== null && !EFFORT.test(effort)) return null;
  if (model === null && effort === null) return null;
  return ["/model", ...(model !== null ? [model] : []), ...(effort !== null ? [`--reasoning=${effort}`] : [])].join(" ");
}

export type CodexPaneSwitch = { kind: "switched"; model: string; effort: string } | { kind: "refused"; text: string };

/**
 * The newest history entry that is codex's answer to a `/model` line: its `• Model changed to … for this session only`, or a
 * `■ …` refusal. Read from the bottom up to the first entry (a `•`/`■` row above the composer); anything else first → null.
 */
export function codexSwitchFromPane(pane: string): CodexPaneSwitch | null {
  const rows = pane.replace(/\r/g, "").split("\n");
  let i = rows.length - 1;
  while (i >= 0 && !/^\s*›/.test(rows[i]!)) i--;               // the composer row
  for (i--; i >= 0; i--) {
    const row = rows[i]!.trimEnd();
    if (!row.trim()) continue;
    const ok = /^• Model changed to (\S+) (\S+)(?: \S+)? for this session only$/.exec(row);
    if (ok) return { kind: "switched", model: ok[1]!, effort: ok[2]! };
    const refused = /^■ (.+)$/.exec(row);
    if (refused) return { kind: "refused", text: refused[1]! };
    return null;
  }
  return null;
}

/** How many of codex's answers to a `/model` line a capture holds (successes and refusals): a new one is ours. */
export function codexSwitchAnswerCount(pane: string): number {
  return pane.replace(/\r/g, "").split("\n").filter(row => /^• Model changed to \S+ .* for this session only\s*$|^■ /.test(row)).length;
}

/** At most `max` bytes of a file from `offset` (a rollout delta), "" when it cannot be read. */
export async function readFrom(path: string, offset: number, max: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buf, 0, max, offset);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch { return ""; } finally { await handle?.close().catch(() => {}); }
}

/** The last `thread_settings_applied` in rollout lines (a delta read after our checkpoint), or null when none was written. */
export function codexAppliedFromRollout(lines: string): { model: string; effort: string | null } | null {
  let last: { model: string; effort: string | null } | null = null;
  for (const line of lines.split("\n")) {
    if (!line.includes("thread_settings_applied")) continue;
    try {
      const d = JSON.parse(line) as { type?: unknown; payload?: { type?: unknown; thread_settings?: { model?: unknown; reasoning_effort?: unknown } } };
      const s = d.type === "event_msg" && d.payload?.type === "thread_settings_applied" ? d.payload.thread_settings : undefined;
      if (s && typeof s.model === "string") last = { model: s.model, effort: typeof s.reasoning_effort === "string" ? s.reasoning_effort : null };
    } catch { /* a partial last line */ }
  }
  return last;
}

export interface RunningVersionDeps {
  procRoot?: string;
  /** `<exe> --version` → its stdout; production runs the binary with a short timeout. */
  printVersion?: (exe: string) => Promise<string>;
}

const execFileP = promisify(execFile);

/**
 * The version of the codex a pane is RUNNING: the `codex` processes under the pane's shell, whose executable must still be the
 * file on disk (an update that replaced it leaves `(deleted)` or another inode: the running one is then unknown), asked for its
 * `--version`. Null whenever that cannot be proven: no codex process, more than one executable, a replaced binary, or no version.
 */
export async function codexRunningVersion(panePid: number, deps: RunningVersionDeps = {}): Promise<string | null> {
  const proc = deps.procRoot ?? "/proc";
  const printVersion = deps.printVersion ?? (async (exe: string) => (await execFileP(exe, ["--version"], { timeout: 5000, maxBuffer: 64 * 1024 })).stdout);
  const parentOf = async (pid: number): Promise<number | null> => {
    try { return Number(/^PPid:\s+(\d+)$/m.exec(await readFile(`${proc}/${pid}/status`, "utf8"))?.[1] ?? NaN) || null; } catch { return null; }
  };
  let entries: string[] = [];
  try { entries = await readdir(proc); } catch { return null; }
  const children = new Map<number, number[]>();
  for (const e of entries.slice(0, 65536)) {
    if (!/^\d+$/.test(e)) continue;
    const ppid = await parentOf(Number(e));
    if (ppid !== null) children.set(ppid, [...(children.get(ppid) ?? []), Number(e)]);
  }
  const exes = new Set<string>();
  const queue = [panePid], seen = new Set<number>();
  while (queue.length && seen.size < 512) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    queue.push(...(children.get(pid) ?? []));
    if (pid === panePid) continue;
    let exe: string;
    try { exe = await readlink(`${proc}/${pid}/exe`); } catch { continue; }
    if (!/\/codex(?: \(deleted\))?$/.test(exe)) continue;
    if (exe.endsWith(" (deleted)")) return null;
    try {
      const [running, onDisk] = await Promise.all([stat(`${proc}/${pid}/exe`), stat(exe)]);
      if (running.ino !== onDisk.ino || running.dev !== onDisk.dev) return null;
    } catch { return null; }
    exes.add(exe);
  }
  if (exes.size !== 1) return null;
  try { return versionOf(await printVersion([...exes][0]!)); } catch { return null; }
}
