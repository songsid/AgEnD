import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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

afterEach(() => {
  try { tmux("kill-server"); } catch { /* gone */ }
  TmuxManager.setSocketName(null);
});

describe.skipIf(!have("tmux"))("TmuxManager.killWindowConfirmed", () => {
  it("kills a window known only by name and confirms it is gone", async () => {
    TmuxManager.setSocketName(SOCK);
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "s", "-x", "80", "-y", "24", "sleep 100");
    tmux("new-window", "-t", "s", "-n", "agend-login-codex", "sleep 100");   // the id is never captured
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
