import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agend start service ownership", () => {
  it("fails closed when an installed user service cannot reach D-Bus", () => {
    const root = join(tmpdir(), `agend-no-bus-${process.pid}-${Date.now()}`);
    const home = join(root, "home");
    const data = join(root, "data");
    const bin = join(root, "bin");
    created.push(root);
    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    mkdirSync(data, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(home, ".config/systemd/user/com.agend.fleet.service"), "[Service]\n");
    const systemctl = join(bin, "systemctl");
    writeFileSync(systemctl, "#!/bin/sh\necho 'Failed to connect to bus: No medium found' >&2\nexit 1\n");
    chmodSync(systemctl, 0o755);

    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "start"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        AGEND_HOME: data,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        NOTIFY_SOCKET: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to start a detached duplicate");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Fleet starting in background");
  });
});
