import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxManager } from "../src/tmux-manager.js";

/**
 * sol (PR-B round 5, B1): a createWindow() whose exec timed out may still have
 * created the window while its id was never learned. killWindowConfirmed()
 * must find it by NAME, remove it, and confirm absence; it never reports a
 * clean result on a guess.
 */
function have(bin: string): boolean {
  try { execFileSync(bin, ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
}
const SOCK = `agtkw${process.pid}`;
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" });

const ORIGINAL_PATH = process.env.PATH ?? "";
afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  try { tmux("kill-server"); } catch { /* gone */ }
  TmuxManager.setSocketName(null);
});

/** Put a `tmux` wrapper first in PATH that fails (exit 75) for the given subcommand and execs the real tmux otherwise. */
function failingTmux(subcommand: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-tmuxwrap-"));
  writeFileSync(join(dir, "tmux"), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = ${subcommand} ]; then exit 75; fi; done\nPATH="${ORIGINAL_PATH}" exec tmux "$@"\n`);
  chmodSync(join(dir, "tmux"), 0o755);
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  return dir;
}

describe.skipIf(!have("tmux"))("TmuxManager.killWindowConfirmed", () => {
  it("kills a window known only by name and confirms it is gone", async () => {
    TmuxManager.setSocketName(SOCK);
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "s", "-x", "80", "-y", "24", "sleep 100");
    // `-a` (insert after current) as production createWindow does: a bare
    // `new-window -t s` right after a fresh `new-session -d` races tmux's
    // window indexing and fails with "index 0 in use" about 40% of the time.
    tmux("new-window", "-a", "-t", "s", "-n", "agend-login-codex", "sleep 100");   // the id is never captured
    const tm = new TmuxManager("s", "");
    (tm as unknown as { pendingWindowName: string | null }).pendingWindowName = "agend-login-codex";
    expect(tmux("list-windows", "-t", "s", "-F", "#{window_name}")).toContain("agend-login-codex");
    expect(await tm.killWindowConfirmed()).toBe(true);
    expect(tmux("list-windows", "-t", "s", "-F", "#{window_name}")).not.toContain("agend-login-codex");
  });

  it("returns true for a window that never existed and false when tmux cannot be asked", async () => {
    TmuxManager.setSocketName(SOCK);
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "s", "sleep 100");
    const tm = new TmuxManager("s", "");
    (tm as unknown as { pendingWindowName: string | null }).pendingWindowName = "agend-login-never";
    expect(await tm.killWindowConfirmed()).toBe(true);
    tmux("kill-server");
    // No server at all: positively no window either.
    expect(await tm.killWindowConfirmed()).toBe(true);
    // Unknown (socket exists but tmux cannot answer) is exercised at the unit level via the LoginTmux seam.
  });

  it("B1 (round 7): duplicates by name are all killed (in parallel) and confirmed", async () => {
    TmuxManager.setSocketName(SOCK);
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "s", "sleep 100");
    for (let i = 0; i < 3; i++) tmux("new-window", "-a", "-t", "s", "-n", "agend-login-dup", "sleep 100");
    const tm = new TmuxManager("s", "");
    (tm as unknown as { pendingWindowName: string | null }).pendingWindowName = "agend-login-dup";
    expect(tmux("list-windows", "-t", "s", "-F", "#{window_name}").split("\n").filter(n => n === "agend-login-dup")).toHaveLength(3);
    expect(await tm.killWindowConfirmed()).toBe(true);
    expect(tmux("list-windows", "-t", "s", "-F", "#{window_name}")).not.toContain("agend-login-dup");
  });

  it("B1 (round 7): createWindow fails CLOSED when the duplicate check cannot run — no window is created", async () => {
    TmuxManager.setSocketName(SOCK);
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "s", "sleep 100");
    const dir = failingTmux("list-windows");
    try {
      const tm = new TmuxManager("s", "");
      await expect(tm.createWindow("sleep 100", "/tmp", "agend-login-x")).rejects.toThrow();
    } finally {
      process.env.PATH = ORIGINAL_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(tmux("list-windows", "-t", "s", "-F", "#{window_name}")).not.toContain("agend-login-x");
  });

  it("B1 (round 7): ensureSession rejects when has-session cannot be determined instead of creating a session on a guess", async () => {
    TmuxManager.setSocketName(SOCK);
    const dir = failingTmux("has-session");
    try {
      await expect(TmuxManager.ensureSession("s2")).rejects.toThrow(/could not be determined/);
    } finally {
      process.env.PATH = ORIGINAL_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await TmuxManager.sessionExistsStrict("s2")).toBe(false);         // positively absent (no server) → false, no throw
  });

  it("by id: kills and confirms, and is idempotent", async () => {
    TmuxManager.setSocketName(SOCK);
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "s", "sleep 100");
    const tm = new TmuxManager("s", "");
    const id = await tm.createWindow("sleep 100", "/tmp", "agend-login-grok");
    expect(id).toMatch(/^@\d+$/);
    expect(await tm.killWindowConfirmed()).toBe(true);
    expect(await tm.killWindowConfirmed()).toBe(true);
    expect(tmux("list-windows", "-t", "s", "-F", "#{window_id}")).not.toContain(id);
  });
});
