import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function cli(args: string[], tz = "UTC", config?: string) {
  const home = mkdtempSync(join(tmpdir(), "agend-setup-3645-")); dirs.push(home);
  if (config !== undefined) writeFileSync(join(home, "fleet.yaml"), config);
  mkdirSync(join(home, "bin"));
  return spawnSync(process.execPath, ["--require", join(process.cwd(), "tests/helpers/health-process-stub.cjs"), "--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, HOME: home, AGEND_HOME: home, TZ: tz, NOTIFY_SOCKET: "", PATH: join(home, "bin") },
  });
}
describe("#3645 read-only CLI before setup", () => {
  for (const [tz, hint] of [["UTC", "AgEnD isn't set up yet: run agend setup."], ["Asia/Taipei", "AgEnD 尚未設定：請執行 agend setup。"]]) {
    it.each([["ls"], ["status"], ["web", "--code"], ["fleet", "status"]])(`${tz} %j gives one setup hint, not a stack`, (...args) => {
      const r = cli(args, tz);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr.trim()).toBe(hint);
    });
  }
  it.each([["--version"], ["--help"], ["setup", "--help"]])("%j remains available before setup", (...args) => {
    const r = cli(args);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toBe("");
    expect(r.stderr).toBe("");
  });
  it("an existing empty fleet still lists successfully", () => {
    const r = cli(["ls", "--names-only"], "UTC", "instances: {}\n");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });
  it("an existing but malformed config is not misreported as missing setup", () => {
    const r = cli(["ls"], "UTC", "instances: [\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("YAMLException");
    expect(r.stderr).not.toContain("isn't set up yet");
  });
});
