/**
 * M-2281 (#2980): `/login`'s install window.
 *
 * - The wrapper (unattended-install.ts) runs in real sh under a real pseudo-terminal: an installer that asks on
 *   /dev/tty, or on stdin when it is a terminal, gets no answer and goes on at once; the exit code is the install's;
 *   a HUP to the window's shell stops the install's whole process group; an ionice that refuses does not stop it.
 * - The live view (install-stream.ts): one message, then edits — no faster than the interval, none for an unchanged
 *   frame, masked and bounded, a final frame over the same message.
 * - LoginSession hands every poll's capture to onProgress before its verdict, and none after it finished.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { unattendedInstallCommand, loginShell, UNATTENDED_INSTALL_SCRIPT, installExitMarker, exitCodeFromMarker, withoutExitMarker } from "../src/unattended-install.js";
import { InstallStream, renderInstallFrame, INSTALL_STREAM_BYTES, INSTALL_STREAM_LINES, type InstallStreamClock } from "../src/install-stream.js";
import { LoginSession, type LoginTmux } from "../src/login-manager.js";
import { t } from "../src/locale.js";

const dir = mkdtempSync(join(tmpdir(), "agend-2980-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** codex's prompt_yes_no shape: /dev/tty when it opens, else stdin when it is a terminal. */
const ASKS = join(dir, "asks.sh");
writeFileSync(ASKS, `#!/bin/sh
if ( : </dev/tty ) 2>/dev/null; then printf 'Start now? [y/N] ' >/dev/tty; IFS= read -r a </dev/tty; echo "answered:$a"
elif [ -t 0 ]; then printf 'Start now? [y/N] '; IFS= read -r a; echo "answered:$a"
else echo "no terminal: skipped"; fi
echo installed
`, { mode: 0o755 });

const hasPython = spawnSync("python3", ["-c", "import pty"]).status === 0;
/** Run a sh command line under a fresh pseudo-terminal (its controlling tty); null when it timed out. */
function underPty(command: string, timeoutMs = 6000, env: NodeJS.ProcessEnv = process.env): { status: number | null; out: string } | null {
  const r = spawnSync("python3", ["-c", "import pty,sys; sys.exit(pty.spawn(['sh','-c',sys.argv[1]]) >> 8)", command],
    { encoding: "utf8", timeout: timeoutMs, input: "", env });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return null;
  return { status: r.status, out: r.stdout };
}

