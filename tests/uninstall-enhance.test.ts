import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { isServiceRemovalConfirmed } from "../src/service-installer.js";

const roots: string[] = [];

function runUninstall(options: { installed?: boolean; args?: string[]; input?: string; failDisable?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-uninstall-"));
  roots.push(root);
  const home = join(root, "home");
  const data = join(root, "agend-home");
  const bin = join(root, "bin");
  const log = join(root, "systemctl.log");
  const unit = join(home, ".config/systemd/user/com.agend.fleet.service");
  mkdirSync(dirname(unit), { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (options.installed) writeFileSync(unit, "[Service]\nExecStart=/bin/true\n");
  const systemctl = join(bin, "systemctl");
  writeFileSync(systemctl, `#!/bin/sh
echo "$*" >> "$SYSTEMCTL_LOG"
if [ "$SYSTEMCTL_FAIL_DISABLE" = "1" ] && [ "$*" = "--user disable --now com.agend.fleet" ]; then
  echo "mock D-Bus failure" >&2
  exit 1
fi
case "$*" in
  "--user is-active com.agend.fleet") echo active ;;
  "--user is-enabled com.agend.fleet") echo enabled ;;
esac
`);
  chmodSync(systemctl, 0o755);

  const cliPath = resolve("src/cli.ts");
  const cliArgs = ["uninstall", ...(options.args ?? [])];
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, ...cliArgs],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: options.input,
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: home,
        AGEND_HOME: data,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        SYSTEMCTL_LOG: log,
        SYSTEMCTL_FAIL_DISABLE: options.failDisable ? "1" : "0",
        NOTIFY_SOCKET: "",
      },
    },
  );
  return { result, unit, log };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agend uninstall", () => {
  it("reports cleanly when no service is installed", () => {
    const { result, log } = runUninstall();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("No AgEnD service found");
    expect(existsSync(log)).toBe(false);
  });

  it("treats blank/yes as confirmation and no as cancellation", () => {
    expect(isServiceRemovalConfirmed("")).toBe(true);
    expect(isServiceRemovalConfirmed(" y ")).toBe(true);
    expect(isServiceRemovalConfirmed("YES")).toBe(true);
    expect(isServiceRemovalConfirmed("n")).toBe(false);
    expect(isServiceRemovalConfirmed("no")).toBe(false);
  });

  it("disables, stops, and removes the service with --force", () => {
    const { result, unit, log } = runUninstall({ installed: true, args: ["--force"] });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Remove service?");
    expect(result.stdout).toContain("Service disabled, stopped, and removed.");
    expect(existsSync(unit)).toBe(false);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "--user is-active com.agend.fleet",
      "--user is-enabled com.agend.fleet",
      "--user disable --now com.agend.fleet",
      "--user daemon-reload",
    ]);
  });

  it("fails closed before prompting in a non-interactive session", () => {
    const { result, unit, log } = runUninstall({ installed: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Path:");
    expect(result.stdout).toContain("Enabled: yes");
    expect(result.stdout).toContain("Active: running");
    expect(result.stdout).toContain("Non-interactive session — re-run with --force");
    expect(result.stdout).not.toContain("Remove service?");
    expect(existsSync(unit)).toBe(true);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "--user is-active com.agend.fleet",
      "--user is-enabled com.agend.fleet",
    ]);
  });

  it("keeps the unit file when the service manager cannot stop it", () => {
    const { result, unit } = runUninstall({ installed: true, args: ["--force"], failDisable: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("systemctl could not disable/stop com.agend.fleet");
    expect(existsSync(unit)).toBe(true);
  });
});
