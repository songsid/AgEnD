/**
 * M-2457 §7: the 2.3 line refuses to start agents beside 2.4's own tmux server (a raw `npm install -g` downgrade that
 * skipped `agend rollback`). The real home: anything on the `agend` socket. Another home: only the server 2.4 recorded
 * on the shared hashed socket, or one this version's tmux can't talk to — never this version's own server.
 * Isolation: temp dirs; the real-socket case uses a private TMUX_TMPDIR and -S under it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GuardDeps, guardMessage, newerTmuxServer, realGuardDeps, socketFile } from "../src/bundled-tmux-guard.js";

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-guard-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function deps(o: Partial<GuardDeps> & { record?: number; up?: string[] } = {}): GuardDeps {
  const home = scratch();
  if (o.record !== undefined) { mkdirSync(join(home, "tmux")); writeFileSync(join(home, "tmux", "server.json"), JSON.stringify({ serverPid: o.record })); }
  return { agendHome: home, realHome: false, socket: "agend-1a2b3c", accepts: async (l) => (o.up ?? []).includes(l), serverPid: async () => 4242, ...o };
}

describe("newerTmuxServer", () => {
  it("the real home: anything answering on `agend` (2.3 never uses it); nothing there → go ahead", async () => {
    expect(await newerTmuxServer(deps({ realHome: true, socket: null, up: ["agend"] }))).toBe("agend");
    expect(await newerTmuxServer(deps({ realHome: true, socket: null, up: [] }))).toBeNull();
  });

  it.each<[string, Parameters<typeof deps>[0], string | null]>([
    ["no record: 2.4 never ran here", { up: ["agend-1a2b3c"] }, null],
    ["the recorded server (same pid)", { record: 4242, up: ["agend-1a2b3c"] }, "agend-1a2b3c"],
    ["this version's own server (another pid)", { record: 999, up: ["agend-1a2b3c"] }, null],
    ["a server this version's tmux can't talk to", { record: 999, up: ["agend-1a2b3c"], serverPid: async () => new Error("protocol version mismatch") }, "agend-1a2b3c"],
    ["the record left behind, nothing running", { record: 4242, up: [] }, null],
  ])("another home: %s", async (_why, o, want) => {
    expect(await newerTmuxServer(deps(o))).toBe(want);
  });

  it("another home where 2.4 never ran: this version's own server is not even asked (no tmux runs)", async () => {
    let asked = 0;
    expect(await newerTmuxServer(deps({ up: ["agend-1a2b3c"], serverPid: async () => { asked++; return 4242; } }))).toBeNull();
    expect(asked).toBe(0);
  });

  it("the message says nothing started, why, and the two ways out", () => {
    expect(guardMessage("agend")).toMatch(/^AgEnD 2\.4's own tmux server is still running \(socket agend\).*no agent was started\. Go back with `agend rollback` from 2\.4, or close that server/);
  });
});

const TMUX = (() => { try { return execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim() || null; } catch { return null; } })();

describe.skipIf(!TMUX)("a real server on the real home's `agend` socket", () => {
  it("is found by connecting to its socket file (no tmux client involved)", async () => {
    const dir = scratch();
    const prev = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = dir;
    const path = socketFile("agend");
    mkdirSync(join(dir, `tmux-${process.getuid!()}`), { recursive: true, mode: 0o700 });
    try {
      const d = realGuardDeps(scratch(), true, null);
      expect(await newerTmuxServer(d)).toBeNull();
      execFileSync(TMUX!, ["-S", path, "-f", "/dev/null", "new-session", "-d", "sleep 60"]);
      expect(await newerTmuxServer(d)).toBe("agend");
    } finally {
      try { execFileSync(TMUX!, ["-S", path, "kill-server"], { stdio: "ignore" }); } catch { /* gone */ }
      if (prev === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = prev;
    }
  });
});
