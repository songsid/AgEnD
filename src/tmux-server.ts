/**
 * M-2457 PR C §6 rule 2: the bundled tmux's server across a pin change.
 *
 * AgEnD records the server it started (`<AGEND_HOME>/tmux/server.json`: socket, the client binary that started it, its
 * tmux version and sha256, the server's pid and start time). On the next start, a server still answering on the socket
 * (launchd or a foreground fleet: it may outlive the fleet) is handled by what the record proves:
 *  - the recorded server, started by this same binary → kept (`same`);
 *  - the recorded server, from another pin → ended by the RECORDED client (client and server must share tmux's wire
 *    protocol, so the new client may not be able to talk to it), then a positive exit: its pid gone and the socket
 *    refusing connections (`handover`);
 *  - anything unproven (no record, the recorded binary gone or changed, the record not matching the server, the query
 *    failing) → the recorded pid alone, if it is alive with the recorded start time and runs the recorded binary, gets
 *    SIGTERM and the same positive-exit wait (`pid-fallback`); else the fleet is held and nothing is killed (`hold`).
 * Two CLIs never resume one conversation: an old window is gone, positively, before a new one starts.
 *
 * Only while the bundled tmux is on (tmux-binary.ts); the decision is pure (decideServer), the probes are injected.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

export const SERVER_RECORD = "server.json";

export interface ServerRecord {
  socket: string;
  /** The client binary that started the server: the only one trusted to talk to it. */
  binary: string;
  version: string;
  sha256: string;
  serverPid: number;
  /** The server's #{start_time} (epoch seconds). */
  serverStart: number;
}

export interface ServerFacts { version: string; pid: number; start: number }

export type ServerDecision =
  | { kind: "fresh" }
  | { kind: "same" }
  | { kind: "handover"; client: string; pid: number }
  | { kind: "pid-fallback"; pid: number; reason: string }
  | { kind: "hold"; reason: string };

const isRecord = (r: any): r is ServerRecord => !!r && typeof r === "object"
  && typeof r.socket === "string" && typeof r.binary === "string" && typeof r.version === "string"
  && typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256)
  && Number.isSafeInteger(r.serverPid) && r.serverPid > 1 && Number.isSafeInteger(r.serverStart) && r.serverStart > 0;

export function recordPath(agendHome: string): string { return join(agendHome, "tmux", SERVER_RECORD); }

export function readServerRecord(agendHome: string): ServerRecord | null {
  try { const r = JSON.parse(readFileSync(recordPath(agendHome), "utf8")); return isRecord(r) ? r : null; } catch { return null; }
}

export function writeServerRecord(agendHome: string, record: ServerRecord): void {
  const file = recordPath(agendHome);
  mkdirSync(join(agendHome, "tmux"), { recursive: true });
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(record, null, 2) + "\n");
  renameSync(`${file}.${process.pid}.tmp`, file);
}

