/** All manager commands and signals are strict inert spies; only scratch plist/PID files are real. */
import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), platform: () => "darwin" }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawnSync: vi.fn((command: string, args: string[]) => {
    expect(command).toBe("launchctl"); state.calls.push([command, ...args].join(" "));
    expect(["bootout", "print", "bootstrap", "enable", "print-disabled"]).toContain(args[0]);
    return { status: args[0] === "print" ? 113 : 0, signal: null, stdout: "", stderr: "" };
  }),
  execSync: vi.fn(() => { throw Error("native shell forbidden"); }), execFileSync: vi.fn(() => { throw Error("native command forbidden"); }),
}));
import { activateService, inspectService, renderLaunchdPlist } from "../src/service-installer.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); state.calls.length = 0; for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function setup() {
  const home = mkdtempSync(join(tmpdir(), "agend-hub-activation-")); roots.push(home); vi.stubEnv("HOME", home); vi.spyOn(process, "getuid").mockReturnValue(501);
  const folder = join(home, "Library", "LaunchAgents"), plist = join(folder, "com.agend.fleet.plist"), pid = join(home, "fleet.pid"); mkdirSync(folder, { recursive: true });
  writeFileSync(plist, renderLaunchdPlist({ label: "com.agend.fleet", execPath: "/opt/agend/dist/cli.js", nodePath: "/opt/node/bin/node",
    workingDirectory: home, logPath: join(home, "fleet.log"), agendHome: home, path: "/usr/bin:/bin", launchdSessionType: "Background" }));
  return { home, plist, pid };
}
it("activates in user/<uid>, waiting for manager absence while preserving a prior PID record without signals", () => {
  const r = setup(); writeFileSync(r.pid, "42\n");
  const signal = vi.spyOn(process, "kill").mockImplementation(() => { throw Error("no PID signal authorized in this fixture"); });
  activateService(r.plist, r.pid, { preservePidFile: true });
  expect(signal).not.toHaveBeenCalled(); expect(existsSync(r.pid)).toBe(true); expect(readFileSync(r.pid, "utf8")).toBe("42\n");
  expect(state.calls).toEqual(["launchctl bootout user/501/com.agend.fleet", "launchctl print user/501/com.agend.fleet",
    `launchctl bootstrap user/501 ${r.plist}`, "launchctl enable user/501/com.agend.fleet"]);
});
it("inspects the same background domain, with no GUI job query", () => {
  setup(); expect(inspectService().active).toBe(false);
  expect(state.calls).toEqual(["launchctl print user/501/com.agend.fleet", "launchctl print-disabled user/501"]);
});
