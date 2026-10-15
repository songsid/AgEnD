/**
 * #1874 follow-up: the validator's warnings (settings fleet.yaml has that AgEnD ignores, e.g. `web.access`) show where a
 * hand-editor looks — `agend doctor` and daemon.log at fleet start — not only in `agend validate`. Only warnings the
 * validator already produces; nothing forks (every doctor dependency is stubbed).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDoctorReport } from "../src/doctor.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { loadRawFleetConfig } from "../src/config.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const WITH_TYPO = "channel:\n  type: discord\n  bot_token_env: T\n  group_id: G\n  access:\n    mode: locked\n    allowed_users: []\nweb:\n  access:\n    allowed_users: ['1']\n  log_tab: true\n  view_acess: session\ninstances:\n  general:\n    general_topic: true\n    working_directory: /tmp\n";
const CLEAN = "channel:\n  type: discord\n  bot_token_env: T\n  group_id: G\n  access:\n    mode: locked\n    allowed_users: ['1']\nweb:\n  log_tab: true\ninstances:\n  general:\n    general_topic: true\n    working_directory: /tmp\n";

function home(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-1874-warn-")); dirs.push(dir);
  writeFileSync(join(dir, "fleet.yaml"), yaml);
  return dir;
}
const stubbed = {
  env: {}, platform: "linux" as const,
  run: () => ({ status: 1, stdout: "", stderr: "not found", pid: 1, signal: null, output: [], error: undefined }) as never,
  processAlive: () => false, connectSocket: async () => false,
  networkFamily: () => ({ autoSelectFamily: true, attemptTimeoutMs: 250 }),
  collectResources: async () => ({ disk: [], memory: null }) as never,
  fetchFleetHealth: async () => ({}),
};
const service = { installed: false, path: "", manager: "none", enabled: false, active: false } as never;
const configRows = (checks: Array<{ section: string; status: string; label: string; detail: string }>) =>
  checks.filter(c => c.section === "Fleet" && c.label === "fleet.yaml");

describe("agend doctor shows the validator's warnings", () => {
  it("one warn row per warning: the user's case — an empty locked list, web.access (where fleet admins go), a typo", async () => {
    const report = await collectDoctorReport(home(WITH_TYPO), service, stubbed);
    expect(configRows(report.checks)).toEqual([
      { section: "Fleet", status: "warn", label: "fleet.yaml", detail: "channel.access.allowed_users: locked access has no allowed users — add an administrator to avoid lockout" },
      { section: "Fleet", status: "warn", label: "fleet.yaml", detail: "web.access: web.access is not a setting; fleet admins come from channel(s).access.allowed_users — ignored" },
      { section: "Fleet", status: "warn", label: "fleet.yaml", detail: expect.stringMatching(/^web\.view_acess: unknown key \(known: /) },
    ]);
  });
  it("exactly the validator's warnings — the same list, nothing added", async () => {
    const dir = home(WITH_TYPO);
    const report = await collectDoctorReport(dir, service, stubbed);
    const expected = validateFleetConfig(loadRawFleetConfig(join(dir, "fleet.yaml"))).warnings.map(w => `${w.path}: ${w.message}`);
    expect(configRows(report.checks).map(c => c.detail)).toEqual(expected);
  });
  it("a clean fleet.yaml: no such row", async () => {
    expect(configRows((await collectDoctorReport(home(CLEAN), service, stubbed)).checks)).toEqual([]);
  });
});

describe("fleet start logs the validator's warnings once, at warn level", () => {
  it("each warning one daemon.log line; a clean file none", () => {
    for (const [yaml, want] of [[WITH_TYPO, 3], [CLEAN, 0]] as const) {
      const dir = home(yaml);
      const fm = new FleetManager(dir) as any;
      const warn = vi.fn();
      fm.logger = { info() {}, debug() {}, error() {}, trace() {}, fatal() {}, warn, child: () => fm.logger };
      fm.loadConfig(join(dir, "fleet.yaml"));
      fm.logConfigWarningsAtStartup();
      const lines = warn.mock.calls.map(c => c[1]).filter((m: string) => m.startsWith("fleet.yaml: "));
      expect(lines.length, yaml === CLEAN ? "clean" : "typo").toBe(want);
      if (want) expect(lines[1]).toBe("fleet.yaml: web.access: web.access is not a setting; fleet admins come from channel(s).access.allowed_users — ignored");
    }
  });
  it("startAll calls it right after loading the config (once per start)", async () => {
    const src = (await import("node:fs")).readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8");
    expect(src).toMatch(/const fleet = this\.loadConfig\(configPath\);\n\s+this\.slimFleetConfigAtStartup\(\);\n\s+this\.logConfigWarningsAtStartup\(\);/);
    expect(src.match(/this\.logConfigWarningsAtStartup\(\)/g)?.length).toBe(1);
  });
});
