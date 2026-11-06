/**
 * M-2457 PR C §6 rule 3 (docs/design/bundled-tmux.md): an agent window 2.3 left on the SYSTEM tmux's default server.
 * Per instance before it starts: an untagged window-id (2.3's) is proven ours (id, name, backend in the pane tree),
 * checkpointed, killed with kill-window (never kill-server), confirmed gone, and the id dropped; anything unprovable
 * holds only that instance. The journal resumes an interrupted pass on the same server incarnation without
 * checkpointing twice. Isolation: temp dirs; the real-tmux case runs on a private agend-test- socket.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type LegacyProbes, LegacyWindowHoldError, migrateLegacyWindow, readJournal, realLegacyProbes, releaseLegacyWindow, tagWindowId, treeRuns,
  windowIdState, writeJournal,
} from "../src/tmux-legacy.js";

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-tmuxlegacy-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function inst(windowId?: string) {
  const home = scratch(), dir = join(home, "instances", "dev");
  mkdirSync(dir, { recursive: true });
  if (windowId) writeFileSync(join(dir, "window-id"), windowId);
  return { home, dir };
}

describe("the window-id tag", () => {
  it("none / tagged / untagged; a tag written for another id (a rollback's rewrite) is no tag", () => {
    const { dir } = inst();
    expect(windowIdState(dir)).toEqual({ kind: "none" });
    writeFileSync(join(dir, "window-id"), "@7\n");
    expect(windowIdState(dir)).toEqual({ kind: "untagged", id: "@7" });
    tagWindowId(dir, "agend", "@7");
    expect(windowIdState(dir)).toEqual({ kind: "tagged", id: "@7", socket: "agend" });
    writeFileSync(join(dir, "window-id"), "@3");          // 2.3 after a rollback: the old tag stays behind
    expect(windowIdState(dir)).toEqual({ kind: "untagged", id: "@3" });
  });
});

describe("treeRuns", () => {
  const procs = new Map([[100, { ppid: 1, args: "/bin/sh -c exec claude --resume x" }], [101, { ppid: 100, args: "/usr/local/bin/claude --resume x" }],
    [200, { ppid: 1, args: "bash" }], [201, { ppid: 200, args: "vim notes" }]]);
  it("finds the backend's binary in the pane's tree by basename (argv[0] or a wrapper's first word), not elsewhere", () => {
    expect([treeRuns(procs, 100, "claude"), treeRuns(procs, 200, "claude"), treeRuns(procs, 100, "codex")]).toEqual([true, false, false]);
  });
});

/** A default server with `windows`; `closes` = kill-window removes the window and its pane exits. */
function fakes(o: { tmux?: string | null; windows?: Array<[string, string, string, number]>; server?: string | Error; closes?: boolean;
  procs?: Map<number, { ppid: number; args: string }> } = {}) {
  const calls: string[] = [];
  let windows = [...(o.windows ?? [["agend", "@7", "dev", 4000]])];
  const dead = new Set<number>();
  const p: LegacyProbes = {
    async systemTmux() { return o.tmux === undefined ? "/usr/bin/tmux" : o.tmux; },
    async tmux(_bin, args) {
      calls.push(args.join(" "));
      if (o.server instanceof Error) throw o.server;
      if (args[0] === "display-message") return o.server ?? "77 1700000000";
      if (args[0] === "kill-window") {
        if (o.closes !== false) { const w = windows.find(x => x[1] === args[2]); windows = windows.filter(x => x[1] !== args[2]); if (w) dead.add(w[3]); }
        return "";
      }
      if (args.includes("#{window_id}")) return windows.map(w => w[1]).join("\n");
      return windows.map(w => w.join("\t")).join("\n");
    },
    async processes() { return o.procs ?? new Map([[4000, { ppid: 1, args: "claude --resume abc" }]]); },
    alive: (pid) => !dead.has(pid),
    async sleep() { /* instant */ },
  };
  return { p, calls };
}

const args = (x: ReturnType<typeof inst>, p: LegacyProbes, checkpoint = () => {}) =>
  ({ agendHome: x.home, instance: "dev", instanceDir: x.dir, session: "agend", backendBinary: "claude", checkpoint, probes: p });

