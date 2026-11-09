import { spawn, spawnSync } from "node:child_process";
import { chmodSync, constants as fsConstants, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TmuxTerminalBackend, outputPipeCommand } from "../src/web-terminal.js";

/**
 * #3212: a sign-in's terminal output reaches AgEnD through a FIFO that tmux's pipe-pane writes to. With `cat >> fifo`, GNU cat
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

describe("the terminal's output pipe uses dd, not cat (#3212)", () => {
  it("pipe-pane runs `dd bs=65536 2>/dev/null >> <the FIFO start() made>` and never cat (no `status=` operand)", async () => {
    const t = recordingTmux();
    const backend = new TmuxTerminalBackend(t.bin);
    try {
      await backend.start({ socket: "agend-term-dd101", command: "echo hi", cwd: t.dir, cols: 80, rows: 24, onOutput: () => {} });
      const pipe = t.calls().find((l) => / pipe-pane /.test(` ${l} `));
      expect(pipe, "start() attaches an output pipe").toBeTruthy();
      expect(pipe).toMatch(/dd bs=65536 2>\/dev\/null >> '[^']*\/agend-term-[^']*\/out'/);          // into the FIFO in its own temp dir
      expect(pipe).not.toMatch(/\bcat\b/);
      expect(pipe).not.toMatch(/status=/);                                                          // macOS 11.0.1 / 12.0.1's dd has no such operand
      expect(pipe).toContain(outputPipeCommand(/'([^']*\/agend-term-[^']*\/out)'/.exec(pipe!)![1]!));   // exactly what outputPipeCommand() builds
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

/**
 * #3321 review: `status=none` is not an operand of the dd of macOS 11.0.1 / 12.0.1 (supported platforms): it exits, and a pipe child that has
 * exited forwards nothing — pipe-pane's success and the FIFO's O_RDWR reader do not show it. So the command is run here on a real shell, with a real
 * FIFO read the way start() reads it, and short chunks written one at a time: each must reach the reader while the writer is still open (live, not
 * held until EOF). a `dd` from a stand-in directory first on PATH refuses any `status=` operand, as those macOS releases do; the old command is the
 * control that fails there.
 */
describe("the output pipe forwards short chunks on a real shell, with a dd that has no `status=` operand (#3321 review)", () => {
  const realDd = spawnSync("sh", ["-c", "command -v dd"], { encoding: "utf8" }).stdout.trim();

  function oldStyleDd(): string {                      // a stand-in `dd` the way macOS 11.0.1 / 12.0.1 parse their operands
    const dir = mkdtempSync(join(tmpdir(), "agend-old-dd-")); dirs.push(dir);
    writeFileSync(join(dir, "dd"), `#!/bin/sh
for a in "$@"; do case "$a" in status=*) echo "dd: $a: unknown operand" >&2; exit 1 ;; esac; done
exec "${realDd}" "$@"
`);
    chmodSync(join(dir, "dd"), 0o755);
    return dir;
  }

  async function forward(command: (fifo: string) => string, pathPrefix = ""): Promise<{ live: string[]; received: string; code: number | null; stderr: string }> {
    const dir = mkdtempSync(join(tmpdir(), "agend-pipe-fwd-")); dirs.push(dir);
    const fifo = join(dir, "out");
    expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
    const fd = openSync(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);       // as start(): we are a writer too, so there is never an EOF
    const stream = new NetSocket({ fd, readable: true, writable: false });
    let received = "";
    stream.on("data", (b: Buffer | string) => { received += b.toString(); });
    const child = spawn("sh", ["-c", command(fifo)], { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, PATH: `${pathPrefix}${pathPrefix ? ":" : ""}${process.env.PATH}` } });
    let stderr = ""; child.stderr.on("data", (b) => { stderr += b.toString(); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const until = async (want: string, ms: number) => { const t0 = Date.now(); while (!received.includes(want) && Date.now() - t0 < ms && child.exitCode === null) await new Promise((r) => setTimeout(r, 10)); return received.includes(want); };
    const live: string[] = [];
    try {
      for (const chunk of ["ab", "cde", "\u001b[0m$ "]) {                          // short chunks, some escape bytes among them
        if (child.exitCode === null) child.stdin.write(chunk);
        const got = await until(chunk, 1500);                                       // reaches the reader with the writer still open
        if (got) live.push(chunk);
      }
      child.stdin.end();
      const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
      return { live, received, code, stderr };
    } finally { child.kill("SIGKILL"); stream.destroy(); }
  }

  it("the command start() uses forwards each short chunk as it arrives, exits 0 and leaves dd's summary out of the output", async () => {
    const r = await forward(outputPipeCommand);
    expect(r.live).toEqual(["ab", "cde", "\u001b[0m$ "]);
    expect(r.received).toBe("abcde\u001b[0m$ ");                                    // dd's "records in/out" lines are not in it
    expect(r.code).toBe(0);
  });

  it("with a dd that refuses `status=` (macOS 11.0.1 / 12.0.1): the old command forwards nothing and exits; the command now used forwards", async () => {
    const stand = oldStyleDd();
    const before = await forward((fifo) => `dd bs=65536 status=none >> '${fifo}'`, stand);
    expect(before.live).toEqual([]);
    expect(before.received).toBe("");
    expect(before.code).toBe(1);
    expect(before.stderr).toMatch(/unknown operand/);
    const after = await forward(outputPipeCommand, stand);
    expect(after.live).toEqual(["ab", "cde", "\u001b[0m$ "]);
    expect(after.code).toBe(0);
  });
});