export const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The socket file tmux uses for `-L <label>` (TMUX_TMPDIR, else /tmp; tmux-<uid>/<label>). */
export function socketPath(label: string, env: NodeJS.ProcessEnv = process.env, uid: number = process.getuid?.() ?? 0): string {
  return join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`, label);
}

/** Whether a server accepts connections on the socket file — no tmux client involved, so any pin's server counts. */
export function socketAccepts(path: string, timeoutMs = 1000): Promise<boolean> {
  if (!existsSync(path)) return Promise.resolve(false);
  return new Promise(resolve => {
    const s = connect(path);
    const done = (v: boolean) => { clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export interface DecideInputs {
  socket: string;
  /** This start's tmux: the server it would start. */
  current: { binary: string; sha256: string };
  /** A server accepts connections on the socket. */
  alive: boolean;
  record: ServerRecord | null;
  /** The recorded binary exists and still has the recorded sha256. */
  recordedClientIntact: boolean;
  /** What the recorded client read from the server, or why it could not. */
  facts: ServerFacts | { error: string } | null;
  /** The recorded pid is alive, started at the recorded time and runs the recorded binary. */
  recordedPidOurs: boolean;
}

/** §6 rule 2, pure. */
export function decideServer(i: DecideInputs): ServerDecision {
  if (!i.alive) return { kind: "fresh" };
  const r = i.record;
  let why: string;
  if (!r) why = "no record of the server AgEnD started";
  else if (r.socket !== i.socket) why = `the record names socket ${r.socket}, not ${i.socket}`;
  else if (!i.recordedClientIntact) why = `the tmux that started it (${r.binary}) is missing or changed`;
  else if (!i.facts) why = "it was not queried";
  else if ("error" in i.facts) why = `it did not answer its own client: ${i.facts.error}`;
  else if (i.facts.pid !== r.serverPid || i.facts.start !== r.serverStart) why = "it is not the server AgEnD recorded";
  else return r.sha256 === i.current.sha256 && r.binary === i.current.binary ? { kind: "same" } : { kind: "handover", client: r.binary, pid: r.serverPid };
  if (r && r.socket === i.socket && i.recordedPidOurs) return { kind: "pid-fallback", pid: r.serverPid, reason: why };
  return { kind: "hold", reason: why };
}

export const holdMessage = (reason: string): string =>
  `AgEnD's previous tmux server is still running and can't be verified: ${reason}. Nothing was stopped and no agent was started. Close that tmux server (agend tmux kill-server, or end its process), then restart AgEnD.`;

// ── probes (injected into reconcile; real ones below) ──

export interface ServerProbes {
  accepts(path: string): Promise<boolean>;
  /** Run a tmux client: resolves stdout, rejects with stderr/exit. */
  run(binary: string, args: string[]): Promise<string>;
  /** pid alive, its start time (epoch s) and executable path; null when gone/unknown. */
  proc(pid: number): Promise<{ start: number | null; exe: string | null } | null>;
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const FACTS = "#{version} #{pid} #{start_time}";

export async function queryFacts(p: ServerProbes, binary: string, socket: string): Promise<ServerFacts | { error: string }> {
  try {
    const out = (await p.run(binary, ["-L", socket, "display-message", "-p", FACTS])).trim().split(/\s+/);
    const pid = Number(out[1]), start = Number(out[2]);
    if (out.length !== 3 || !Number.isSafeInteger(pid) || !Number.isSafeInteger(start)) return { error: `unexpected answer "${out.join(" ")}"` };
    return { version: out[0]!, pid, start };
  } catch (e) { return { error: String((e as Error).message ?? e).split("\n")[0]!.slice(0, 200) }; }
}

/** Positive exit: the pid gone AND the socket refusing connections, within `budgetMs`. */
export async function waitServerGone(p: ServerProbes, pid: number, path: string, budgetMs = 10_000): Promise<boolean> {
  const deadline = p.now() + budgetMs;
  for (;;) {
    if (!(await p.proc(pid)) && !(await p.accepts(path))) return true;
    if (p.now() >= deadline) return false;
    await p.sleep(100);
  }
}

export interface ReconcileArgs {
  agendHome: string;
  socket: string;
  current: { binary: string; sha256: string };
  probes?: ServerProbes;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Before the fleet's server is ensured: make sure no server from another pin is still on the socket. Resolves null
 * (go ahead: no server, the same server, or the old one positively gone), or the hold reason (start nothing).
 */
export async function reconcileServer(a: ReconcileArgs): Promise<string | null> {
  const p = a.probes ?? realProbes;
  const path = socketPath(a.socket);
  const alive = await p.accepts(path);
  const record = readServerRecord(a.agendHome);
  let intact = false;
  if (alive && record) { try { intact = statSync(record.binary).isFile() && sha256File(record.binary) === record.sha256; } catch { intact = false; } }
  const facts = alive && record && intact && record.socket === a.socket ? await queryFacts(p, record.binary, a.socket) : null;
  let pidOurs = false;
  if (alive && record) {
    const pr = await p.proc(record.serverPid);
    pidOurs = !!pr && pr.start !== null && Math.abs(pr.start - record.serverStart) <= 2 && pr.exe !== null && sameFile(pr.exe, record.binary);
  }
  const d = decideServer({ socket: a.socket, current: a.current, alive, record, recordedClientIntact: intact, facts, recordedPidOurs: pidOurs });
  a.log?.("tmux server reconcile", { decision: d.kind, ...(("reason" in d) ? { reason: d.reason } : {}) });
  if (d.kind === "fresh" || d.kind === "same") return null;
  if (d.kind === "hold") return holdMessage(d.reason);
  if (d.kind === "handover") {
    try { await p.run(d.client, ["-L", a.socket, "kill-server"]); } catch { /* checked by the positive-exit wait */ }
  } else {
    try { p.kill(d.pid, "SIGTERM"); } catch { /* checked below */ }
  }
  if (await waitServerGone(p, d.pid, path)) return null;
  return holdMessage(`it did not exit after ${d.kind === "handover" ? "kill-server from its own tmux" : "SIGTERM"}`);
}

/** After the server is ensured: record it (read back with this start's own client). */
export async function recordServer(a: ReconcileArgs & { version: string }): Promise<ServerRecord | null> {
  const p = a.probes ?? realProbes;
  const facts = await queryFacts(p, a.current.binary, a.socket);
  if ("error" in facts) { a.log?.("tmux server record skipped", { error: facts.error }); return null; }
  const record: ServerRecord = { socket: a.socket, binary: a.current.binary, version: facts.version, sha256: a.current.sha256, serverPid: facts.pid, serverStart: facts.start };
  writeServerRecord(a.agendHome, record);
  return record;
}

/** Copies under <home>/tmux/ that neither this start nor the record names are removed (the previous one is kept). */
export function pruneCopies(agendHome: string, keep: string[]): string[] {
  const dir = join(agendHome, "tmux");
  const keepDirs = new Set(keep.map(b => b.split("/bin/tmux")[0]));
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return removed; }
  for (const n of names) {
    if (!/^[0-9][0-9a-z.]*-[0-9a-f]{12}$/.test(n)) continue;
    const full = join(dir, n);
    if (keepDirs.has(full)) continue;
    rmSync(full, { recursive: true, force: true });
    removed.push(n);
  }
  return removed;
}

function sameFile(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
}

const execFileText = (file: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(file, args, { timeout: 5000, encoding: "utf8" }, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));

let bootEpoch: number | null = null;
function procStartLinux(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);   // field 22 overall: starttime, in clock ticks since boot
    if (bootEpoch === null) bootEpoch = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(bootEpoch) ? Math.floor(bootEpoch + ticks / 100) : null;
  } catch { return null; }
}

export const realProbes: ServerProbes = {
  accepts: (path) => socketAccepts(path),
  run: execFileText,
  async proc(pid) {
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return null; }
    if (process.platform === "linux") {
      let exe: string | null = null;
      try { exe = readlinkSync(`/proc/${pid}/exe`); } catch { /* unknown */ }
      return { start: procStartLinux(pid), exe };
    }
    try {
      const out = (await execFileText("ps", ["-o", "lstart=", "-o", "comm=", "-p", String(pid)])).trim();
      const m = /^(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.+)$/.exec(out);
      return m ? { start: Math.floor(Date.parse(m[1]!) / 1000), exe: m[2]! } : { start: null, exe: null };
    } catch { return { start: null, exe: null }; }
  },
  kill: (pid, sig) => process.kill(pid, sig),
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  now: () => performance.now(),
};
