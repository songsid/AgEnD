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

function runInstall(args: string[] = [], failSystemctl = false) {
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
`);
  chmodSync(systemctl, 0o755);

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve("src/cli.ts"), "install", ...args],
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
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "--user daemon-reload",
      "--user enable --now com.agend.fleet",
    ]);
    expect(existsSync(join(home, ".config/systemd/user/com.agend.fleet.service"))).toBe(true);
  });

  it("reports activation failure and prints the manual fallback command", () => {
    const { result } = runInstall([], true);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fleet service was installed but could not be started");
    expect(result.stderr).toContain(
      "systemctl --user daemon-reload && systemctl --user enable --now com.agend.fleet",
    );
  });

  it("supports the update flow's service-file-only escape hatch", () => {
    const { result, log } = runInstall(["--no-activate"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Service file updated (activation skipped).");
    expect(existsSync(log)).toBe(false);
  });
});
