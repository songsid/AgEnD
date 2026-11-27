/**
 * M-3770 S-246: `agend install` while a hand-started fleet runs (service-install-handover.ts, detached-fleet-stop.ts).
 *  - Refused before any stop: an owner that can't be proven, or a service manager that can't take the fleet, stops nothing.
 *  - The stop is the proven one (`agend restart`'s): SIGTERM, a graceful wait, SIGKILL only to the owner proven again; a
 *    recycled PID or a new publication is never signalled, and nothing starts until the old fleet is gone.
 *  - No down path: when the service can't start after the stop, the hand-started fleet is started again.
 *  - `agend install` takes this path, and the old SIGTERM-and-two-seconds one is skipped for it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handOverToService, type HandoverDeps } from "../src/service-install-handover.js";
import { clearStoppedPublication, detachedFleetOwner, stopProvenFleet, type DetachedOwner, type DetachedOwnerProbes } from "../src/detached-fleet-stop.js";
import { FLEET_STOP_TIMEOUT_MS } from "../src/fleet-stop-budget.js";

type State = ReturnType<DetachedOwner["inspect"]>;
const owner = (states: State[], pid = 4242): DetachedOwner => {
  let i = 0;
  return { pid, publication: `${pid}\n`, inspect: () => states[Math.min(i++, states.length - 1)]! };
};
function deps(over: Partial<HandoverDeps> = {}, o: DetachedOwner | null = owner(["fleet"])) {
  const order: string[] = [];
  const d: HandoverDeps = {
    prepare: () => { order.push("prepare"); },
    owner: () => { order.push("owner"); return o; },
    stop: async () => { order.push("stop"); },
    clear: () => { order.push("clear"); return true; },
    activate: () => { order.push("activate"); },
    restartHandStarted: () => { order.push("restart"); },
    log: () => {},
    ...over,
  };
  return { d, order };
}

describe("S-246: the hand-over to the service", () => {
  it("a running hand-started fleet: proven, the manager proven, stopped, its publication cleared, then the service", async () => {
    const { d, order } = deps();
    expect(await handOverToService(d)).toEqual({ ok: true, stopped: true });
    expect(order).toEqual(["owner", "prepare", "stop", "clear", "activate"]);
  });

  it("no fleet: the service only (nothing to stop); a stale publication is cleared first, nothing stopped", async () => {
    const none = deps({}, null);
    expect(await handOverToService(none.d)).toEqual({ ok: true, stopped: false });
    expect(none.order).toEqual(["owner", "prepare", "activate"]);
    const stale = deps({}, owner(["gone"]));
    expect(await handOverToService(stale.d)).toEqual({ ok: true, stopped: false });
    expect(stale.order).toEqual(["owner", "prepare", "clear", "activate"]);
  });

  it("refused before any stop: the manager can't take it, the owner can't be proven, an invalid PID — nothing stopped or started", async () => {
    const err = new Error("the user's service manager isn't running");
    const manager = deps({ prepare: () => { throw err; } });
    expect(await handOverToService(manager.d)).toEqual({ ok: false, stage: "refused", message: err.message, error: err });
    expect(manager.order).toEqual(["owner"]);
    for (const state of ["unknown", "waiting"] as const) {
      const unproven = deps({}, owner([state]));
      expect(await handOverToService(unproven.d), state).toMatchObject({ ok: false, stage: "refused" });
      expect(unproven.order, state).toEqual(["owner"]);
    }
    for (const pid of [Number.NaN, 1, 0]) {
      const bad = deps({}, owner(["fleet"], pid));
      expect(await handOverToService(bad.d)).toMatchObject({ ok: false, stage: "refused", message: expect.stringContaining("Invalid detached fleet PID") });
      expect(bad.order).toEqual(["owner"]);
    }
  });

  it("a stop that loses its proof, or a new owner published meanwhile: the service is not started", async () => {
    const lost = deps({ stop: async () => { throw new Error("Detached fleet has not exited after SIGKILL; refusing to start a duplicate"); } });
    expect(await handOverToService(lost.d)).toMatchObject({ ok: false, stage: "stop", message: expect.stringContaining("The service was not started.") });
    expect(lost.order).toEqual(["owner", "prepare"]);
    const moved = deps({ clear: () => false });
    expect(await handOverToService(moved.d)).toMatchObject({ ok: false, stage: "stop" });
    expect(moved.order).toEqual(["owner", "prepare", "stop"]);
  });

  it("no down path: the service can't start after the stop → the hand-started fleet is started again", async () => {
    const err = new Error("systemctl --user enable --now failed");
    const failed = deps({ activate: () => { failed.order.push("activate"); throw err; } });
    expect(await handOverToService(failed.d)).toEqual({ ok: false, stage: "activate", message: err.message, restarted: true, error: err });
    expect(failed.order).toEqual(["owner", "prepare", "stop", "clear", "activate", "restart"]);
    // Nothing was running: nothing to start again.
    const idle = deps({ activate: () => { throw err; } }, null);
    expect(await handOverToService(idle.d)).toMatchObject({ stage: "activate", restarted: false });
    expect(idle.order).not.toContain("restart");
    // Starting it again fails too: say so, and how.
    const both = deps({ activate: () => { throw err; }, restartHandStarted: () => { throw new Error("spawn EACCES"); } });
    expect(await handOverToService(both.d)).toMatchObject({ stage: "activate", restarted: false, message: expect.stringContaining("run `agend start`") });
  });
});

/** A fake process table and fleet.pid for detached-fleet-stop.ts. */
function host(init: { pid?: number; publication?: string | null; start?: string; command?: string } = {}) {
  const h = {
    publication: init.publication === undefined ? `${init.pid ?? 4242}\n` : init.publication,
    alive: true, start: init.start ?? "111", command: init.command ?? "/usr/bin/node /opt/agend/dist/cli.js fleet start",
    signals: [] as string[], exitOn: "SIGTERM" as "SIGTERM" | "SIGKILL" | "never", clock: 0, unlinked: 0,
  };
  const probes: DetachedOwnerProbes = {
    readPidFile: () => h.publication,
    kill0: () => { if (!h.alive) throw Object.assign(new Error("no such process"), { code: "ESRCH" }); },
    exited: () => false,
    start: () => (h.alive ? h.start : null),
    command: () => (h.alive ? h.command : ""),
  };
  const stopDeps = {
    signal: (_pid: number, s: "SIGTERM" | "SIGKILL") => { h.signals.push(s); if (h.exitOn === s || (s === "SIGKILL" && h.exitOn !== "never")) h.alive = false; },
    now: () => h.clock, sleep: async (ms: number) => { h.clock += ms; }, log: () => {},
  };
  return { h, probes, stopDeps };
}

