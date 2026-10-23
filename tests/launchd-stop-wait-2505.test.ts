import { describe, expect, it, vi } from "vitest";

/**
 * #2505: on macOS `launchctl bootout` returns while launchd is still unloading the job (the fleet SIGTERMed, shutting
 * down), and `agend stop` said "Service stopped." then — an `agend start` right after failed with "Bootstrap failed: 5:
 * Input/output error". stopService now returns only once `launchctl print` says the job is gone (113), bounded at 30 s.
 */
vi.mock("node:os", async importOriginal => ({ ...(await importOriginal<typeof import("node:os")>()), platform: () => "darwin" }));

const { stopService, serviceStopReport, LAUNCHD_STOP_CONFIRM_MS } = await import("../src/service-installer.js");
const { setLocale } = await import("../src/locale.js");
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");

function launchctl(bootout: number | null | "timeout", prints: Array<{ status: number | null; signal?: NodeJS.Signals | null }>) {
  const calls: string[] = [];
  let clock = 0, i = 0;
  const deps = {
    run: (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "bootout") return bootout === "timeout" ? { status: null, signal: "SIGTERM" as NodeJS.Signals } : { status: bootout, signal: null };
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
    expect(stopService(l.deps)).toBe("stopped");
    expect(l.calls[0]).toMatch(/^launchctl bootout gui\/\d+\/com\.agend\.fleet$/);
    expect(l.prints()).toBe(121);
    expect(l.clock()).toBe(12_000);
  });

  it("already gone: one print, no wait", () => {
    const l = launchctl(0, [{ status: 113 }]);
    expect(stopService(l.deps)).toBe("stopped");
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
    expect(stopService(l.deps)).toBe("stopped");
  });

  it("a bootout launchd refuses (not loaded): false, as before — the caller falls back to the pid", () => {
    const l = launchctl(3, [{ status: 113 }]);
    expect(stopService(l.deps)).toBe(false);
    expect(l.prints()).toBe(0);
  });

  it("a bootout killed by its own timeout (a launchd that blocks until the job exits) goes on to confirm, never to the pid fallback", () => {
    const l = launchctl("timeout", [{ status: 0 }, { status: 113 }]);
    expect(stopService(l.deps)).toBe("stopped");
    expect(l.prints()).toBe(2);
    expect(stopService(launchctl("timeout", [{ status: 0 }]).deps)).toBe("unloading");
  });
});

describe("#2505 follow-up: what agend stop does with each result", () => {
  it("stopped: says so, exit 0; unloading: never \"Service stopped.\", exit 1, localized; a refusal falls back to the pid", () => {
    expect(serviceStopReport("stopped")).toEqual({ kind: "stopped", line: "Service stopped.", exitCode: 0 });
    setLocale("en");
    const en = serviceStopReport("unloading");
    expect(en).toMatchObject({ kind: "unloading", exitCode: 1 });
    expect(en.line).toMatch(/^Stop requested, but launchd is still unloading the fleet after 30 s; an `agend start` now would fail\./);
    expect(en.line).not.toContain("Service stopped");
    setLocale("zh-TW");
    expect(serviceStopReport("unloading").line).toContain("launchd 仍在卸載 fleet");
    setLocale("en");
    expect(serviceStopReport(false)).toEqual({ kind: "fallback", exitCode: 0 });
  });

  it("the CLI's stop action reports through serviceStopReport and never tests the result's truth", () => {
    const cli = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
    // `agend stop` (the top-level command, after `fleet stop`): up to `agend start`.
    const at = cli.indexOf('program\n  .command("stop")');
    expect(at).toBeGreaterThan(0);
    const action = cli.slice(at, cli.indexOf('.command("start")', at));
    expect(action).toContain("const report = serviceStopReport(stopService());");
    expect(action).toMatch(/if \(report\.kind !== "fallback"\) \{\n\s+console\.log\(report\.line\);\n\s+if \(report\.exitCode\) process\.exitCode = report\.exitCode;/);
    expect(action).not.toMatch(/if \(stopService\(\)\)|if \(stopped\)/);
  });
});
