/**
 * M-2457 PR C §6 rule 3: the 2.3.x → bundled-tmux hop. 2.3.x ran each agent in a window of the SYSTEM tmux on the
 * DEFAULT socket; with the bundled tmux on, AgEnD's server is another one (`-L agend`). Where the old server survived
 * (launchd, a foreground fleet; also after a rollback to 2.3 and a second upgrade) its windows may still run agents,
 * and a new window for the same instance would resume the same conversation twice.
 *
 * Per instance, before it starts (the daemon calls migrateLegacyWindow):
 *  - The trigger: a window-id file without its socket tag (`window-id.socket`, written beside it while the bundled tmux
 *    is on) was written by 2.3 and names a window on the default server.
 *  - Prove the window ours: its #{window_id} is the file's, its name is the instance's, and its pane's process tree runs
 *    the instance's backend binary.
 *  - Checkpoint the instance's session id (the daemon's own checkpoint), kill-window it with the system tmux, and confirm
 *    it gone (the window no longer listed, its pane pid exited). Never kill-server: the default server may hold the
 *    user's own sessions; it exits by itself once empty.
 *  - Anything unprovable — a window that is not provably ours, no system tmux to ask about an untagged file, a default
 *    server that answers but can't be queried, a window that won't go — holds THAT instance (LegacyWindowHoldError);
 *    the rest of the fleet starts. `agend tmux-migrate --release <name>` lets the user take it from there.
 *  - The journal (`<AGEND_HOME>/tmux-migration.json`) records each window's step against the default server's
 *    incarnation (#{pid} + #{start_time}), so an interrupted migration resumes on the same server without checkpointing
 *    twice; another incarnation starts afresh.
 *  - Afterwards the untagged window-id file is removed: its window id means nothing on the new server (whose ids start
 *    again from @0) and must never be used there.
 *
 * Divergence from the design note, flagged in the PR: the tag is a sidecar file (`window-id.socket`) instead of a
 * prefix inside `window-id` (`agend:@12`), so the many readers of `window-id` keep reading a bare window id.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WINDOW_SOCKET_TAG = "window-id.socket";
export const MIGRATION_JOURNAL = "tmux-migration.json";

export class LegacyWindowHoldError extends Error {
  constructor(readonly instance: string, readonly why: string) {
    super(`An old tmux window for ${instance} may still be running (system tmux): ${why}. Close it, or run \`agend tmux-migrate --release ${instance}\`.`);
    this.name = "LegacyWindowHoldError";
  }
}

export interface LegacyWindow { session: string; id: string; name: string; panePid: number }
export interface Incarnation { pid: number; start: number }
export type Step = "checkpointed" | "killed" | "confirmed";
export interface Journal {
  server: Incarnation | null;
  windows: Record<string, { windowId: string; step: Step }>;
  /** Instances the user released with `agend tmux-migrate --release`: their untagged window is left alone. */
  released: Record<string, string>;
}

const emptyJournal = (): Journal => ({ server: null, windows: {}, released: {} });

export function readJournal(agendHome: string): Journal {
  try {
    const j = JSON.parse(readFileSync(join(agendHome, MIGRATION_JOURNAL), "utf8"));
    if (!j || typeof j !== "object") return emptyJournal();
    const server = j.server && Number.isSafeInteger(j.server.pid) && Number.isSafeInteger(j.server.start) ? { pid: j.server.pid, start: j.server.start } : null;
    const windows: Journal["windows"] = {};
    for (const [k, v] of Object.entries(j.windows ?? {})) {
      const w = v as any;
      if (w && typeof w.windowId === "string" && ["checkpointed", "killed", "confirmed"].includes(w.step)) windows[k] = { windowId: w.windowId, step: w.step };
    }
    const released: Journal["released"] = {};
    for (const [k, v] of Object.entries(j.released ?? {})) if (typeof v === "string") released[k] = v;
    return { server, windows, released };
  } catch { return emptyJournal(); }
}

export function writeJournal(agendHome: string, j: Journal): void {
  const file = join(agendHome, MIGRATION_JOURNAL);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(j, null, 2) + "\n");
  renameSync(`${file}.${process.pid}.tmp`, file);
}