describe("S-246: the proven stop (shared with agend restart)", () => {
  it("SIGTERM, and the fleet gone: no SIGKILL; its publication is cleared only while it is the one first read", async () => {
    const { h, probes, stopDeps } = host();
    const o = detachedFleetOwner("/x/fleet.pid", probes)!;
    expect(o.inspect()).toBe("fleet");
    await stopProvenFleet(o, stopDeps);
    expect(h.signals).toEqual(["SIGTERM"]);
    const io = { readPidFile: () => h.publication, unlink: () => { h.unlinked++; } };
    expect(clearStoppedPublication("/x/fleet.pid", o, io)).toBe(true);
    h.publication = "5555\n";                                              // a new owner published meanwhile
    expect(clearStoppedPublication("/x/fleet.pid", o, io)).toBe(false);
    expect(h.unlinked).toBe(1);
    h.publication = null;                                                  // the old owner removed it itself
    expect(clearStoppedPublication("/x/fleet.pid", o, io)).toBe(true);
  });

  it("a graceful wait of FLEET_STOP_TIMEOUT_MS before SIGKILL (the old install waited two seconds)", async () => {
    const { h, probes, stopDeps } = host();
    h.exitOn = "SIGKILL";
    await stopProvenFleet(detachedFleetOwner("/x/fleet.pid", probes)!, stopDeps);
    expect(h.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.clock).toBeGreaterThanOrEqual(FLEET_STOP_TIMEOUT_MS);
  });

  it("never signals what it can't prove: a recycled PID, a new publication, a process that isn't a fleet", async () => {
    const recycled = host();
    const o = detachedFleetOwner("/x/fleet.pid", recycled.probes)!;
    expect(o.inspect()).toBe("fleet");
    recycled.h.start = "999";                                              // the PID now belongs to another fleet process
    await expect(stopProvenFleet(o, recycled.stopDeps)).rejects.toThrow(/Cannot confirm/);
    expect(recycled.h.signals).toEqual([]);

    const republished = host();
    const o2 = detachedFleetOwner("/x/fleet.pid", republished.probes)!;
    republished.h.publication = "4243\n";
    expect(o2.inspect()).toBe("unknown");
    await expect(stopProvenFleet(o2, republished.stopDeps)).rejects.toThrow();
    expect(republished.h.signals).toEqual([]);

    const other = host({ command: "/usr/bin/vim notes.txt" });
    const o3 = detachedFleetOwner("/x/fleet.pid", other.probes)!;
    await stopProvenFleet(o3, other.stopDeps);                              // "other": not ours, nothing to stop
    expect(other.h.signals).toEqual([]);
  });

  it("no publication: no owner", () => {
    expect(detachedFleetOwner("/x/fleet.pid", host({ publication: null }).probes)).toBeNull();
  });
});