describe("migrateLegacyWindow", () => {
  it("proven: checkpoint, kill-window (never kill-server), confirmed gone, the id dropped, the journal at confirmed", async () => {
    const x = inst("@7");
    const { p, calls } = fakes();
    let checkpoints = 0;
    expect(await migrateLegacyWindow(args(x, p, () => { checkpoints++; }))).toBe("migrated");
    expect(checkpoints).toBe(1);
    expect(calls.filter(c => c.startsWith("kill"))).toEqual(["kill-window -t @7"]);
    expect(existsSync(join(x.dir, "window-id"))).toBe(false);
    expect(readJournal(x.home)).toEqual({ server: { pid: 77, start: 1700000000 }, windows: { dev: { windowId: "@7", step: "confirmed" } }, released: {} });
  });

  it.each<[string, Parameters<typeof fakes>[0], RegExp]>([
    ["another window name", { windows: [["agend", "@7", "someone-else", 4000]] }, /named "someone-else", not "dev"/],
    ["not running the backend", { procs: new Map([[4000, { ppid: 1, args: "bash" }]]) }, /does not run claude/],
    ["no system tmux to ask", { tmux: null }, /no system tmux to ask/],
    ["a default server that answers but can't be queried", { server: new Error("protocol version mismatch (client 8, server 9)") }, /can't be queried \(protocol version mismatch/],
    ["a window that does not close", { closes: false }, /did not close/],
  ])("held (only this instance), nothing else killed: %s", async (_why, o, msg) => {
    const x = inst("@7");
    const { p, calls } = fakes(o);
    const err = await migrateLegacyWindow(args(x, p)).catch(e => e);
    expect(err).toBeInstanceOf(LegacyWindowHoldError);
    expect(err.message).toMatch(msg);
    expect(err.message).toMatch(/agend tmux-migrate --release dev/);
    expect(calls.some(c => c.startsWith("kill-server"))).toBe(false);
    if (o?.closes !== false) expect(calls.some(c => c.startsWith("kill-window"))).toBe(false);
  });

  it("no default server, or no such window: nothing to do; the stale id is dropped (it means nothing on the new server)", async () => {
    for (const o of [{ server: new Error("no server running on /tmp/tmux-1000/default") }, { windows: [["agend", "@9", "dev", 4000]] as Array<[string, string, string, number]> }]) {
      const x = inst("@7");
      expect(await migrateLegacyWindow(args(x, fakes(o).p))).toBe("stale");
      expect(existsSync(join(x.dir, "window-id"))).toBe(false);
    }
  });

  it("tagged (written with the bundled tmux on) or no file: not looked at", async () => {
    const x = inst("@7"); tagWindowId(x.dir, "agend", "@7");
    const { p, calls } = fakes();
    expect([await migrateLegacyWindow(args(x, p)), await migrateLegacyWindow(args(inst(), p))]).toEqual(["tagged", "none"]);
    expect(calls).toEqual([]);
  });

  it("an interrupted pass resumes on the same server without checkpointing twice; another incarnation starts afresh", async () => {
    const x = inst("@7");
    writeJournal(x.home, { server: { pid: 77, start: 1700000000 }, windows: { dev: { windowId: "@7", step: "checkpointed" } }, released: {} });
    let checkpoints = 0;
    expect(await migrateLegacyWindow(args(x, fakes().p, () => { checkpoints++; }))).toBe("migrated");
    expect(checkpoints).toBe(0);
    const y = inst("@7");
    writeJournal(y.home, { server: { pid: 55, start: 1600000000 }, windows: { dev: { windowId: "@7", step: "confirmed" } }, released: {} });
    expect(await migrateLegacyWindow(args(y, fakes().p, () => { checkpoints++; }))).toBe("migrated");
    expect(checkpoints).toBe(1);
  });

  it("released by the user: left alone, nothing asked or killed, the id dropped", async () => {
    const x = inst("@7");
    expect(releaseLegacyWindow(x.home, "dev", x.dir)).toBe("@7");
    const { p, calls } = fakes();
    expect(await migrateLegacyWindow(args(x, p))).toBe("released");
    expect(calls).toEqual([]);
    expect(releaseLegacyWindow(x.home, "dev", x.dir)).toBeNull();   // nothing held any more
  });
});

const TMUX = (() => { try { return execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim() || null; } catch { return null; } })();

describe.skipIf(!TMUX)("a real legacy window on a private socket", () => {
  it("proves, closes and confirms an old agent window; a user's own session on that server survives", async () => {
    const socket = `agend-test-legacy-${process.pid}`;
    const t = (a: string[]) => execFileSync(TMUX!, ["-L", socket, ...a], { encoding: "utf8" });
    // A stand-in agent (the test guard forbids running a real backend CLI): its tree runs "agend-mock-cli".
    const bin = scratch(), mock = join(bin, "agend-mock-cli");
    writeFileSync(mock, "#!/bin/sh\nsleep 600\n", { mode: 0o755 });
    t(["-f", "/dev/null", "new-session", "-d", "-s", "agend", "-n", "dev", mock]);
    t(["new-session", "-d", "-s", "mine", "sleep 600"]);   // the user's own session on the same server
    try {
      const id = t(["list-windows", "-t", "agend", "-F", "#{window_id}"]).trim();
      expect(id).toMatch(/^@\d+$/);
      const x = inst(id);
      const p: LegacyProbes = { ...realLegacyProbes, systemTmux: async () => TMUX, tmux: (bin, a) => realLegacyProbes.tmux(bin, ["-L", socket, ...a]) };
      expect(await migrateLegacyWindow({ ...args(x, p), backendBinary: "agend-mock-cli" })).toBe("migrated");
      expect(t(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean)).toEqual(["mine"]);
    } finally { try { execFileSync(TMUX!, ["-L", socket, "kill-server"], { stdio: "ignore" }); } catch { /* gone */ } }
  });
});