/** The window-id file's state: no file, tagged with a socket (written with the bundled tmux on), or untagged (2.3). */
export function windowIdState(instanceDir: string): { kind: "none" } | { kind: "tagged"; id: string; socket: string } | { kind: "untagged"; id: string } {
  let id = "";
  try { id = readFileSync(join(instanceDir, "window-id"), "utf8").trim(); } catch { return { kind: "none" }; }
  if (!id) return { kind: "none" };
  // The tag names the window id it was written for: after a rollback, 2.3 rewrites window-id and leaves a stale tag
  // behind — a tag for another id is no tag.
  try {
    const [socket, taggedId] = readFileSync(join(instanceDir, WINDOW_SOCKET_TAG), "utf8").split("\n").map(x => x.trim());
    if (socket && taggedId === id) return { kind: "tagged", id, socket };
  } catch { /* untagged */ }
  return { kind: "untagged", id };
}

/** Written beside window-id whenever the bundled tmux is on: the file is then known not to be 2.3's. */
export function tagWindowId(instanceDir: string, socket: string, windowId: string): void {
  writeFileSync(join(instanceDir, WINDOW_SOCKET_TAG), `${socket}\n${windowId}\n`);
}

export function dropWindowId(instanceDir: string): void {
  for (const f of ["window-id", WINDOW_SOCKET_TAG]) { try { unlinkSync(join(instanceDir, f)); } catch { /* gone */ } }
}

/** Whether a process tree (pid → [ppid, command line]) under `root` runs `binary` (its basename, as the command or argv[0..1]). */
export function treeRuns(procs: Map<number, { ppid: number; args: string }>, root: number, binary: string): boolean {
  const want = binary.split("/").pop()!;
  const runs = (args: string) => args.split(/\s+/).slice(0, 2).some(w => w.split("/").pop() === want);
  const seen = new Set<number>();
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = procs.get(pid);
    if (p && runs(p.args)) return true;
    for (const [child, c] of procs) if (c.ppid === pid) queue.push(child);
  }
  return false;
}

export interface LegacyProbes {
  /** The system tmux on PATH (never the bundled one), or null. */
  systemTmux(): Promise<string | null>;
  /** Run the system tmux against the DEFAULT socket: stdout, or a rejection whose message is tmux's stderr. */
  tmux(bin: string, args: string[]): Promise<string>;
  processes(): Promise<Map<number, { ppid: number; args: string }>>;
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

const NO_SERVER = /no server running|error connecting|No such file or directory|server exited/i;
/** A field separator tmux prints as is: without a UTF-8 locale tmux prints a TAB in -F output as `_` (Fable #3276). */
const SEP = "|||";
const WINDOW_LINE = /^(.*)\|\|\|(@\d+)\|\|\|(.*)\|\|\|(\d+)$/;

export interface MigrateArgs {
  agendHome: string;
  instance: string;
  instanceDir: string;
  session: string;
  backendBinary: string;
  checkpoint: () => Promise<void> | void;
  probes?: LegacyProbes;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Resolves when this instance may start (nothing legacy, or its old window positively gone, or released); throws
 * LegacyWindowHoldError when it must not.
 */
export async function migrateLegacyWindow(a: MigrateArgs): Promise<"none" | "tagged" | "stale" | "migrated" | "released"> {
  const p = a.probes ?? realLegacyProbes;
  const state = windowIdState(a.instanceDir);
  if (state.kind === "none") return "none";
  if (state.kind === "tagged") return "tagged";
  const hold = (why: string) => { a.log?.("legacy tmux window held", { instance: a.instance, why }); return new LegacyWindowHoldError(a.instance, why); };
  const journal = readJournal(a.agendHome);
  if (journal.released[a.instance] === state.id) { dropWindowId(a.instanceDir); return "released"; }

  const bin = await p.systemTmux();
  if (!bin) throw hold("its window id was written by AgEnD 2.3, and there is no system tmux to ask whether that window still runs");
  let incarnation: Incarnation;
  let windows: LegacyWindow[];
  try {
    const [pid, start] = (await p.tmux(bin, ["display-message", "-p", "#{pid} #{start_time}"])).trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(start)) throw new Error("unexpected answer");
    incarnation = { pid: pid!, start: start! };
    const out = await p.tmux(bin, ["list-windows", "-a", "-F", ["#{session_name}", "#{window_id}", "#{window_name}", "#{pane_pid}"].join(SEP)]);
    windows = [];
    for (const line of out.split("\n").filter(Boolean)) {
      // An answer AgEnD can't read is never taken for "the window is gone": that would drop the id while the 2.3 window
      // still runs its agent. Only a well-formed list without the id (or no server at all) may.
      const m = WINDOW_LINE.exec(line);
      if (!m) throw new Error(`unexpected list-windows answer "${line.slice(0, 80)}"`);
      windows.push({ session: m[1]!, id: m[2]!, name: m[3]!, panePid: Number(m[4]) });
    }
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (NO_SERVER.test(msg)) { dropWindowId(a.instanceDir); return "stale"; }   // no default server: the window is gone
    throw hold(`the default tmux server answers but can't be queried (${msg.split("\n")[0]!.slice(0, 160)})`);
  }