describe("the install wrapper: nothing can wait on a terminal (M-2281)", () => {
  it.skipIf(!hasPython)("control: under a terminal, the bare installer waits for an answer", () => {
    expect(underPty(`sh ${ASKS}`, 2500)).toBeNull();
  });

  it.skipIf(!hasPython)("through the wrapper, the same installer under the same terminal finishes at once, unasked", () => {
    const r = underPty(unattendedInstallCommand(`sh ${ASKS}`, null));
    expect(r).not.toBeNull();
    expect(r!.status).toBe(0);
    expect(r!.out).toContain("no terminal: skipped");
    expect(r!.out).not.toContain("Start now?");
  });

  it.skipIf(!hasPython)("without setsid (macOS) stdin is still /dev/null: the stdin prompt is not asked", () => {
    // A PATH whose setsid is missing: only sh and the tools the wrapper needs.
    const bin = join(dir, "nosetsid"); mkdirSync(bin, { recursive: true });
    for (const tool of ["sh", "nice", "cat", "printf"]) {
      const real = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (real) writeFileSync(join(bin, tool), `#!/bin/sh\nexec ${real} "$@"\n`, { mode: 0o755 });
    }
    // Under this PATH /dev/tty still opens (no new session), so the stdin branch is what is shown: answer it via stdin.
    const stdinOnly = join(dir, "stdin-only.sh");
    writeFileSync(stdinOnly, `#!/bin/sh\nif [ -t 0 ]; then printf 'Start now? [y/N] '; IFS= read -r a; fi\necho installed\n`, { mode: 0o755 });
    const r = underPty(`PATH=${bin}; export PATH; ${unattendedInstallCommand(`sh ${stdinOnly}`, null)}`);
    expect(r).not.toBeNull();
    expect(r!.out).toContain("installed");
    expect(r!.out).not.toContain("Start now?");
  });

  it("keeps the install's exit code", () => {
    const r = spawnSync("sh", ["-c", unattendedInstallCommand("echo out; exit 3", null)], { encoding: "utf8" });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("out");
  });

  it("an ionice that refuses (a container) does not stop the install", () => {
    const bin = join(dir, "badionice"); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ionice"), "#!/bin/sh\necho 'ioprio_set: Operation not permitted' >&2\nexit 1\n", { mode: 0o755 });
    const r = spawnSync("sh", ["-c", unattendedInstallCommand("echo ran", null)], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ran");
  });

  it("a HUP to the window's shell (cancel, timeout, fleet stop) stops the install's whole process group", async () => {
    const marker = join(dir, `grandchild-${process.pid}`);
    const pidFile = join(dir, "grandchild.pid");
    // The install starts a grandchild that would write the marker after 3 s if it survived.
    const install = `sh -c 'echo $$ > ${pidFile}; sleep 3; touch ${marker}' & wait`;
    const child = spawn("sh", ["-c", unattendedInstallCommand(install, null)], { stdio: "ignore", detached: true });
    const deadline = Date.now() + 3000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(pidFile)).toBe(true);
    const exited = new Promise<void>(resolve => child.on("exit", () => resolve()));
    // What closing a tmux window does: SIGHUP to the window's process group. The install is in a session of its own
    // (setsid), so only the wrapper's trap can reach it.
    process.kill(-child.pid!, "SIGHUP");
    await exited;
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise(r => setTimeout(r, 200));
    let alive = true;
    try { process.kill(grandchild, 0); } catch { alive = false; }
    expect(alive).toBe(false);
    await new Promise(r => setTimeout(r, 3200));
    expect(existsSync(marker)).toBe(false);
  }, 10_000);

  it.skipIf(spawnSync("tmux", ["-L", "agend-test-2980-probe", "-V"]).status !== 0)("in a tmux window, an install that ends at once still leaves its exit code and output (remain-on-exit is waited for)", async () => {
    const sock = `agend-test-2980-${process.pid}`;
    const tmux = (...args: string[]) => spawnSync("tmux", ["-L", sock, ...args], { encoding: "utf8" });
    const marker = installExitMarker();
    try {
      tmux("new-session", "-d", "-s", "s", "-x", "80", "-y", "20", `sleep 60`);
      // What LoginSession does: the window first, remain-on-exit some time after (here 500 ms — far longer than the install).
      const id = tmux("new-window", "-d", "-t", "s:", "-P", "-F", "#{window_id}", unattendedInstallCommand("echo 'error: no terminal'; exit 3", null, marker)).stdout.trim();
      expect(id).toMatch(/^@\d+$/);
      await new Promise(r => setTimeout(r, 500));
      expect(tmux("set-option", "-t", `s:${id}`, "remain-on-exit", "on").status).toBe(0);
      // The explicit condition: the pane is dead — its pty reached EOF, so every byte the install and the wrapper wrote
      // is in the pane (and the window was kept: remain-on-exit was waited for). Not tmux's exit status: tmux 3.4 can
      // miss the pane's SIGCHLD and never record it (the CI flake: "1" for "1 3"); the wrapper's own verdict line is read.
      let dead = "";
      for (let i = 0; i < 200 && dead !== "1"; i++) { await new Promise(r => setTimeout(r, 25)); dead = tmux("display-message", "-p", "-t", `s:${id}`, "#{pane_dead}").stdout.trim(); }
      expect(dead).toBe("1");
      const shown = tmux("capture-pane", "-p", "-S", "-", "-t", `s:${id}`).stdout;
      expect(shown).toContain("error: no terminal");
      expect(exitCodeFromMarker(shown, marker)).toBe(3);
      // When tmux did record a status, it agrees.
      const status = tmux("display-message", "-p", "-t", `s:${id}`, "#{pane_dead_status}").stdout.trim();
      if (status) expect(status).toBe("3");
    } finally {
      tmux("kill-server");
    }
  }, 15_000);

  it("passes the account's login shell, so the installer's PATH line lands in the rc file the user's terminals read", async () => {
    const r = spawnSync("sh", ["-c", unattendedInstallCommand('echo "shell=$SHELL"', "/bin/sh")], { encoding: "utf8", env: { ...process.env, SHELL: "" } });
    expect(r.stdout).toContain("shell=/bin/sh");
    expect(await loginShell(() => "/bin/sh")).toBe("/bin/sh");
    expect(await loginShell(() => "relative/zsh")).toBeUndefined();
    expect(await loginShell(() => join(dir, "no-such-shell"))).toBeUndefined();
    expect(await loginShell(() => { throw new Error("no passwd entry"); })).toBeUndefined();
    expect(unattendedInstallCommand("x", null)).not.toContain("SHELL=");
    expect(unattendedInstallCommand("x", "/bin/zsh")).toMatch(/^SHELL='\/bin\/zsh' /);
  });

  it("the wrapper prints its own verdict after the session's marker, and keeps the install's exit code", () => {
    const marker = installExitMarker();
    expect(marker).toMatch(/^AGEND-INSTALL-EXIT-[0-9a-f]{16}=$/);
    const r = spawnSync("sh", ["-c", unattendedInstallCommand("echo out; exit 4", null, marker)], { encoding: "utf8" });
    expect(r.status).toBe(4);
    expect(r.stdout.trim().split("\n").at(-1)).toBe(`${marker}4`);
    const none = spawnSync("sh", ["-c", unattendedInstallCommand("echo out; exit 4", null)], { encoding: "utf8" });
    expect([none.status, none.stdout]).toEqual([4, "out\n"]);                      // no marker, no line
    expect(() => unattendedInstallCommand("x", null, "bad marker; rm -rf /")).toThrow();
  });

  it("an install command with quotes survives the wrapping intact", () => {
    const r = spawnSync("sh", ["-c", unattendedInstallCommand(`printf '%s\\n' "it's \\"quoted\\""`, null)], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe(`it's "quoted"`);
    expect(UNATTENDED_INSTALL_SCRIPT).toContain("</dev/null");
  });
});

/** A clock the test moves by hand. */
function manualClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let next = 1;
  const clock: InstallStreamClock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = next++; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: id => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    // A stream that keeps re-arming itself at the same instant would spin here for ever: fail instead.
    for (let fired = 0; ; fired++) {
      if (fired > 1000) throw new Error("timer storm: more than 1000 timers fired in one advance");
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > end) break;
      timers.shift(); now = due.at; due.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = end;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { clock, advance, pending: () => timers.length };
}

