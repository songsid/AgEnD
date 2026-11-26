// M-3770 2.5: the recovery runner's service manager — the exact command sequences for systemd (user and root) and
// launchd, through a recording stand-in runner (no systemctl, no launchctl).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serviceManager, type Run } from "../src/update-recovery/service-manager.js";
import { realHands } from "../src/update-recovery/recover.js";

function recorder(answers: (cmd: string) => { status: number | null; stdout: string }) {
  const calls: string[] = [];
  const run: Run = (command, args) => { const line = [command, ...args].join(" "); calls.push(line); return answers(line); };
  let t = 0;
  return { calls, waited: () => t, deps: (uid: number) => ({ run, uid, sleep: (ms: number) => { t += ms; }, now: () => t }) };
}
const SYSTEMD = { kind: "systemd" as const, unit: "agend.service", fragmentPath: "/home/u/.config/systemd/user/agend.service" };
const LAUNCHD = { kind: "launchd" as const, unit: "com.agend.fleet", fragmentPath: "/Users/u/Library/LaunchAgents/com.agend.fleet.plist" };

describe("M-3770 2.5: systemd", () => {
  it("user: --user on every call; MainPID; stop waits for inactive; reload; reset-failed + start --no-block; settle", () => {
    let active = "active";
    const r = recorder(line => {
      if (line.includes("show -p MainPID")) return { status: 0, stdout: "4321\n" };
      if (line.includes("is-active")) { const s = active; if (line && active === "deactivating") active = "inactive"; return { status: 0, stdout: `${s}\n` }; }
      if (line.endsWith("stop agend.service")) { active = "deactivating"; return { status: 0, stdout: "" }; }
      return { status: 0, stdout: "" };
    });
    const m = serviceManager(SYSTEMD, r.deps(1000));
    expect(m.mainPid()).toBe(4321);
    expect(m.stop()).toBe(true);
    expect(m.reload()).toBe(true);
    expect(m.start()).toBe(true);
    expect(r.calls).toEqual([
      "systemctl --user show -p MainPID --value agend.service",
      "systemctl --user stop agend.service", "systemctl --user is-active agend.service", "systemctl --user is-active agend.service",
      "systemctl --user daemon-reload",
      "systemctl --user reset-failed agend.service", "systemctl --user start --no-block agend.service",
    ]);
    expect(m.waitSettled()).toBe(true);
  });

  it("root: no --user; MainPID 0 is none; a stop that never ends, or a refused start that never settles, times out", () => {
    const r = recorder(line => (line.includes("MainPID") ? { status: 0, stdout: "0\n" } : line.includes("is-active") ? { status: 0, stdout: "activating\n" } : { status: 0, stdout: "" }));
    const m = serviceManager(SYSTEMD, r.deps(0));
    expect(m.mainPid()).toBeNull();
    expect(r.calls[0]).toBe("systemctl show -p MainPID --value agend.service");
    expect(m.stop()).toBe(false);
    expect(m.waitSettled(1000)).toBe(false);
    expect(serviceManager(SYSTEMD, recorder(() => ({ status: 1, stdout: "" })).deps(0)).start()).toBe(false);
  });
});

describe("M-3770 2.5: launchd", () => {
  it("print for the pid; bootout then waits until it's gone; reload is a no-op; bootstrap when unloaded, then kickstart", () => {
    let loaded = true;
    const r = recorder(line => {
      if (line.startsWith("launchctl print")) return loaded ? { status: 0, stdout: "\tstate = running\n\tpid = 777\n" } : { status: 113, stdout: "" };
      if (line.startsWith("launchctl bootout")) { loaded = false; return { status: 0, stdout: "" }; }
      if (line.startsWith("launchctl bootstrap")) { loaded = true; return { status: 0, stdout: "" }; }
      return { status: 0, stdout: "" };
    });
    const m = serviceManager(LAUNCHD, r.deps(501));
    expect(m.mainPid()).toBe(777);
    expect(m.stop()).toBe(true);
    expect(m.mainPid()).toBeNull();
    expect(m.reload()).toBe(true);
    expect(m.start()).toBe(true);
    expect(r.calls).toEqual([
      "launchctl print gui/501/com.agend.fleet",
      "launchctl bootout gui/501/com.agend.fleet", "launchctl print gui/501/com.agend.fleet",
      "launchctl print gui/501/com.agend.fleet",
      "launchctl print gui/501/com.agend.fleet", `launchctl bootstrap gui/501 ${LAUNCHD.fragmentPath}`, "launchctl kickstart gui/501/com.agend.fleet",
    ]);
  });

  it("a job still loaded but idle (loaded before the route was written) is booted out and bootstrapped from disk before the kickstart; a running one is refused", () => {
    let loaded = true, running = false;
    const r = recorder(line => {
      if (line.startsWith("launchctl print")) return loaded ? { status: 0, stdout: `\tstate = ${running ? "running\n\tpid = 778" : "not running"}\n` } : { status: 113, stdout: "" };
      if (line.startsWith("launchctl bootout")) { loaded = false; return { status: 0, stdout: "" }; }
      if (line.startsWith("launchctl bootstrap")) { loaded = true; return { status: 0, stdout: "" }; }
      return { status: 0, stdout: "" };
    });
    const m = serviceManager(LAUNCHD, r.deps(501));
    expect(m.start()).toBe(true);
    expect(r.calls).toEqual([
      "launchctl print gui/501/com.agend.fleet", "launchctl bootout gui/501/com.agend.fleet", "launchctl print gui/501/com.agend.fleet",
      `launchctl bootstrap gui/501 ${LAUNCHD.fragmentPath}`, "launchctl kickstart gui/501/com.agend.fleet",
    ]);
    r.calls.length = 0; running = true;
    expect(m.start()).toBe(false);
    expect(r.calls).toEqual(["launchctl print gui/501/com.agend.fleet"]);           // never kickstarts a running job's old arguments
  });

  it("a bootout that fails with the job still loaded is a failed stop; a job still spawning hasn't settled", () => {
    const r = recorder(line => (line.startsWith("launchctl bootout") ? { status: 5, stdout: "" } : { status: 0, stdout: "\tstate = spawn scheduled\n" }));
    const m = serviceManager(LAUNCHD, r.deps(501));
    expect(m.stop()).toBe(false);
    expect(r.waited()).toBe(0);                                                                       // at once, not after a 30 s settle
    expect(m.waitSettled(1000)).toBe(false);
  });
});

describe("M-3770 2.5: recover.cjs's real hands", () => {
  it("the takeover wait answers the pid of a `fleet` record with this nonce, and only that", () => {
    const home = mkdtempSync(join(tmpdir(), "m3770-hands-"));
    try {
      const nonce = "c".repeat(32);
      writeFileSync(join(home, "fleet.lock"), JSON.stringify({ pid: 4321, nonce, createdAt: new Date().toISOString(), role: "fleet" }));
      expect(realHands(home).waitTakeover(nonce)).toBe(4321);
      expect(realHands(home, 0).waitTakeover("d".repeat(32))).toBeNull();                           // another nonce
      writeFileSync(join(home, "fleet.lock"), JSON.stringify({ pid: 4321, nonce, createdAt: new Date().toISOString(), role: "update", attemptId: "a1" }));
      expect(realHands(home, 0).waitTakeover(nonce)).toBeNull();                                     // not a fleet's record
      expect(realHands(home, 0).waitHandedBack(() => true)).toBe(true);
      expect(realHands(home, 0).waitHandedBack(() => false)).toBe(false);                             // bounded, not forever
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
