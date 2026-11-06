/**
 * #3160 (P2 of #3153): the Files & changes panel follows the agent live — what file it is reading, editing or searching.
 *
 * - **Source:** the CLI's own structured record, never the terminal. Claude Code's transcript `tool_use` blocks (Read,
 *   Edit, MultiEdit, Write, NotebookEdit, Grep, Glob, LS) carry `file_path` / `path`; Codex's rollout gives `apply_patch`
 *   (its paths are exact) and shell calls (a read through `sed -n`, `cat`, `head`… or a search through `rg` / `grep` is
 *   recognised best-effort, and said so). Other backends are not followed yet.
 * - **What is kept:** per agent, this turn's steps only (a new prompt / turn starts over), at most `FOLLOW_LIMITS.steps`.
 *   A step keeps its kind, its paths as the CLI gave them, a read range when known and whether the paths are exact —
 *   never a search pattern (it can be a literal secret someone is looking for), file contents or an edit's text.
 * - **What leaves:** `resolveFollowSteps` turns each path into one under the agent's folder (agent-workspace.ts rules:
 *   realpath, no symlink walked, AgEnD's state left out) and drops anything else silently; a secret-looking path is sent
 *   as hidden, never its name's contents. Callers (web-api.ts) decide who may ask: the fleet's local admin session only.
 * - Recording is a few string checks per tool call; nothing touches the disk until someone asks.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isHiddenPath, placeOf, type WorkspaceRoot } from "./agent-workspace.js";

export const FOLLOW_LIMITS = Object.freeze({ steps: 40, pathsPerStep: 8, pathChars: 1024 });

export type FollowKind = "read" | "edit" | "search" | "list";
/** One step as recorded: the CLI's own paths (absolute, or relative to the agent's folder). */
export interface FollowStep {
  seq: number;
  at: number;
  kind: FollowKind;
  tool: string;
  paths: string[];
  /** 1-based, inclusive, when the CLI said which lines it read. */
  range?: { from: number; to: number };
  /** false: read from a shell command line, best-effort. */
  exact: boolean;
}
export type FollowStepInput = Omit<FollowStep, "seq" | "at">;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= FOLLOW_LIMITS.pathChars && !/[\u0000-\u001f]/.test(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

/** The file paths a Codex `apply_patch` touches (`*** Add|Update|Delete File: <path>`, `*** Move to: <path>`). */
export function applyPatchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)) {
    const p = str(m[1]); if (p && !out.includes(p)) out.push(p);
    if (out.length >= FOLLOW_LIMITS.pathsPerStep) break;
  }
  return out;
}

/** A shell command line split into words, quotes honoured, stopping at the first `|`, `;`, `&&`, `||` or redirect. */
function firstCommandWords(line: string): string[] {
  const words: string[] = [];
  let cur = "", quote: string | null = null, has = false;
  for (let i = 0; i < line.length && words.length < 64; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = null; else cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "|" || c === ";" || c === "&" || c === ">" || c === "<") break;
    if (/\s/.test(c)) { if (has || cur) { words.push(cur); cur = ""; has = false; } continue; }
    cur += c;
  }
  if (has || cur) words.push(cur);
  return words;
}
/** The command line a Codex shell call ran: `["bash","-lc","<line>"]`, a `cmd` string, or plain argv. */
function shellLine(input: unknown): string | null {
  const o = input as Record<string, unknown> | null;
  const c = o && (o.command ?? o.cmd);
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    const a = c as string[];
    const at = a.findIndex((x) => x === "-c" || x === "-lc");
    return at >= 0 && a[at + 1] ? a[at + 1]! : a.join(" ");
  }
  return null;
}
const operands = (words: string[]): string[] => words.slice(1).filter((w) => !w.startsWith("-"));

/** A shell read / search / listing, best-effort (`exact: false`). */
export function shellStep(line: string): FollowStepInput | null {
  let words = firstCommandWords(line.trim());
  // `cd dir && …` changes the folder the rest is read in: don't guess past it.
  if (words[0] === "cd") return null;
  if (words[0] === "env" || words[0] === "command") words = words.slice(1);
  const cmd = words[0] ?? "";
  const paths = (list: string[]) => list.map(str).filter((p): p is string => !!p).slice(0, FOLLOW_LIMITS.pathsPerStep);
  if (cmd === "sed") {
    const script = words.find((w, i) => i > 0 && /^\d+(?:,\d+)?p$/.test(w));
    const files = operands(words).filter((w) => w !== script && !/^\d+(?:,\d+)?p$/.test(w));
    if (!files.length) return null;
    const m = script ? /^(\d+)(?:,(\d+))?p$/.exec(script) : null;
    const from = m ? Number(m[1]) : null, to = m ? Number(m[2] ?? m[1]) : null;
    return { kind: "read", tool: "shell", paths: paths(files.slice(-1)), exact: false, ...(from && to && to >= from ? { range: { from, to } } : {}) };
  }
  if (["cat", "head", "tail", "nl", "bat", "less", "more", "wc"].includes(cmd)) {
    const files = operands(words).filter((w) => !/^\d+$/.test(w));
    return files.length ? { kind: "read", tool: "shell", paths: paths(files), exact: false } : null;
  }
  if (cmd === "rg" || cmd === "grep" || cmd === "ag" || cmd === "git" && words[1] === "grep") {
    // The first operand is the pattern (never kept); what follows are where it looks.
    const ops = operands(cmd === "git" ? words.slice(1) : words);
    return { kind: "search", tool: "shell", paths: paths(ops.slice(1)), exact: false };
  }
  if (cmd === "ls" || cmd === "find" || cmd === "tree" || cmd === "fd") {
    const ops = cmd === "find" ? words.slice(1).filter((w, i, a) => !w.startsWith("-") && !(i > 0 && a[i - 1]!.startsWith("-"))) : operands(words);
    return { kind: "list", tool: "shell", paths: paths(ops.length ? ops : ["."]), exact: false };
  }
  return null;
}

