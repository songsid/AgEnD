/**
 * #2243: a read error on the login shell's stdout pipe ends that lookup as "not found" and stops the shell's group,
 * never escaping as an uncaught EventEmitter error that stops the fleet.
 */
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as ChildProcess[]);
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: vi.fn((...args: Parameters<typeof real.spawn>) => { const c = real.spawn(...args); spawned.push(c); return c; }) };
});

const { runOnLoginShell } = await import("../src/login-shell.js");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

afterEach(() => {
  for (const c of spawned.splice(0)) if (c.pid !== undefined) try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ }
});

describe("#2243 the login shell's stdout pipe", () => {
  it.skipIf(process.platform === "win32")("a read error ends the lookup with no answer, kills the shell, and nothing goes uncaught", async () => {
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      const pending = runOnLoginShell("printf /usr/bin/sh; sleep 30", { shell: "sh", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 20_000 });
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      const child = spawned[0];
      await new Promise(r => setTimeout(r, 50));
      child.stdout!.destroy(Object.assign(new Error("read EIO"), { code: "EIO" }));
      const started = performance.now();
      const r = await pending;
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(r).toEqual({ status: null, stdout: "", timedOut: false, overflow: false });
      await vi.waitFor(() => expect(alive(child.pid!)).toBe(false));
      await new Promise(r => setImmediate(r));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
    }
  });
});
