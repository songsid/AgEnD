import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
import { requestCpuProfile } from "../src/profile-control.js";
// Exact production callback, without importing the self-executing CLI or starting a fleet.
function rig(client?: (directory: string, seconds: string) => Promise<unknown>) {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const begin = source.indexOf("  .action(async (seconds: string) => {", source.indexOf('program.command("profile")'));
  const end = source.indexOf("\n  });\n\nfleet", begin);
  if (begin < 0 || end < 0) throw Error("Profile CLI callback moved");
  const actionSource = source.slice(begin + "  .action(".length, end) + "\n  }";
  const clientCall = vi.fn(client ?? (async () => ({ path: "/private/cpu.cpuprofile", bytes: 100 })));
  const process = { exitCode: 0 }, console = { log: vi.fn(), error: vi.fn() };
  const context = createContext({ process, console, DATA_DIR: "/unused/private/profile-test", requestCpuProfile: clientCall });
  runInContext(ts.transpileModule(`const action = ${actionSource}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, context);
  return { action: runInContext("action", context) as (seconds: string) => Promise<void>, clientCall, process, console };
}
afterEach(() => vi.restoreAllMocks());
describe("agend profile real CLI callback", () => {
  it("prints the saved path without starting/restarting a fleet", async () => {
    const h = rig(); await h.action("60"); expect(h.clientCall).toHaveBeenCalledExactlyOnceWith("/unused/private/profile-test", "60");
    expect(h.console.log).toHaveBeenCalledWith("/private/cpu.cpuprofile"); expect(h.process.exitCode).toBe(0);
  });
  it("busy and unavailable errors are visible and fail the command", async () => {
    for (const message of ["A CPU profile is already recording (45s remaining)", "Running fleet profile control unavailable"]) {
      const h = rig(async () => { throw Error(message); }); await h.action("60");
      expect(h.console.error).toHaveBeenCalledWith(message); expect(h.console.log).not.toHaveBeenCalled(); expect(h.process.exitCode).toBe(1);
    }
  });
  it("agent invocation uses the real client veto before any filesystem/socket access", async () => {
    const h = rig((dir, seconds) => requestCpuProfile(dir, seconds, { AGEND_INSTANCE_NAME: "worker" }));
    await h.action("60"); expect(h.console.error.mock.calls[0][0]).toContain("operator"); expect(h.process.exitCode).toBe(1);
  });
});