function sink() {
  const calls: Array<{ op: "send" | "edit"; text: string; id?: string }> = [];
  const s = {
    send: vi.fn(async (text: string) => { calls.push({ op: "send", text }); return { messageId: "m1" }; }),
    edit: vi.fn(async (id: string, text: string) => { calls.push({ op: "edit", text, id }); }),
    warn: vi.fn(),
  };
  return { s, calls };
}

describe("the installer's output, live in the chat (M-2281)", () => {
  it("one message, then edits in place — never faster than the interval, none for an unchanged frame", async () => {
    const { clock, advance } = manualClock();
    const { s, calls } = sink();
    const st = new InstallStream(s, "📦 live", clock, 5000);
    st.update("");                       // an empty window posts nothing
    await advance(10_000);
    expect(calls).toHaveLength(0);
    st.update("downloading\n");
    await advance(0);
    // Posted as its plain status line, the frame put in by an edit (one message kind throughout).
    expect(calls.map(c => c.op)).toEqual(["send", "edit"]);
    expect(calls[0]!.text).toBe("📦 live");
    expect(calls[1]!.text).toBe("📦 live\n```\ndownloading\n```");
    st.update("downloading\n10%\n");
    st.update("downloading\n20%\n");     // two polls within the interval: one edit, with the newest
    await advance(4_999);
    expect(calls).toHaveLength(2);
    await advance(1);
    expect(calls.map(c => c.op)).toEqual(["send", "edit", "edit"]);
    expect(calls[2]!.text).toContain("20%");
    expect(calls[2]!.id).toBe("m1");
    st.update("downloading\n20%\n");     // unchanged: no edit, however long
    await advance(30_000);
    expect(calls).toHaveLength(3);
  });

  it("the final frame goes over the same message, after what is left of the interval", async () => {
    const { clock, advance } = manualClock();
    const { s, calls } = sink();
    const st = new InstallStream(s, "📦 live", clock, 5000);
    st.update("step 1\n");
    await advance(0);
    st.update("step 1\nstep 2\n");
    const done = st.finish("✅ done");
    await advance(4_999);
    expect(calls).toHaveLength(2);       // the pending live edit was dropped; the final one waits out the interval
    await advance(1);
    await done;
    expect(calls.map(c => c.op)).toEqual(["send", "edit", "edit"]);
    expect(calls[2]!.text).toBe("✅ done\n```\nstep 1\nstep 2\n```");
    st.update("late\n");                  // nothing after the end
    await advance(60_000);
    expect(calls).toHaveLength(3);
  });

  it("an install that showed nothing posts no live message at all", async () => {
    const { clock } = manualClock();
    const { s, calls } = sink();
    const st = new InstallStream(s, "📦 live", clock, 5000);
    await st.finish("❌ failed");
    expect(calls).toHaveLength(0);
  });

  it("a refused edit is tried again with the next frame after the interval", async () => {
    const { clock, advance } = manualClock();
    const { s, calls } = sink();
    s.edit.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const st = new InstallStream(s, "📦 live", clock, 5000);
    st.update("a\n"); await advance(0);          // posted; its first edit is refused
    expect(s.warn).toHaveBeenCalledTimes(1);
    expect(calls.map(c => c.op)).toEqual(["send"]);
    st.update("a\nb\n"); await advance(5000);   // tried again after the interval, with the newest frame
    expect(calls.map(c => c.op)).toEqual(["send", "edit"]);
    expect(calls[1]!.text).toContain("b");
    expect(s.send).toHaveBeenCalledTimes(1);     // never a second message
  });

  it("the frame is the bottom of the window: ANSI stripped, secrets masked, bounded, backticks cannot close the block", () => {
    const fakeKey = "sk-" + "a1B2".repeat(12);
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const pane = `\u001b[32mOPENAI_API_KEY=${fakeKey}\u001b[0m\n${lines.join("\n")}\n\`\`\`oops\n`;
    const frame = renderInstallFrame("H", pane);
    expect(frame).not.toContain(fakeKey);
    expect(frame).not.toContain("\u001b");
    const body = frame.split("\n```\n")[1]!.replace(/\n```$/, "");
    expect(body.split("\n")).toHaveLength(INSTALL_STREAM_LINES);
    expect(body.split("\n").at(-1)).toBe("ˋˋˋoops");
    expect(frame.match(/```/g)).toHaveLength(2);
    // The key scrolled off the bottom 15 here; masked even when it is inside the kept lines.
    const near = renderInstallFrame("H", `token: ${fakeKey}\ndone\n`);
    expect(near).not.toContain(fakeKey);
    const wide = renderInstallFrame("H", Array.from({ length: 15 }, () => "x".repeat(400)).join("\n"));
    expect(Buffer.byteLength(wide.split("\n```\n")[1]!, "utf8")).toBeLessThanOrEqual(INSTALL_STREAM_BYTES + 4);
    expect(wide.length).toBeLessThan(2000);   // a Discord message
  });

  it("Telegram's frame is its own <pre>, everything escaped, backticks kept as they are", () => {
    expect(renderInstallFrame("📦 <x>", "a<b & c\n```\n", "html")).toBe("📦 &lt;x&gt;\n<pre>a&lt;b &amp; c\n```</pre>");
    expect(renderInstallFrame("📦 <x>", "", "html")).toBe("📦 &lt;x&gt;");
  });

  it("a Telegram stream posts the plain status line, then the <pre> frame by edit", async () => {
    const { clock, advance } = manualClock();
    const { s, calls } = sink();
    const st = new InstallStream(s, "📦 live <1>", clock, 5000, "html");
    st.update("x > y\n"); await advance(0);
    expect(calls).toEqual([{ op: "send", text: "📦 live <1>" }, { op: "edit", text: "📦 live &lt;1&gt;\n<pre>x &gt; y</pre>", id: "m1" }]);
  });

  it("tmux's dead-pane line and the blank rows above it are not the installer's output", () => {
    const pane = `downloading\ninstalled\n${"\n".repeat(30)}Pane is dead (status 0, Tue Nov  3 07:42:59 2026)\n`;
    expect(renderInstallFrame("H", pane)).toBe("H\n```\ndownloading\ninstalled\n```");
  });

  it("the chat text never points at a page that does not show the install", () => {
    for (const key of ["install.started", "install.verify_failed", "install.timeout"]) {
      expect(t(key, "codex", "codex")).not.toMatch(/View/);
    }
  });
});

