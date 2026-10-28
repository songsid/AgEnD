/** #2813: ~80s, no fleet/accounts. Own scratch Type=notify units only; WatchdogSec=60.
 * Run: npx tsx scripts/manual/smoke/smoke-2813-watchdog.mts
 * Injected EAGAIN + 3.5s fork delay, not real host memory/CPU exhaustion.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const mode = process.argv[2];
if (mode === "survive" || mode === "blocked") {
  const socket = process.env.NOTIFY_SOCKET;
  if (!socket) throw new Error("scratch unit has no notify socket");
  writeFileSync("/proc/self/coredump_filter", "0");
  const { createSdNotifier, sendSystemdNotificationAsync, startSdWatchdog } = await import("../../../src/sd-notify.js");
  const send = (state: string, done: (error: Error | null) => void) =>
    sendSystemdNotificationAsync(state, socket, process.env, undefined, done);
  await new Promise<void>((resolve, reject) => send("READY=1", error => error ? reject(error) : resolve()));
  const started = performance.now();
  let delayed = false;
  const notify = createSdNotifier({ socket, pid: () => process.pid, recordedPid: () => process.pid,
    warn: () => (fields, message) => console.log(JSON.stringify({ message, ...fields })),
    send: (state, _socket, done) => {
      const elapsed = performance.now() - started;
      if (mode === "survive" && state === "WATCHDOG=1" && (!delayed || (elapsed >= 17_000 && elapsed < 47_000))) {
        if (!delayed) { delayed = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_500); }
        done(Object.assign(new Error("injected fork EAGAIN"), { code: "EAGAIN" }));
        return;
      }
      send(state, error => { if (!error) console.log(JSON.stringify({ delivered: state, elapsedMs: Math.round(performance.now() - started) })); done(error); });
    },
  });
  notify("WATCHDOG=1");
  const timer = startSdWatchdog(notify);
  if (mode === "blocked") {
    // Initial heartbeat is delivered, then the real loop stops. No independent feeder.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 90_000);
    throw new Error("a blocked loop escaped the watchdog");
  }
  await new Promise(resolve => setTimeout(resolve, 75_000));
  clearInterval(timer); notify.cancelRetry();
  console.log("SURVIVED_FORK_DELAY_AND_FAILURES");
} else {
  const exec = promisify(execFile);
  const home = mkdtempSync(join(tmpdir(), "agend-watchdog-2813-"));
  const prefix = `agend-test-watchdog-2813-${process.pid}-${Date.now()}`;
  const units = ["survive", "blocked"].map(kind => `${prefix}-${kind}.service`);
  const own = (unit: string) => { if (!units.includes(unit)) throw new Error("not an owned scratch unit"); return unit; };
  const show = async (unit: string) => (await exec("systemctl", ["--user", "show", own(unit), "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus"], { timeout: 5_000 })).stdout;
  try {
    for (const [i, kind] of ["survive", "blocked"].entries()) {
      execFileSync("systemd-run", ["--user", `--unit=${own(units[i])}`, "--property=Type=notify", "--property=NotifyAccess=all",
        "--property=WatchdogSec=60s", "--property=TimeoutStartSec=30s", "--property=RuntimeMaxSec=110s",
        "--property=Restart=no", "--property=LimitCORE=0", "--property=MemoryMax=512M", "--property=TasksMax=64",
        `--setenv=HOME=${home}`, `--setenv=AGEND_HOME=${home}`,
        process.execPath, "--import", fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
        fileURLToPath(import.meta.url), kind], { timeout: 10_000, stdio: "pipe" });
    }
    const started = performance.now(); let liveChecked = false;
    for (;;) {
      const elapsed = performance.now() - started;
      if (elapsed > 67_000 && !liveChecked) {
        const state = await show(units[0]);
        if (!state.includes("ActiveState=active")) throw new Error(`survival unit failed early: ${state}`);
        liveChecked = true; console.log("PASS survival active beyond WatchdogSec=60");
      }
      const states = await Promise.all(units.map(show));
      if (elapsed > 76_000 && !states[0].includes("ActiveState=active")) {
        console.log(JSON.stringify({ units, states, liveChecked }));
        if (!liveChecked || !states[0].includes("Result=success") || !states[1].includes("Result=watchdog") || !states[1].includes("ExecMainStatus=6"))
          throw new Error("scratch unit acceptance failed");
        console.log("PASS blocked loop aborted by watchdog (SIGABRT), healthy loop survived");
        break;
      }
      if (elapsed > 100_000) throw new Error("scratch acceptance deadline");
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    for (const unit of units) console.log((await exec("journalctl", ["--user", "-u", own(unit), "--no-pager", "-n", "35"], { timeout: 5_000 })).stdout);
  } finally {
    for (const unit of units) {
      await exec("systemctl", ["--user", "stop", own(unit)], { timeout: 10_000 }).catch(() => {});
      await exec("systemctl", ["--user", "reset-failed", own(unit)], { timeout: 5_000 }).catch(() => {});
    }
    rmSync(home, { recursive: true, force: true });
  }
}
