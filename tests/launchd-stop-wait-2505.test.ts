import { describe, expect, it, vi } from "vitest";

/**
 * #2505: on macOS `launchctl bootout` returns while launchd is still unloading the job (the fleet SIGTERMed, shutting
 * down), and `agend stop` said "Service stopped." then — an `agend start` right after failed with "Bootstrap failed: 5:
 * Input/output error". stopService now returns only once `launchctl print` says the job is gone (113), bounded at 30 s.
 */
vi.mock("node:os", async importOriginal => ({ ...(await importOriginal<typeof import("node:os")>()), platform: () => "darwin" }));

const { stopService, LAUNCHD_STOP_CONFIRM_MS } = await import("../src/service-installer.js");

function launchctl(bootout: number | null, prints: Array<{ status: number | null; signal?: NodeJS.Signals | null }>) {
  const calls: string[] = [];
  let clock = 0, i = 0;
  const deps = {
    run: (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "bootout") return { status: bootout, signal: null };
      if (args[0] === "print") { const p = prints[Math.min(i++, prints.length - 1)]!; return { status: p.status, signal: p.signal ?? null }; }
      return { status: 0, signal: null };
    },
    sleep: (ms: number) => { clock += ms; },
    now: () => clock,
  };
  return { deps, calls, clock: () => clock, prints: () => calls.filter(c => c.startsWith("launchctl print")).length };
}

describe("#2505 agend stop on launchd waits until the job is unloaded", () => {
  it("returns stopped only after launchd confirms the job gone, however long the fleet's own stop takes", () => {
    // SIGTERMed for ~12 s (a graceful fleet stop), then gone.
    const l = launchctl(0, [...Array(120).fill({ status: 0 }), { status: 113 }]);
    expect(stopService(l.deps)).toBe(true);
    expect(l.calls[0]).toMatch(/^launchctl bootout gui\/\d+\/com\.agend\.fleet$/);
    expect(l.prints()).toBe(121);
    expect(l.clock()).toBe(12_000);
  });

  it("already gone: one print, no wait", () => {
    const l = launchctl(0, [{ status: 113 }]);
    expect(stopService(l.deps)).toBe(true);
    expect(l.clock()).toBe(0);
  });

  it.each([
    ["the job stays loaded", [{ status: 0 }]],
    ["launchctl print times out", [{ status: null, signal: "SIGTERM" as NodeJS.Signals }]],
    ["launchctl print fails another way", [{ status: 5 }]],
  ] as const)("not confirmed within the bound (%s): \"unloading\", never \"stopped\"", (_n, prints) => {
    const l = launchctl(0, [...prints]);
    expect(stopService(l.deps)).toBe("unloading");
    expect(l.clock()).toBeGreaterThanOrEqual(LAUNCHD_STOP_CONFIRM_MS);
    expect(l.clock()).toBeLessThan(LAUNCHD_STOP_CONFIRM_MS + 1_000);
  });

  it("the bound covers launchd's default 20 s ExitTimeOut (AgEnD's plist sets none)", () => {
    expect(LAUNCHD_STOP_CONFIRM_MS).toBeGreaterThan(20_000);
    const l = launchctl(0, [...Array(220).fill({ status: 0 }), { status: 113 }]); // SIGKILLed at 20 s, gone at 22 s
    expect(stopService(l.deps)).toBe(true);
  });

  it("a bootout launchd refuses (not loaded): false, as before — the caller falls back to the pid", () => {
    const l = launchctl(3, [{ status: 113 }]);
    expect(stopService(l.deps)).toBe(false);
    expect(l.prints()).toBe(0);
  });
});
