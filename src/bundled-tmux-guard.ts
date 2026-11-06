/**
 * M-2457 §7 (docs/design/bundled-tmux.md, on release/2.3.5-alpha): the 2.3 line's guard against a raw downgrade.
 *
 * From 2.4, AgEnD runs its own (bundled) tmux on a private socket — `agend` for the real home, the home's hashed name
 * otherwise — and records the server in `<AGEND_HOME>/tmux/server.json`. The supported way back is `agend rollback`
 * (from 2.4), which closes that server first. A plain `npm install -g @songsid/agend@2.3.x` skips that; on launchd or a
 * foreground fleet the 2.4 server can survive, still running agents, and this version would start each conversation a
 * second time beside it. So before any instance starts, this version refuses when that server is still there.
 *
 * Which server counts:
 *  - the real home: anything answering on `agend` (this version never uses that socket);
 *  - another home: its hashed socket is this version's own too, so only the server server.json recorded (same pid), or
 *    one this version's tmux cannot talk to (another protocol: the bundled tmux).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

export interface GuardDeps {
  agendHome: string;
  realHome: boolean;
  /** This version's socket name (null: tmux's default socket, the real home). */
  socket: string | null;
  accepts(label: string): Promise<boolean>;
  /** The server's pid as this version's (system) tmux reads it; an error (e.g. a protocol version mismatch); or
   *  "timeout" when tmux did not answer in time (a loaded host: unconfirmed, not "another protocol"). */
  serverPid(label: string): Promise<number | Error | "timeout">;
}

export interface GuardHit { socket: string; confirmed: boolean }

export const guardMessage = (hit: GuardHit | string): string => {
  const h = typeof hit === "string" ? { socket: hit, confirmed: true } : hit;
  return (h.confirmed
    ? `AgEnD 2.4's own tmux server is still running (socket ${h.socket}), and its agents may still be running in it. `
    : `A tmux server on socket ${h.socket}, where AgEnD 2.4 recorded its own, did not answer in time, so it could not be confirmed as this version's. `) +
  `Starting this version beside it could run each conversation twice, so no agent was started. ` +
  `Go back with \`agend rollback\` from 2.4, or close that server with the tmux that started it ` +
  `(agend tmux kill-server, from 2.4), then start AgEnD again. Run as a service, AgEnD keeps retrying the start until it is closed.`;
};

function recordedPid(agendHome: string): number | null {
  try {
    const r = JSON.parse(readFileSync(join(agendHome, "tmux", "server.json"), "utf8"));
    return Number.isSafeInteger(r?.serverPid) ? r.serverPid : null;
  } catch { return null; }
}

/** A 2.4 server still there for this home (confirmed, or unconfirmed: it did not answer in time), or null (go ahead). */
export async function newerTmuxServer(d: GuardDeps): Promise<GuardHit | null> {
  if (d.realHome) return (await d.accepts("agend")) ? { socket: "agend", confirmed: true } : null;
  if (!d.socket || !existsSync(join(d.agendHome, "tmux", "server.json"))) return null;
  if (!(await d.accepts(d.socket))) return null;
  const pid = await d.serverPid(d.socket);
  if (pid === "timeout") return { socket: d.socket, confirmed: false };   // fail closed, but say what is known
  if (pid instanceof Error) return { socket: d.socket, confirmed: true };   // not a server this version's tmux can talk to
  return pid === recordedPid(d.agendHome) ? { socket: d.socket, confirmed: true } : null;
}

export function socketFile(label: string, env: NodeJS.ProcessEnv = process.env, uid: number = process.getuid?.() ?? 0): string {
  return join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`, label);
}

export const realGuardDeps = (agendHome: string, realHome: boolean, socket: string | null): GuardDeps => ({
  agendHome, realHome, socket,
  accepts: (label) => {
    const path = socketFile(label);
    if (!existsSync(path)) return Promise.resolve(false);
    return new Promise(resolve => {
      const s = connect(path);
      const done = (v: boolean) => { clearTimeout(timer); s.destroy(); resolve(v); };
      const timer = setTimeout(() => done(false), 1000);
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
  },
  serverPid: (label) => new Promise(resolve => {
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
    execFile("tmux", ["-L", label, "display-message", "-p", "#{pid}"], { timeout: 5000, encoding: "utf8", env }, (err, stdout, stderr) => {
      if (err && (err as { killed?: boolean }).killed) { resolve("timeout"); return; }
      const pid = Number(stdout.trim());
      resolve(err || !Number.isSafeInteger(pid) ? new Error((stderr || err?.message || "no pid").trim()) : pid);
    });
  }),
});
