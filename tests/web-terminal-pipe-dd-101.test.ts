import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TmuxTerminalBackend } from "../src/web-terminal.js";

/**
 * AGEND-101: a sign-in's terminal output reaches AgEnD through a FIFO that tmux's pipe-pane writes to. With `cat >> fifo`, GNU cat
 * uses splice(), and on Linux 6.6 its second splice() takes the FIFO's lock and then sleeps on tmux's socket waiting for more output while
 * holding it — so AgEnD's own read() of the FIFO blocks in the kernel (state D, wchan pipe_read) and the whole process freezes as soon as
 * a login prints its first lines and waits for input. `dd` copies with read() + write() and never holds the lock.
 *
 * What this holds is the command start() gives pipe-pane (run through a stand-in tmux that records its arguments): dd, not cat, writing to
 * the FIFO start() made, attached BEFORE the real command starts (so no byte is lost).
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function recordingTmux() {
  const dir = mkdtempSync(join(tmpdir(), "agend-pipe-dd-")); dirs.push(dir);
  const log = join(dir, "calls.log"), bin = join(dir, "tmux");
  writeFileSync(bin, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case " $* " in
  *" list-sessions "*) echo "no server running on ${dir}/the.sock" >&2; exit 1 ;;   # kill() asks: no server left
  *"#{socket_path}"*) echo "${dir}/the.sock" ;;
esac
# No answer for "#{pid}": start() records no server PID, so kill() can never signal a process (a made-up PID could be somebody else's).
exit 0
`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "the.sock"), "");
  return { dir, bin, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

describe("the terminal's output pipe uses dd, not cat (AGEND-101)", () => {
  it("pipe-pane runs `dd bs=65536 status=none >> <the FIFO start() made>` and never cat", async () => {
    const t = recordingTmux();
    const backend = new TmuxTerminalBackend(t.bin);
    try {
      await backend.start({ socket: "agend-term-dd101", command: "echo hi", cwd: t.dir, cols: 80, rows: 24, onOutput: () => {} });
      const pipe = t.calls().find((l) => / pipe-pane /.test(` ${l} `));
      expect(pipe, "start() attaches an output pipe").toBeTruthy();
      expect(pipe).toMatch(/dd bs=65536 status=none >> '[^']*\/agend-term-[^']*\/out'/);            // into the FIFO in its own temp dir
      expect(pipe).not.toMatch(/\bcat\b/);
    } finally { await backend.kill("agend-term-dd101"); }
  });

  it("the pipe is attached before the real command starts, so no output is lost", async () => {
    const t = recordingTmux();
    const backend = new TmuxTerminalBackend(t.bin);
    try {
      await backend.start({ socket: "agend-term-dd101b", command: "echo hi", cwd: t.dir, cols: 80, rows: 24, onOutput: () => {} });
      const ops = t.calls().map((l) => (l.match(/\b(new-session|pipe-pane|respawn-pane)\b/) || [])[1]).filter(Boolean);
      expect(ops).toEqual(["new-session", "pipe-pane", "respawn-pane"]);
    } finally { await backend.kill("agend-term-dd101b"); }
  });
});
