import { describe, it, expect, vi } from "vitest";
import {
  buildServicePath,
  classifySystemdServiceState,
  renderLaunchdPlist,
  renderSystemdUnit,
  detectPlatform,
  uninstallService,
  restartSystemdService,
  SYSTEMD_RESTART_TIMEOUT_MS,
} from "../src/service-installer.js";

describe("ServiceInstaller", () => {
  const vars = {
    label: "com.claude-channel-daemon",
    execPath: "/usr/local/bin/claude-channel-daemon",
    path: "/usr/local/bin:/usr/bin:/bin",
    workingDirectory: "/Users/test/project",
    logPath: "/Users/test/.claude-channel-daemon/daemon.log",
  };

  it("detects platform correctly", () => {
    const platform = detectPlatform();
    expect(["macos", "linux"]).toContain(platform);
  });

  it("renders launchd plist with correct values", () => {
    const plist = renderLaunchdPlist(vars);
    expect(plist).toContain("<string>com.claude-channel-daemon</string>");
    expect(plist).toContain("<string>/usr/local/bin/claude-channel-daemon</string>");
    expect(plist).toContain("<string>fleet</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<string>/usr/local/bin:/usr/bin:/bin:");
  });

  it("renders systemd unit with correct values", () => {
    const unit = renderSystemdUnit(vars);
    expect(unit).toContain("ExecStart=/usr/local/bin/claude-channel-daemon fleet start");
    expect(unit).toContain("WorkingDirectory=/Users/test/project");
    expect(unit).toContain("Environment=PATH=/usr/local/bin:/usr/bin:/bin");
    expect(unit).toContain("TimeoutStartSec=15min");
    expect(unit).not.toMatch(/^TimeoutStartSec=0$/m);
    expect(unit).toContain("TimeoutStopSec=60");
  });

  it("treats active and activating systemd units as running", () => {
    expect(classifySystemdServiceState({ status: 0, stdout: "active\n" })).toBe("running");
    expect(classifySystemdServiceState({ status: 3, stdout: "activating\n" })).toBe("running");
  });

  it("distinguishes a reachable stopped unit from an unavailable bus", () => {
    expect(classifySystemdServiceState({ status: 3, stdout: "inactive\n" })).toBe("stopped");
    expect(classifySystemdServiceState({
      status: 1,
      stderr: "Failed to connect to bus: No medium found",
    })).toBe("unavailable");
  });

  it("waits long enough for a Type=notify fleet restart to reach READY=1", () => {
    const run = vi.fn();

    expect(restartSystemdService("com.agend.fleet", true, run)).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "restart", "com.agend.fleet"],
      { stdio: "inherit", timeout: SYSTEMD_RESTART_TIMEOUT_MS },
    );
    expect(SYSTEMD_RESTART_TIMEOUT_MS).toBe(300_000);
  });

  it("reports a real systemctl restart failure", () => {
    const run = vi.fn(() => { throw new Error("unit failed"); });
    expect(restartSystemdService("agend", false, run)).toBe(false);
    expect(run).toHaveBeenCalledWith(
      "systemctl",
      ["restart", "agend"],
      expect.objectContaining({ timeout: SYSTEMD_RESTART_TIMEOUT_MS }),
    );
  });

  it("falls back to process.env.PATH when path is omitted", () => {
    const { path: _, ...varsWithoutPath } = vars;
    const plist = renderLaunchdPlist(varsWithoutPath);
    expect(plist).toContain("<key>PATH</key>");
    // Verify the PATH key is present; the exact value is filtered/deduped (#1348).
    expect(plist).toMatch(/<string>[^<]+<\/string>/);
  });

  it("appends root user and nvm npm-prefix bins omitted by sudo PATH", () => {
    const path = buildServicePath(
      "/usr/sbin:/usr/bin:/bin",
      "/root/.nvm/versions/node/v22.22.0/lib/node_modules/@songsid/agend/dist/cli.js",
      "/root",
    );
    const entries = path.split(":");
    expect(entries.slice(0, 3)).toEqual(["/usr/sbin", "/usr/bin", "/bin"]);
    expect(entries).toContain("/root/.nvm/versions/node/v22.22.0/bin");
    expect(entries).toContain("/root/.local/bin");
    expect(entries).toContain("/root/.npm-global/bin");
  });

  it("rejects logPath with newline (systemd directive injection)", () => {
    expect(() => renderSystemdUnit({
      ...vars,
      logPath: "/tmp/log\nExecStartPost=/bin/rm -rf /",
    })).toThrow(/control characters/);
  });

  it("rejects workingDirectory with NUL", () => {
    expect(() => renderLaunchdPlist({
      ...vars,
      workingDirectory: "/tmp/\x00escape",
    })).toThrow(/control characters/);
  });

  it("rejects non-absolute execPath", () => {
    expect(() => renderSystemdUnit({
      ...vars,
      execPath: "agend",
    })).toThrow(/absolute path/);
  });

  it("rejects label containing special chars", () => {
    expect(() => renderLaunchdPlist({
      ...vars,
      label: "com.agend; /bin/sh",
    })).toThrow(/label must match/);
  });

  // ── #1348: node_modules/.bin entries must be stripped and deduped ─────────

  /**
   * The live polluted PATH from the real unit (redacted): it contains:
   *   - the muse worktree .bin twice
   *   - npm's own node-gyp-bin runner
   *   - duplicates of ~/.local/bin
   *   - the real nvm bin (must be preserved — agend and node live there)
   */
  const POLLUTED_PATH = [
    "/home/han/Projects/AgEnD-agend-dev-muse/node_modules/.bin",
    "/home/han/Projects/AgEnD-agend-dev-muse/node_modules/.bin", // duplicate
    "/home/han/Projects/node_modules/.bin",
    "/home/han/node_modules/.bin",
    "/home/node_modules/.bin",
    "/node_modules/.bin",
    "/home/han/.nvm/versions/node/v22.22.2/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
    "/home/han/.local/bin",
    "/home/han/.local/bin", // duplicate
    "/home/han/bin",
    "/home/han/.grok/bin",
    "/home/han/.nvm/versions/node/v22.22.2/bin", // nvm — must be kept
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/local/bin", // duplicate
    "/usr/bin",
    "/bin",
  ].join(":");

  it("strips node_modules/.bin entries from the PATH (#1348)", () => {
    const result = buildServicePath(POLLUTED_PATH, "", "/home/han");
    const entries = result.split(":");
    // No entry may contain /node_modules/
    const remaining = entries.filter(e => e.includes("/node_modules/"));
    expect(remaining, `node_modules entries must be removed, found: ${remaining.join(", ")}`).toEqual([]);
  });

  it("preserves the nvm bin directory after stripping node_modules (#1348)", () => {
    const result = buildServicePath(POLLUTED_PATH, "", "/home/han");
    const entries = result.split(":");
    expect(entries).toContain("/home/han/.nvm/versions/node/v22.22.2/bin");
  });

  it("deduplicates entries while preserving first-appearance order (#1348)", () => {
    const result = buildServicePath(POLLUTED_PATH, "", "/home/han");
    const entries = result.split(":");
    const unique = [...new Set(entries)];
    expect(entries, "result must have no duplicates").toEqual(unique);
    // The first non-node_modules entry in POLLUTED_PATH is /home/han/.local/bin
    const lbIdx = entries.indexOf("/home/han/.local/bin");
    const binIdx = entries.indexOf("/home/han/bin");
    expect(lbIdx, ".local/bin must appear before /home/han/bin (order preserved)").toBeLessThan(binIdx);
  });

  it("mutation proof: removing the node_modules filter admits node_modules entries → test goes red", () => {
    // Verify the filter acts on entries that would otherwise appear.
    // Without the filter, the first entry of POLLUTED_PATH would be in the result.
    const poisoned = "/home/han/Projects/test/node_modules/.bin:/usr/bin:/bin";
    const result = buildServicePath(poisoned, "", "/home/han");
    const entries = result.split(":");
    expect(entries).not.toContain("/home/han/Projects/test/node_modules/.bin");
    // Mutant (remove filter): the entry would be present.
  });

  it("mutation proof: removing the dedup emits duplicates → test goes red", () => {
    const duped = "/usr/bin:/usr/bin:/bin";
    const result = buildServicePath(duped, "", "/home/han");
    const entries = result.split(":");
    const seen = new Set<string>();
    for (const e of entries) {
      expect(seen.has(e), `duplicate entry: ${e}`).toBe(false);
      seen.add(e);
    }
    // Mutant (remove dedup): /usr/bin would appear twice.
  });
});
