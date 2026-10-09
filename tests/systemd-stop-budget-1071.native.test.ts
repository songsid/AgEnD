/** Opt-in real user-manager validation in private user/mount/PID namespaces.
 * No host manager, service.d, fleet process, tmux, or backend is used. */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureSystemdUnitHardening, renderSystemdUnit } from "../src/service-installer.js";
import { systemdStopTimeoutMs, FLEET_STOP_TIMEOUT_MS } from "../src/fleet-stop-budget.js";

describe.skipIf(process.env.AGEND_SYSTEMD_PRIVATE_E2E !== "1" || process.platform !== "linux")("#1071 actual unit file + user-manager reload (private)", () => {
  it("loads 60s, then the real migrated rendered file's 300s", () => {
    mkdirSync(join(process.cwd(), ".artifacts"), { recursive: true });
    const root = mkdtempSync(join(process.cwd(), ".artifacts/systemd1071-"));
    try {
      const home = join(root, "home"), units = join(home, ".config/systemd/user"); mkdirSync(units, { recursive: true });
      const name = "agend-private-1071.service", unit = join(units, name), upgraded = join(root, "upgraded.service");
      const rendered = renderSystemdUnit({ label: "agend-private-1071", execPath: "/never/start/cli.js", workingDirectory: "/tmp", logPath: "/tmp/never-used.log" });
      // It is a real unit file, not a transient -p property. NEVER start it.
      writeFileSync(upgraded, rendered.replace("TimeoutStopSec=300", "TimeoutStopSec=60"));
      writeFileSync(unit, readFileSync(upgraded));
      expect(ensureSystemdUnitHardening(upgraded, { dropInPaths: [] })).toMatchObject({ kind: "ok", directives: { TimeoutStopSec: "upgraded" } });
      writeFileSync(join(units, "default.target"), "[Unit]\nDescription=Private test manager only\nDefaultDependencies=no\n");
      const script = join(root, "probe.sh");
      writeFileSync(script, `#!/bin/sh
set -eu
mount --bind "$1" /tmp
export HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/run XDG_CONFIG_HOME=/tmp/home/.config
export SYSTEMD_UNIT_PATH=/tmp/home/.config/systemd/user
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
unset DBUS_SESSION_BUS_ADDRESS DBUS_SYSTEM_BUS_ADDRESS NOTIFY_SOCKET
exec dbus-run-session -- sh -c '
  /usr/lib/systemd/systemd --user > /tmp/manager.log 2>&1 &
  manager_pid=$!
  trap "kill -KILL $manager_pid 2>/dev/null || true; wait $manager_pid 2>/dev/null || true" EXIT
  n=0
  until systemctl --user show -p Version >/dev/null 2>&1; do
    n=$((n+1)); [ "$n" -lt 40 ] || { cat /tmp/manager.log; exit 1; }
    sleep 0.1
  done
  systemctl --user daemon-reload
  printf "BEFORE="; systemctl --user show ${name} -p TimeoutStopUSec --value
  cp /tmp/upgraded.service /tmp/home/.config/systemd/user/${name}
  systemctl --user daemon-reload
  printf "AFTER="; systemctl --user show ${name} -p TimeoutStopUSec --value
  systemctl --user show ${name} -p FragmentPath
  systemctl --version | head -n1
  kill -KILL $manager_pid
  wait $manager_pid 2>/dev/null || true
'
`);
      let output: string;
      try { output = execFileSync("unshare", ["-Urmpf", "--kill-child=KILL", "--mount-proc", "sh", script, root], { encoding: "utf8", timeout: 15_000,
        env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: home } }); }
      catch (error) { console.error("private manager output:", (error as any).stdout); throw error; }
      expect(systemdStopTimeoutMs(/^BEFORE=(.*)$/m.exec(output)![1]!)).toBe(60_000);
      expect(systemdStopTimeoutMs(/^AFTER=(.*)$/m.exec(output)![1]!)).toBe(FLEET_STOP_TIMEOUT_MS);
      expect(output).toContain(`FragmentPath=/tmp/home/.config/systemd/user/${name}`);
      writeFileSync(join(process.cwd(), ".artifacts/systemd-stop-budget-native-proof.json"), JSON.stringify({ output, beforeMs: 60_000, afterMs: FLEET_STOP_TIMEOUT_MS, scope: "private user/mount/PID namespaces; actual user unit + daemon-reload; never started unit" }, null, 2));
      console.log(output.trim());
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
});
