/**
 * The login-shell lookup (`bash -lc "command -v …"`, run after a `/login` install) must never hold the fleet's event
 * loop. It used to be spawnSync with a 10 s timeout — but spawnSync returns only once the child's stdout/stderr pipes
 * close, and a profile that starts something in the background (an agent, a keychain helper) hands that something
 * the pipe: bash is done at once, yet spawnSync sat out its whole timeout (measured below), holding the loop for it.
 *
 * Real bash, a throwaway HOME, real background children.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOnLoginShell } from "../src/login-shell.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agend-login-shell-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const env = () => ({ ...process.env, HOME: home });
const profile = (text: string) => writeFileSync(join(home, ".bash_profile"), text);

/** A pid that is gone, or only a zombie waiting for its reaper: either way it holds nothing and runs nothing. */
function gone(pid: number): boolean {
  if (process.platform !== "linux") { try { process.kill(pid, 0); return false; } catch { return true; } }
  const stat = join("/proc", String(pid), "stat");
  if (!existsSync(stat)) return true;
  try { return readFileSync(stat, "utf8").split(") ")[1]?.startsWith("Z") ?? true; } catch { return true; }
}
async function eventually(check: () => boolean, ms = 2_000): Promise<boolean> {
  const until = performance.now() + ms;
  while (performance.now() < until) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); }
  return check();
}

describe("a profile that backgrounds a child holding the shell's output", () => {
  it("the old spawnSync shape holds the loop for its whole timeout, though bash itself is done at once", () => {
    profile(`sleep 20 &\n`);
    const started = performance.now();
    const r = spawnSync("bash", ["-lc", "command -v sh"], { timeout: 1_500, stdio: "pipe", encoding: "utf8", env: env() });
    const elapsed = performance.now() - started;
    expect(String(r.stdout).trim()).toMatch(/\/sh$/);
    // Production used 10 s: ten seconds with no IPC, no delivery and no watchdog ping, on every such lookup.
    expect(elapsed, "held until the timeout, by the background child's pipe").toBeGreaterThan(1_400);
  }, 10_000);

  it("runOnLoginShell answers when the shell exits, keeps the loop turning, and takes the holder down", async () => {
    profile(`sleep 20 &\necho $! > "$HOME/holder.pid"\n`);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    const started = performance.now();
    let r;
    try { r = await runOnLoginShell("command -v sh", { env: env() }); } finally { clearInterval(timer); }
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(ticks).toBeGreaterThan(0);
    expect(r).toMatchObject({ status: 0, timedOut: false });
    expect(r!.stdout.trim()).toMatch(/\/sh$/);
    const holder = Number(readFileSync(join(home, "holder.pid"), "utf8"));
    expect(await eventually(() => gone(holder)), "the pipe holder was killed with the lookup's group").toBe(true);
  }, 10_000);
});

describe("a login shell that never finishes", () => {
  it("is cut off at the deadline, with its whole process group", async () => {
    profile(`sleep 20 &\necho $! > "$HOME/child.pid"\nwait\n`);
    const started = performance.now();
    const r = await runOnLoginShell("command -v sh", { env: env(), timeoutMs: 500 });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(r).toMatchObject({ status: null, timedOut: true });
    const child = Number(readFileSync(join(home, "child.pid"), "utf8"));
    expect(await eventually(() => gone(child))).toBe(true);
  }, 10_000);
});

describe("output is bounded, as spawnSync's maxBuffer bounded it (#1877 review)", () => {
  it("more than the budget ends the lookup: no answer, never a truncated path passed off as one", async () => {
    profile("");
    const r = await runOnLoginShell("head -c 2097152 /dev/zero; printf '\\n/usr/bin/sh\\n'", { env: env() });
    expect(r).toEqual({ status: null, stdout: "", timedOut: false, overflow: true });
  }, 10_000);

  it("the budget's edge: exactly at it is an answer, one byte over is not — and the overflow takes the group down", async () => {
    profile(`sleep 20 &\necho $! > "$HOME/holder.pid"\n`);
    expect(await runOnLoginShell("printf abcd", { env: env(), maxOutputBytes: 4 })).toMatchObject({ status: 0, stdout: "abcd", overflow: false });
    const over = await runOnLoginShell("printf abcde; sleep 20", { env: env(), maxOutputBytes: 4 });
    expect(over).toMatchObject({ status: null, overflow: true, timedOut: false });
    const holder = Number(readFileSync(join(home, "holder.pid"), "utf8"));
    expect(await eventually(() => gone(holder))).toBe(true);
  }, 10_000);
});

describe("what the lookup does not touch", () => {
  it("a background child that let go of the shell's output is left running, as before", async () => {
    profile(`sleep 20 >/dev/null 2>&1 &\necho $! > "$HOME/quiet.pid"\n`);
    const r = await runOnLoginShell("command -v sh", { env: env() });
    const quiet = Number(readFileSync(join(home, "quiet.pid"), "utf8"));
    try {
      expect(r).toMatchObject({ status: 0, overflow: false });
      expect(gone(quiet), "not this lookup's to stop: it holds nothing of ours").toBe(false);
    } finally { try { process.kill(quiet, "SIGKILL"); } catch { /* gone */ } }
  });
});

describe("an ordinary login shell", () => {
  it("returns all of its output and its exit status", async () => {
    profile("");
    const r = await runOnLoginShell("seq 1 20000; exit 3", { env: env() });
    expect(r.status).toBe(3);
    const lines = r.stdout.trim().split("\n");
    expect([lines.length, lines[0], lines.at(-1)]).toEqual([20000, "1", "20000"]);
  });

  it("a shell that cannot start is an answer (null), never a throw", async () => {
    const r = await runOnLoginShell("true", { shell: join(home, "no-such-shell") });
    expect(r).toMatchObject({ status: null, timedOut: false });
  });
});
