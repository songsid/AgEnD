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

const roots: string[] = [];

function runInstall(args: string[] = [], failSystemctl = false, notifyAccess = "all", systemUnit?: string) {
  const root = mkdtempSync(join(tmpdir(), "agend-install-auto-enable-"));
  roots.push(root);
  const home = join(root, "home");
  const data = join(root, "agend-home");
  const bin = join(root, "bin");
  const log = join(root, "systemctl.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const systemctl = join(bin, "systemctl");
  writeFileSync(systemctl, `#!/bin/sh
echo "$*" >> "$SYSTEMCTL_LOG"
if [ "$SYSTEMCTL_FAIL" = "1" ]; then
  echo "mock systemctl failure" >&2
  exit 1
fi
# #2331: what systemd LOADED for the unit — NotifyAccess from $SYSTEMCTL_NOTIFY until AgEnD's own drop-in is there.
case "$*" in *"show -p Type,NotifyAccess,"*)
  echo Type=notify
  if [ -f "$HOME/.config/systemd/user/com.agend.fleet.service.d/zz-agend-notify.conf" ]; then echo NotifyAccess=all; else echo "NotifyAccess=$SYSTEMCTL_NOTIFY"; fi;;
esac
`);
  chmodSync(systemctl, 0o755);
  // A legacy system unit: only that one path is redirected, inside the child, to a throwaway file (908's pattern).
  const preload: string[] = [];
  if (systemUnit !== undefined) {
    const unit = join(root, "agend.service");
    writeFileSync(unit, systemUnit);
    const file = join(root, "system-unit.mjs");
    writeFileSync(file, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const SYS = "/etc/systemd/system/agend.service"; const REAL = ${JSON.stringify(unit)};
for (const name of ["existsSync", "readFileSync", "statSync", "writeFileSync", "renameSync", "chmodSync"]) {
  const orig = fs[name]; fs[name] = (p, ...rest) => orig(String(p) === SYS ? REAL : p, ...rest);
}
syncBuiltinESMExports();
`);
    preload.push("--import", `file://${file}`);
  }

  const result = spawnSync(
    process.execPath,
    [...preload, "--import", "tsx", resolve("src/cli.ts"), "install", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: home,
        AGEND_HOME: data,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        SYSTEMCTL_LOG: log,
        SYSTEMCTL_FAIL: failSystemctl ? "1" : "0",
        SYSTEMCTL_NOTIFY: notifyAccess,
        NOTIFY_SOCKET: "",
      },
    },
  );
  return { result, home, log };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agend install service activation", () => {
  it("enables and starts the freshly installed Linux service by default", () => {
    const { result, home, log } = runInstall();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✅ Fleet service installed and running.");
    // #2331: reload, ask systemd what it loaded, then enable.
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "--user daemon-reload",
      "--user show -p Type,NotifyAccess,TimeoutStartUSec,FragmentPath,DropInPaths,OOMPolicy com.agend.fleet",
      "--user enable --now com.agend.fleet",
    ]);
    expect(existsSync(join(home, ".config/systemd/user/com.agend.fleet.service"))).toBe(true);
    expect(existsSync(join(home, ".config/systemd/user/com.agend.fleet.service.d/zz-agend-notify.conf"))).toBe(false);
  });

  it("#2331: a loaded NotifyAccess=main is repaired before the service is enabled (drop-in, reload, asked again)", () => {
    const { result, home, log } = runInstall([], false, "main");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("zz-agend-notify.conf: NotifyAccess=all — systemd had NotifyAccess=main loaded");
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "--user daemon-reload",
      "--user show -p Type,NotifyAccess,TimeoutStartUSec,FragmentPath,DropInPaths,OOMPolicy com.agend.fleet",
      "--user daemon-reload",
      "--user show -p Type,NotifyAccess,TimeoutStartUSec,FragmentPath,DropInPaths,OOMPolicy com.agend.fleet",
      "--user enable --now com.agend.fleet",
    ]);
    expect(readFileSync(join(home, ".config/systemd/user/com.agend.fleet.service.d/zz-agend-notify.conf"), "utf8")).toContain("[Service]\nNotifyAccess=all\n");
  });

  it("reports activation failure and prints the manual fallback command", () => {
    const { result } = runInstall([], true);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fleet service was installed but could not be started");
    expect(result.stderr).toContain(
      "systemctl --user daemon-reload && systemctl --user enable --now com.agend.fleet",
    );
  });

  it("#2331: the refresh on a host whose fleet runs under the system unit writes no second, user unit", () => {
    const { result, home, log } = runInstall(["--no-activate"], false, "all",
      "[Unit]\nDescription=AgEnD (operator's own)\n\n[Service]\nUser=root\nType=notify\nExecStart=/usr/bin/agend fleet start\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Service file updated (activation skipped).");
    expect(existsSync(join(home, ".config/systemd/user/com.agend.fleet.service"))).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  it("supports the update flow's service-file-only escape hatch", () => {
    const { result, log } = runInstall(["--no-activate"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Service file updated (activation skipped).");
    expect(existsSync(log)).toBe(false);
  });
});
