/** Opt-in real read/reload only. The private manager never starts any unit. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe.skipIf(process.env.AGEND_SYSTEMD_PRIVATE_E2E !== "1" || process.platform !== "linux")("#1490 private actual unit and loaded runtime", () => {
  it("loads the real unit and reloads it; unavailable API-bus evidence stays unknown", () => {
    mkdirSync(join(process.cwd(), ".artifacts"), { recursive: true });
    const root = mkdtempSync(join(process.cwd(), ".artifacts/systemd1490-"));
    try {
      const units = join(root, "home/.config/systemd/user"); mkdirSync(units, { recursive: true });
      writeFileSync(join(units, "default.target"), "[Unit]\nDefaultDependencies=no\n");
      writeFileSync(join(units, "agend-private-1490.service"), "[Unit]\nDescription=private-before\n[Service]\nExecStart=/bin/true\nKillMode=mixed\nTimeoutStopSec=300\n");
      const module = new URL("../dist/systemd-runtime.js", import.meta.url).href;
      writeFileSync(join(root, "probe.mjs"), `import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {readSystemdRuntime,systemdStopped} from ${JSON.stringify(module)};
const run=(command,args)=>{ const r=spawnSync(command,args,{encoding:'utf8',timeout:3000}); return {status:r.status,signal:r.signal,stdout:r.stdout??'',stderr:r.stderr??''}; };
const show=property=>{const r=run('systemctl',['--user','show','agend-private-1490.service','-p',property,'--value']); assert.equal(r.status,0);return r.stdout.trim();};
const before=readSystemdRuntime(run,true,'agend-private-1490');if(before!==null)assert.ok(systemdStopped(before));assert.equal(show('ActiveState'),'inactive');assert.equal(show('SubState'),'dead');assert.equal(show('MainPID'),'0');assert.equal(show('Description'),'private-before');
writeFileSync('/tmp/home/.config/systemd/user/agend-private-1490.service','[Unit]\\nDescription=private-after\\n[Service]\\nExecStart=/bin/false\\nKillMode=mixed\\nTimeoutStopSec=300\\n');
assert.equal(run('systemctl',['--user','daemon-reload']).status,0);
const after=readSystemdRuntime(run,true,'agend-private-1490');if(after!==null)assert.ok(systemdStopped(after));assert.equal(show('ActiveState'),'inactive');assert.equal(show('SubState'),'dead');assert.equal(show('MainPID'),'0');assert.equal(show('Description'),'private-after');
assert.equal(show('FragmentPath'),'/tmp/home/.config/systemd/user/agend-private-1490.service');
console.log(JSON.stringify({before,after,api_bus_available:before!==null&&after!==null,loaded_description:'private-after',scope:'private user/mount/PID namespaces; real unit and daemon-reload; no unit was started'}));
`);
      const script = join(root, "run.sh");
      writeFileSync(script, `#!/bin/sh
set -eu
mount --bind "$1" /tmp
export HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/run XDG_CONFIG_HOME=/tmp/home/.config
export SYSTEMD_UNIT_PATH=/tmp/home/.config/systemd/user
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
unset DBUS_SESSION_BUS_ADDRESS DBUS_SYSTEM_BUS_ADDRESS NOTIFY_SOCKET
exec dbus-run-session -- sh -c '
  bus_socket=\${DBUS_SESSION_BUS_ADDRESS#unix:path=}
  bus_socket=\${bus_socket%%,*}
  ln -s "$bus_socket" "$XDG_RUNTIME_DIR/bus"
  /usr/lib/systemd/systemd --user > /tmp/manager.log 2>&1 &
  manager_pid=$!
  trap "kill -KILL $manager_pid 2>/dev/null || true; wait $manager_pid 2>/dev/null || true" EXIT
  n=0
  until systemctl --user show -p Version >/dev/null 2>&1; do
    n=$((n+1)); [ "$n" -lt 40 ] || { cat /tmp/manager.log; exit 1; }
    sleep 0.1
  done
  systemctl --user daemon-reload
  "$1" /tmp/probe.mjs
  kill -KILL $manager_pid
  wait $manager_pid 2>/dev/null || true
' private "$2"
`);
      const output = execFileSync("unshare", ["-Urmpf", "--kill-child=KILL", "--mount-proc", "sh", script, root, process.execPath], {
        encoding: "utf8", timeout: 15_000, env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: join(root, "home") },
      });
      const receipt = JSON.parse(output.trim());
      if (receipt.before !== null) expect(receipt.before).toEqual({ active: "inactive", sub: "dead", pid: 0, control: 0, job: 0, type: "simple", killMode: "mixed", sendSigkill: true });
      expect(receipt.after).toEqual(receipt.before); expect(receipt.loaded_description).toBe("private-after");
      writeFileSync(join(process.cwd(), ".artifacts/systemd-runtime-native-proof.json"), JSON.stringify(receipt, null, 2));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
});
