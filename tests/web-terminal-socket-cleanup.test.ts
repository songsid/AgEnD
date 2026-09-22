import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TmuxTerminalBackend } from "../src/web-terminal.js";

/**
 * tmux does not unlink its socket when the server exits. Verified on this tmux
 * for a clean `kill-server` and for SIGKILL alike — so every web-terminal
 * session left a file in /tmp/tmux-<uid>/, and a machine that runs the suite
 * had accumulated thousands.
 *
 * The socket is how every command reaches the server, so it can only be removed
 * once the server is CONFIRMED dead. That ordering is the thing these tests
 * exist to hold.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "agend-sock-"));
  dirs.push(dir);
  return dir;
}

/**
 * A stand-in tmux. `kill-server` succeeds or fails on demand, and
 * `list-sessions` answers from a file the test controls, which is what
 * `serverState` reads to decide "dead".
 */
function fakeTmux(dir: string, opts: { aliveAfterKill?: boolean } = {}) {
  const bin = join(dir, "tmux");
  writeFileSync(bin, `#!/usr/bin/env bash
# args: -L <socket> <op> ...
op="$3"
case "$op" in
  list-sessions)  [ -f "${dir}/alive" ] && exit 0 || exit 1 ;;
  kill-server)    ${opts.aliveAfterKill ? "exit 0" : `rm -f "${dir}/alive"; exit 0`} ;;
  display-message) echo "${dir}/the.sock" ;;
  *) exit 0 ;;
esac
`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "alive"), "");          // a live server, until kill-server
  writeFileSync(join(dir, "the.sock"), "");       // stands in for the socket file
  return bin;
}

describe("the tmux socket file", () => {
  it("is removed once the server is confirmed dead", async () => {
    const dir = workspace();
    const backend = new TmuxTerminalBackend(fakeTmux(dir));
    backend.rememberServerForTests("agend-term-abc", 999_999, "identity", join(dir, "the.sock"));

    expect(existsSync(join(dir, "the.sock"))).toBe(true);
    await backend.kill("agend-term-abc");

    expect(existsSync(join(dir, "the.sock")), "the socket should not outlive the server").toBe(false);
  });

  it("is left alone while the server cannot be confirmed dead", async () => {
    // The socket is the only way to reach the server. Removing it here would
    // strand a live tmux that nothing — including a later retry — can talk to.
    const dir = workspace();
    const backend = new TmuxTerminalBackend(fakeTmux(dir, { aliveAfterKill: true }), {
      probeProcess: () => ({ kind: "unknown" }),
    });
    backend.rememberServerForTests("agend-term-abc", 999_999, "identity", join(dir, "the.sock"));

    await expect(backend.kill("agend-term-abc")).rejects.toThrow(/could not be confirmed dead/);

    expect(existsSync(join(dir, "the.sock")), "a socket whose server may be alive must stay").toBe(true);
  });

  it("does not fail the kill when the file is already gone", async () => {
    const dir = workspace();
    const backend = new TmuxTerminalBackend(fakeTmux(dir));
    backend.rememberServerForTests("agend-term-abc", 999_999, "identity", join(dir, "never-existed.sock"));

    await expect(backend.kill("agend-term-abc")).resolves.toBeUndefined();
  });

  it("removes nothing when no path was recorded", async () => {
    // A platform where the `display-message` probe failed: the kill still has
    // to work, it just has nothing to clean up.
    const dir = workspace();
    const backend = new TmuxTerminalBackend(fakeTmux(dir));
    backend.rememberServerForTests("agend-term-abc", 999_999, "identity");

    await expect(backend.kill("agend-term-abc")).resolves.toBeUndefined();
    expect(existsSync(join(dir, "the.sock"))).toBe(true);
  });
});

const haveTmux = (() => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
})();

describe.skipIf(!haveTmux)("against the real tmux", () => {
  it("leaves no socket behind for a session it started", async () => {
    // The unit tests above trust a recorded path. This one proves the path is
    // recorded correctly in the first place — it is asked of tmux, not built
    // from a guess about TMUX_TMPDIR and the uid.
    const dir = workspace();
    const backend = new TmuxTerminalBackend();
    const socket = `agend-term-test-${process.pid}-${Date.now().toString(36)}`;

    await backend.start({ socket, command: "sleep 30", cwd: dir, cols: 80, rows: 24, onOutput: () => {} });
    // Built the same way tmux lays them out — used here only to OBSERVE, which
    // is exactly the guess the implementation refuses to make when deleting.
    const socketPath = join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket);
    expect(existsSync(socketPath), "tmux should have created the socket").toBe(true);

    await backend.kill(socket);

    expect(existsSync(socketPath), "the socket should be gone after kill").toBe(false);
  }, 30_000);
});
