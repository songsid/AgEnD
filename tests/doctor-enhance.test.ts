import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import { collectDoctorReport, connectUnixSocket, formatDoctorReport } from "../src/doctor.js";
import type { ServiceInfo } from "../src/service-installer.js";

const roots: string[] = [];

function commandResult(status: number, stdout = "", stderr = "") {
  return { status, stdout, stderr, pid: 1, signal: null, output: [], error: undefined } as any;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AgEnD doctor", () => {
  it("reports prerequisites, service, D-Bus, fleet state, instance counts, and IPC", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-doctor-enhance-"));
    roots.push(dataDir);
    writeFileSync(join(dataDir, "fleet.yaml"), `defaults:
  backend: codex
instances:
  live: {}
  sleeping: {}
  stopped: {}
`);
    for (const name of ["live", "sleeping", "stopped"]) {
      mkdirSync(join(dataDir, "instances", name), { recursive: true });
    }
    writeFileSync(join(dataDir, "fleet.pid"), "4242");
    writeFileSync(join(dataDir, "instances/live/daemon.pid"), "4242");
    writeFileSync(join(dataDir, "instances/live/channel.sock"), "socket placeholder");
    writeFileSync(join(dataDir, "instances/sleeping/paused"), String(Date.now()));

    const service: ServiceInfo = {
      installed: true,
      path: "/tmp/com.agend.fleet.service",
      manager: "systemd --user",
      enabled: true,
      active: true,
    };
    const report = await collectDoctorReport(dataDir, service, {
      env: { TERM: "xterm-256color", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" },
      platform: "linux",
      processAlive: pid => pid === 4242,
      connectSocket: async path => path.endsWith("/live/channel.sock"),
      run: (file, args) => {
        if (file === "codex" && args[0] === "--version") return commandResult(0, "codex 1.0\n");
        if (file === "tmux" && args[0] === "-V") return commandResult(0, "tmux 3.7\n");
        if (file === "tmux" && args.includes("has-session")) return commandResult(0);
        return commandResult(1, "", "not found");
      },
    });

    expect(report.errors).toBe(0);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "Service", label: "enabled", status: "ok" }),
      expect.objectContaining({ section: "Service", label: "D-Bus", status: "ok" }),
      expect.objectContaining({ section: "Fleet", label: "fleet process", detail: "PID 4242 is alive" }),
      expect.objectContaining({ section: "Fleet", label: "instances", detail: "1 running, 1 paused, 1 stopped, 0 crashed (3 total)" }),
      expect.objectContaining({ section: "MCP IPC", label: "channel.sock", detail: "1/1 running instance socket(s) reachable" }),
    ]));
    const formatted = formatDoctorReport(report);
    expect(formatted).toContain("AgEnD doctor");
    expect(formatted).toContain("MCP IPC");
  });

  it("warns when the service is inactive and the Linux session bus is missing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-doctor-enhance-"));
    roots.push(dataDir);
    const report = await collectDoctorReport(dataDir, {
      installed: true,
      path: "/tmp/com.agend.fleet.service",
      manager: "systemd --user",
      enabled: false,
      active: false,
    }, {
      env: { TERM: "xterm" },
      platform: "linux",
      processAlive: () => false,
      connectSocket: async () => false,
      run: (file, args) => {
        if (file === "claude" && args[0] === "--version") return commandResult(0, "claude 1\n");
        if (file === "tmux" && args[0] === "-V") return commandResult(0, "tmux 3.7\n");
        return commandResult(1);
      },
    });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "enabled", status: "warn", detail: expect.stringContaining("no") }),
      expect.objectContaining({ label: "active", status: "warn", detail: expect.stringContaining("inactive") }),
      expect.objectContaining({ label: "D-Bus", status: "warn", detail: expect.stringContaining("not set") }),
    ]));
  });

  it("skips the in-process mock backend instead of reporting a missing binary", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-doctor-enhance-"));
    roots.push(dataDir);
    writeFileSync(join(dataDir, "fleet.yaml"), "defaults:\n  backend: mock\ninstances:\n  test: {}\n");
    const commands: string[] = [];
    const report = await collectDoctorReport(dataDir, {
      installed: false,
      path: null,
      manager: "systemd --user",
      enabled: null,
      active: null,
    }, {
      env: { TERM: "xterm" },
      platform: "linux",
      processAlive: () => false,
      connectSocket: async () => false,
      run: (file, args) => {
        commands.push([file, ...args].join(" "));
        return file === "tmux" && args[0] === "-V"
          ? commandResult(0, "tmux 3.7\n")
          : commandResult(1);
      },
    });

    expect(commands.some(command => command.startsWith("mock "))).toBe(false);
    expect(report.checks.some(check => check.label === "backend mock")).toBe(false);
  });

  it("explains that an unavailable user service manager is common over SSH without D-Bus", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-doctor-enhance-"));
    roots.push(dataDir);
    const report = await collectDoctorReport(dataDir, {
      installed: true,
      path: "/tmp/com.agend.fleet.service",
      manager: "systemd --user",
      enabled: null,
      active: null,
    }, {
      env: { TERM: "xterm" },
      platform: "linux",
      processAlive: () => false,
      connectSocket: async () => false,
      run: (file, args) => file === "tmux" && args[0] === "-V"
        ? commandResult(0, "tmux 3.7\n")
        : file === "claude"
          ? commandResult(0, "claude 1\n")
          : commandResult(1),
    });

    expect(report.checks.filter(check => check.label === "enabled" || check.label === "active"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining("SSH without a user D-Bus session") }),
      ]));
  });

  it("connects to a real Unix IPC socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-doctor-socket-"));
    roots.push(root);
    const socketPath = join(root, "channel.sock");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      expect(await connectUnixSocket(socketPath)).toBe(true);
      expect(await connectUnixSocket(join(root, "missing.sock"))).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