  // By id only: ids are unique per server, and a window the user moved to another session still runs the agent.
  const w = windows.find(x => x.id === state.id);
  if (!w) { dropWindowId(a.instanceDir); return "stale"; }
  if (w.name !== a.instance) throw hold(`window ${w.id} is named "${w.name}", not "${a.instance}"`);
  if (!treeRuns(await p.processes(), w.panePid, a.backendBinary)) throw hold(`window ${w.id} does not run ${a.backendBinary}`);

  // A journal for another server incarnation is stale: start a fresh pass on this one.
  const j: Journal = journal.server && journal.server.pid === incarnation.pid && journal.server.start === incarnation.start
    ? journal : { server: incarnation, windows: {}, released: journal.released };
  const step = j.windows[a.instance]?.windowId === w.id ? j.windows[a.instance]!.step : null;
  if (!step) {
    await a.checkpoint();
    j.windows[a.instance] = { windowId: w.id, step: "checkpointed" };
    writeJournal(a.agendHome, j);
  }
  if (step !== "killed" && step !== "confirmed") {
    try { await p.tmux(bin, ["kill-window", "-t", w.id]); } catch { /* confirmed below */ }
    j.windows[a.instance] = { windowId: w.id, step: "killed" };
    writeJournal(a.agendHome, j);
  }
  for (let i = 0; i < 50; i++) {
    let listed = false;
    try { listed = (await p.tmux(bin, ["list-windows", "-a", "-F", "#{window_id}"])).split("\n").includes(w.id); }
    catch (e) { if (!NO_SERVER.test(String((e as Error).message ?? e))) listed = true; }
    if (!listed && !p.alive(w.panePid)) {
      j.windows[a.instance] = { windowId: w.id, step: "confirmed" };
      writeJournal(a.agendHome, j);
      dropWindowId(a.instanceDir);
      a.log?.("legacy tmux window migrated", { instance: a.instance, window: w.id });
      return "migrated";
    }
    await p.sleep(100);
  }
  throw hold(`window ${w.id} did not close`);
}

/** `agend tmux-migrate --release <name>`: leave that instance's untagged window to the user; its next start goes ahead. */
export function releaseLegacyWindow(agendHome: string, instance: string, instanceDir: string): string | null {
  const state = windowIdState(instanceDir);
  if (state.kind !== "untagged") return null;
  const j = readJournal(agendHome);
  j.released[instance] = state.id;
  writeJournal(agendHome, j);
  return state.id;
}

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) =>
  execFile(file, args, { timeout: 5000, encoding: "utf8", ...(env ? { env } : {}) }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));

export const realLegacyProbes: LegacyProbes = {
  async systemTmux() {
    for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      const f = join(dir, "tmux");
      if (existsSync(f)) return f;
    }
    return null;
  },
  // The default socket: no -L/-S; never a caller's $TMUX (a client inside another server would talk to that one).
  tmux: (bin, args) => { const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE; return run(bin, args, env); },
  async processes() {
    const out = await run("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="]);
    const m = new Map<number, { ppid: number; args: string }>();
    for (const line of out.split("\n")) {
      const r = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (r) m.set(Number(r[1]), { ppid: Number(r[2]), args: r[3]! });
    }
    return m;
  },
  alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } },
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
};
