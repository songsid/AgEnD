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

import { randomUUID } from "node:crypto";
import { FOLLOW_LIMITS, followStepOf, type FollowStep, type FollowStepInput } from "./workspace-follow-parse.js";
export * from "./workspace-follow-parse.js";
import type { FollowObservation } from "./workspace-follow-records.js";

/** One agent's steps in its current turn. */
export class FollowLog {
  private steps: FollowStep[] = [];
  private seq = 0;
  private turnNo = 0;
  private scope = randomUUID();
  constructor(private readonly now: () => number = () => Date.now()) {}
  record(tool: string, input: unknown): void {
    let step: FollowStepInput | null;
    try { step = followStepOf(tool, input); } catch { step = null; }
    if (!step?.paths.length) return;
    this.steps.push({ ...step, seq: ++this.seq, at: this.now() });
    if (this.steps.length > FOLLOW_LIMITS.steps) this.steps.splice(0, this.steps.length - FOLLOW_LIMITS.steps);
  }
  /** A new prompt or turn: what the last one touched is no longer "this turn". */
  newTurn(): void { this.steps = []; this.turnNo++; }
  reset(): void { this.newTurn(); this.scope = randomUUID(); }
  observe(event: FollowObservation): void {
    if (event.type === "turn") { this.newTurn(); return; }
    if (event.type === "call") {
      if (this.steps.some(s => s.id === event.id)) return;
      this.steps.push({ ...event.step, id: event.id, phase: "running", seq: ++this.seq, at: this.now() });
      if (this.steps.length > FOLLOW_LIMITS.steps) this.steps.shift();
      return;
    }
    const index = this.steps.findIndex(s => s.id === event.id);
    if (index < 0) return;
    const step = this.steps[index]!;
    this.steps[index] = { ...step, seq: ++this.seq, at: this.now(), phase: event.failed ? "failed" : "done",
      ...(step.kind === "search" && event.paths?.length ? { paths: event.paths } : {}),
      ...(step.kind === "edit" && event.editLines ? { editLines: event.editLines } : {}) };
  }
  /** The turn, and its steps after `after` (all of them when the caller's turn is another). */
  snapshot(after = 0, turn?: number, scope?: string): { scope: string; turn: number; steps: FollowStep[]; last: number } {
    const fresh = turn !== this.turnNo || (scope !== undefined && scope !== this.scope);
    return { scope: this.scope, turn: this.turnNo, steps: this.steps.filter((s) => fresh || s.seq > after).map((s) => ({ ...s, paths: [...s.paths] })), last: this.seq };
  }
}

export interface ResolvedFollowPath { path: string; hidden: boolean; dir: boolean }
export interface ResolvedFollowStep extends Omit<FollowStep, "paths" | "cwd"> { paths: ResolvedFollowPath[] }

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * A path as the CLI gave it → one under the agent's folder, or null. Absolute paths must lie inside the folder (as
 * given, or once resolved); relative ones are taken from the folder. The place must pass `placeOf` (no `..`, no symlink
 * parent, not AgEnD's state); a file that does not exist yet (Write about to create it) is kept when its parent does.
 */
export async function resolveFollowPath(ws: WorkspaceRoot, given: string): Promise<ResolvedFollowPath | null> {
  if (/[\u0000-\u001f\u007f\\]/.test(given) || given.split("/").includes("..")) return null;
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
    if (st && !st.isDirectory() && !st.isFile()) return null;
    return { path: place.rel, hidden: isHiddenPath(place.rel), dir: !!st?.isDirectory() };
  } catch { return null; }
}

/** The steps with their paths confined to the folder; a step left with no path is dropped. */
export async function resolveFollowSteps(ws: WorkspaceRoot, steps: readonly FollowStep[]): Promise<ResolvedFollowStep[]> {
  const out: ResolvedFollowStep[] = [];
  for (const s of steps) {
    const paths: ResolvedFollowPath[] = [];
    if (s.cwd !== undefined && (/[\u0000-\u001f\u007f\\]/.test(s.cwd) || s.cwd.split("/").includes(".."))) continue;
    const cwd = s.cwd === undefined ? ws.root : resolve(ws.root, s.cwd);
    // A call made in another folder cannot be attributed to this agent's root, even for relative operands.
    const context = await resolveFollowPath(ws, cwd);
    if (!context?.dir) continue;
    for (const p of s.paths) {
      if (p.split("/").includes("..")) continue;
      const r = await resolveFollowPath(ws, isAbsolute(p) ? p : resolve(cwd, p));
      if (r && !paths.some((x) => x.path === r.path)) paths.push(r);
    }
    const { cwd: _cwd, ...metadata } = s;
    if (paths.length) out.push({ ...metadata, paths });
  }
  return out;
}