/** One tool call → a step, or null when it says nothing about a file. Pure. */
export function followStepOf(tool: string, input: unknown): FollowStepInput | null {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (tool) {
    case "Read": {
      const p = str(o.file_path); if (!p) return null;
      const off = int(o.offset), lim = int(o.limit);
      return { kind: "read", tool, paths: [p], exact: true, ...(off || lim ? { range: { from: off ?? 1, to: (off ?? 1) + (lim ?? 1) - 1 } } : {}) };
    }
    case "Edit": case "MultiEdit": case "Write": {
      const p = str(o.file_path); return p ? { kind: "edit", tool, paths: [p], exact: true } : null;
    }
    case "NotebookEdit": {
      const p = str(o.notebook_path); return p ? { kind: "edit", tool, paths: [p], exact: true } : null;
    }
    case "Grep": case "Glob": { const p = str(o.path); return { kind: "search", tool, paths: p ? [p] : ["."], exact: true }; }
    case "LS": { const p = str(o.path); return p ? { kind: "list", tool, paths: [p], exact: true } : null; }
    case "apply_patch": {
      const text = typeof input === "string" ? input : typeof o.input === "string" ? o.input : typeof o.patch === "string" ? o.patch : null;
      const paths = text ? applyPatchPaths(text) : [];
      return paths.length ? { kind: "edit", tool, paths, exact: true } : null;
    }
    case "shell": case "exec_command": case "local_shell": case "container.exec": {
      const line = shellLine(input);
      return line ? shellStep(line) : null;
    }
    default: return null;
  }
}

/** One agent's steps in its current turn. */
export class FollowLog {
  private steps: FollowStep[] = [];
  private seq = 0;
  private turnNo = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}
  record(tool: string, input: unknown): void {
    let step: FollowStepInput | null;
    try { step = followStepOf(tool, input); } catch { step = null; }
    if (!step) return;
    this.steps.push({ ...step, seq: ++this.seq, at: this.now() });
    if (this.steps.length > FOLLOW_LIMITS.steps) this.steps.splice(0, this.steps.length - FOLLOW_LIMITS.steps);
  }
  /** A new prompt or turn: what the last one touched is no longer "this turn". */
  newTurn(): void { this.steps = []; this.turnNo++; }
  /** The turn, and its steps after `after` (all of them when the caller's turn is another). */
  snapshot(after = 0, turn?: number): { turn: number; steps: FollowStep[]; last: number } {
    const fresh = turn !== this.turnNo;
    return { turn: this.turnNo, steps: this.steps.filter((s) => fresh || s.seq > after).map((s) => ({ ...s, paths: [...s.paths] })), last: this.seq };
  }
}

export interface ResolvedFollowPath { path: string; hidden: boolean; dir: boolean }
export interface ResolvedFollowStep extends Omit<FollowStep, "paths"> { paths: ResolvedFollowPath[] }

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * A path as the CLI gave it → one under the agent's folder, or null. Absolute paths must lie inside the folder (as
 * given, or once resolved); relative ones are taken from the folder. The place must pass `placeOf` (no `..`, no symlink
 * parent, not AgEnD's state); a file that does not exist yet (Write about to create it) is kept when its parent does.
 */
export async function resolveFollowPath(ws: WorkspaceRoot, given: string): Promise<ResolvedFollowPath | null> {
  let abs = isAbsolute(given) ? resolve(given) : resolve(ws.root, given);
  if (!under(abs, ws.root)) {
    // The CLI may name the folder by another spelling (a symlinked home): compare real paths.
    try { abs = await realpath(abs); } catch { try { abs = resolve(await realpath(dirname(abs)), abs.slice(dirname(abs).length + 1)); } catch { return null; } }
    if (!under(abs, ws.root)) return null;
  }
  const rel = relative(ws.root, abs).split(sep).join("/");
  if (rel === "") return { path: "", hidden: false, dir: true };
  try {
    const place = await placeOf(ws, rel);
    const st = await lstat(place.abs).catch(() => null);
    if (st?.isSymbolicLink()) return null;
    return { path: place.rel, hidden: isHiddenPath(place.rel), dir: !!st?.isDirectory() };
  } catch { return null; }
}

/** The steps with their paths confined to the folder; a step left with no path is dropped. */
export async function resolveFollowSteps(ws: WorkspaceRoot, steps: readonly FollowStep[]): Promise<ResolvedFollowStep[]> {
  const out: ResolvedFollowStep[] = [];
  for (const s of steps) {
    const paths: ResolvedFollowPath[] = [];
    for (const p of s.paths) { const r = await resolveFollowPath(ws, p); if (r && !paths.some((x) => x.path === r.path)) paths.push(r); }
    if (paths.length) out.push({ ...s, paths });
  }
  return out;
}