describe("LoginSession hands its captures to onProgress (M-2281)", () => {
  function fakeTmux(panes: string[], alive: boolean[]): LoginTmux {
    let i = 0, j = 0;
    return {
      createWindow: async () => "@1",
      setRemainOnExit: async () => {},
      capturePaneJoined: async () => panes[Math.min(i++, panes.length - 1)]!,
      getPaneStatus: async () => ({ alive: alive[Math.min(j++, alive.length - 1)]!, exitCode: 0 }),
      killWindow: async () => {},
      killWindowConfirmed: async () => true,
    };
  }
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;

  it("every poll's capture, the last one before the verdict, none after", async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const done = vi.fn();
      const s = new LoginSession({ backend: "codex", command: "x", successPattern: /$^/, timeoutMs: 60_000 },
        fakeTmux(["a", "a\nb", "a\nb\nfinished"], [true, true, false]), { onDone: done, onProgress: p => seen.push(p) }, logger, 10);
      await s.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(seen).toEqual(["a", "a\nb", "a\nb\nfinished"]);
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failure's detail quotes the CLI's last lines, not tmux's blank rows and dead-pane line", async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      const tmux = fakeTmux([`Checking\nerror: no terminal\n${"\n".repeat(30)}Pane is dead (status 1, Tue Nov  3 07:45:08 2026)`], [false]);
      tmux.getPaneStatus = async () => ({ alive: false, exitCode: 1 });
      const s = new LoginSession({ backend: "kiro-cli", command: "x", successPattern: /$^/, timeoutMs: 60_000 }, tmux, { onDone: done }, logger, 10);
      await s.start();
      await vi.advanceTimersByTimeAsync(50);
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ ok: false, detail: "CLI exited with code 1 — Checking / error: no terminal" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a capture that returns after a cancel is not handed on", async () => {
    let release: (pane: string) => void = () => {};
    const tmux = fakeTmux(["x"], [true]);
    tmux.capturePaneJoined = () => new Promise<string>(r => { release = r; });
    const seen: string[] = [];
    vi.useFakeTimers();
    try {
      const s = new LoginSession({ backend: "codex", command: "x", successPattern: /$^/, timeoutMs: 60_000 }, tmux, { onDone: () => {}, onProgress: p => seen.push(p) }, logger, 10);
      await s.start();
      await vi.advanceTimersByTimeAsync(15);   // the poll is waiting on its capture
      await s.cancel();
      release("late frame");
      await vi.advanceTimersByTimeAsync(50);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tmux recorded no exit code (its SIGCHLD missed): the wrapper's verdict line decides, read after the pane died, never shown", async () => {
    const marker = installExitMarker();
    for (const [code, ok] of [[0, true], [3, false]] as const) {
      vi.useFakeTimers();
      try {
        const done = vi.fn(), seen: string[] = [];
        // The first capture is from before the end (no verdict line yet); the pane is then seen dead with no code.
        const tmux = fakeTmux(["Installing…", `Installing…\nerror: no terminal\n\n${marker}${code}\n\n\nPane is dead`], [true, false]);
        tmux.getPaneStatus = async () => ({ alive: false });
        const s = new LoginSession({ backend: "codex", command: "x", successPattern: /$^/, timeoutMs: 60_000, exitMarker: marker },
          tmux, { onDone: done, onProgress: p => seen.push(p) }, logger, 10);
        await s.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(done).toHaveBeenCalledWith(expect.objectContaining(ok
          ? { ok: true, detail: "clean exit" }
          : { ok: false, detail: "CLI exited with code 3 — Installing… / error: no terminal" }));
        expect(seen.some((p) => p.includes(marker))).toBe(false);
        expect(seen.at(-1)).toContain("error: no terminal");                          // the final frame is the late capture
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("tmux recorded the exit code (the common path): a poll's capture that already holds the verdict line never shows it", async () => {
    vi.useFakeTimers();
    try {
      const marker = installExitMarker();
      const done = vi.fn(), seen: string[] = [];
      // The verdict line is in the captures while the pane is still alive and when it is seen dead; tmux has the
      // code (the default fake status: exitCode 0), so no late capture is taken and every frame comes from a poll.
      const tmux = fakeTmux(["Installing…", `Installing…\ndone!\n${marker}0`, `Installing…\ndone!\n${marker}0\n\nPane is dead`], [true, true, false]);
      const s = new LoginSession({ backend: "codex", command: "x", successPattern: /$^/, timeoutMs: 60_000, exitMarker: marker },
        tmux, { onDone: done, onProgress: p => seen.push(p) }, logger, 10);
      await s.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ ok: true, detail: "clean exit" }));
      expect(seen).toHaveLength(3);
      expect(seen.slice(1).every((p) => p.includes("done!"))).toBe(true);
      expect(seen.some((p) => p.includes(marker))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only the session's own marker counts: a line the installer prints with another marker is just output", async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      const forged = installExitMarker(), mine = installExitMarker();
      const tmux = fakeTmux([`${forged}0\nerror: failed`], [false]);
      tmux.getPaneStatus = async () => ({ alive: false });
      const s = new LoginSession({ backend: "codex", command: "x", successPattern: /$^/, timeoutMs: 60_000, exitMarker: mine }, tmux, { onDone: done }, logger, 10);
      await s.start();
      await vi.advanceTimersByTimeAsync(50);
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
      expect(exitCodeFromMarker(`${forged}0`, mine)).toBeUndefined();
      expect(exitCodeFromMarker(`${mine}0\n${mine}7`, mine)).toBe(7);                 // the last one
      expect(exitCodeFromMarker(`${mine}0x`, mine)).toBeUndefined();
      expect(withoutExitMarker(`a\n${mine}0\nb`, mine)).toBe("a\nb");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a consumer that throws does not stop the session", async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      const s = new LoginSession({ backend: "codex", command: "x", successPattern: /$^/, timeoutMs: 60_000 },
        fakeTmux(["a"], [true, false]), { onDone: done, onProgress: () => { throw new Error("boom"); } }, logger, 10);
      await s.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    } finally {
      vi.useRealTimers();
    }
  });
});

// The wrapper is plain POSIX sh: dash (Debian/Ubuntu's sh) must parse it too.
it.skipIf(spawnSync("dash", ["-c", "true"]).status !== 0)("dash parses and runs the wrapper", () => {
  const f = join(dir, "w.sh");
  writeFileSync(f, unattendedInstallCommand("echo ok", null));
  chmodSync(f, 0o755);
  const r = spawnSync("dash", [f], { encoding: "utf8" });
  expect(r.stdout).toContain("ok");
  expect(r.status).toBe(0);
});