describe("S-246: agend install takes the hand-over", () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const install = cli.slice(cli.indexOf('.command("install")'), cli.indexOf('.command("shortcuts")'));
  const installer = readFileSync(new URL("../src/service-installer.ts", import.meta.url), "utf8");

  it("a fleet (not a Hub) hands over: proven owner, proven stop, the service without a second stop, the fleet again on failure", () => {
    expect(install).toContain("handOverToService({");
    expect(install).toContain("prepare: () => prepareServiceActivation(svcPath)");
    expect(install).toContain("owner: () => stop.detachedFleetOwner(pidPath)");
    expect(install).toContain("stop: owner => stop.stopProvenFleet(owner)");
    expect(install).toContain("activate: () => activateService(svcPath, pidPath, { fleetStopped: true })");
    expect(install).toMatch(/restartHandStarted: \(\) => \{\s*const start = selfCommand\(\["fleet", "start"\]\);/);
    expect(install).not.toMatch(/else activateService\(svcPath, pidPath\);/);
  });

  it("activateService: fleetStopped skips its own SIGTERM-and-wait and the manager proof the caller just made; others prove it first", () => {
    const fn = installer.slice(installer.indexOf("export function activateService("));
    expect(fn).toContain("if (!options.preservePidFile && !options.fleetStopped && existsSync(pidPath)) {");
    expect(fn).toContain("if (!options.fleetStopped) prepareServiceActivation(plistPath);");
    expect(fn.indexOf("prepareServiceActivation(plistPath);")).toBeLessThan(fn.indexOf('process.kill(pid, "SIGTERM")'));
  });

  it("the owner's proof is agend restart's, line for line (restart keeps its own, run by the #1071 rig)", () => {
    const body = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)) + to.length);
    const norm = (text: string) => text.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("//"))
      .join("\n").replace(/detachedProcessStart\(oldPid\)|probes\.start\(pid\)/g, "START").replace(/readProcessCommandLine\(oldPid\)|probes\.command\(pid\)/g, "COMMAND");
    const restart = cli.slice(cli.indexOf("// 4. Detached process tracked by fleet.pid"), cli.indexOf("// 5. Nothing running anywhere"));
    const shared = readFileSync(new URL("../src/detached-fleet-stop.ts", import.meta.url), "utf8");
    const a = norm(body(restart, "const missing = absence();", 'return fleet ? "fleet" : "other";'));
    const b = norm(body(shared, "const missing = absence();", 'return fleet ? "fleet" : "other";'));
    expect(a.split("\n").length).toBeGreaterThan(8);
    expect(b).toBe(a);
    // The signal boundary: proven again before each signal, as restart does.
    expect(shared).toContain('if (now !== "fleet") throw new Error("Detached fleet ownership changed before signalling; refusing the signal");');
    expect(restart).toContain('if (owner !== "fleet") throw new Error("Detached fleet ownership changed before signalling; refusing the signal");');
  });
});

