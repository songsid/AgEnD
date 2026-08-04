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
    expect(unit).toContain("TimeoutStartSec=0");
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
    expect(plist).toContain(process.env.PATH!);
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
});
