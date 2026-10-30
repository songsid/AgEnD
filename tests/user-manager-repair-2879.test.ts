/**
 * #2879 (user, 2026-10-30): `agend restart` repairs the user manager first. The WSL host had user@0 active but
 * /run/user/0/systemd/ gone (WSL replaced the runtime dir): every restart was refused ("Cannot reach the user service
 * manager") because the only repair, `systemctl start user@0`, does nothing on an active unit.
 * Isolation: injected systemctl and file system; nothing is run.
 */
import { describe, expect, it } from "vitest";
import { repairUserManager, type UserManagerRepairDeps } from "../src/user-systemd.js";

function host(o: { uid?: number; state?: string; socket?: boolean; comesBackAfter?: number | null; fails?: string }) {
  const calls: string[] = [];
  let socket = o.socket ?? false, slept = 0, cameBackAt: number | null = null;
  const deps: UserManagerRepairDeps = {
    uid: o.uid ?? 0, runtime: `/run/user/${o.uid ?? 0}`,
    exists: p => p === `/run/user/${o.uid ?? 0}/systemd/private` && socket,
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args[0] === "is-active") return { status: o.state === "active" ? 0 : 3, stdout: `${o.state ?? "active"}\n` };
      if (o.fails && o.fails.split("+").includes(args[0]!)) return { status: 1, stdout: "" };
      cameBackAt = slept;
      return { status: 0, stdout: "" };
    },
    sleep: ms => { slept += ms; if (o.comesBackAfter != null && cameBackAt !== null && slept - cameBackAt >= o.comesBackAfter) socket = true; if (o.state === "activating" && o.comesBackAfter != null && slept >= o.comesBackAfter) socket = true; },
  };
  return { deps, calls };
}

describe("repairUserManager", () => {
  it("socket present: nothing asked, nothing done", () => {
    const h = host({ socket: true });
    expect(repairUserManager(h.deps)).toEqual({ kind: "healthy" });
    expect(h.calls).toEqual([]);
  });
  it("root, user@0 active, systemd/ gone (the WSL host): restarted, waited for the socket", () => {
    const h = host({ state: "active", comesBackAfter: 1500 });
    expect(repairUserManager(h.deps)).toEqual({ kind: "restarted", ready: true, unit: "user@0.service", socket: "/run/user/0/systemd/private", waitedMs: 1500 });
    expect(h.calls).toEqual(["systemctl is-active user@0.service", "systemctl restart user@0.service"]);
  });
  it("root, user@0 not running (systemd slow at boot): started, not restarted", () => {
    const h = host({ state: "inactive", comesBackAfter: 500 });
    expect(repairUserManager(h.deps)).toMatchObject({ kind: "started", ready: true });
    expect(h.calls).toEqual(["systemctl is-active user@0.service", "systemctl start user@0.service"]);
  });
  it("root, still starting: only waited for (never restarted mid-start)", () => {
    const h = host({ state: "activating", comesBackAfter: 750 });
    expect(repairUserManager(h.deps)).toMatchObject({ kind: "started", ready: true, waitedMs: 750 });
    expect(h.calls).toEqual(["systemctl is-active user@0.service"]);
  });
  it.each([["active", "sudo systemctl restart user@1000.service"], ["inactive", "sudo systemctl start user@1000.service"], ["failed", "sudo systemctl start user@1000.service"]])(
    "a user who is not root (%s): never sudo'd, the exact command said", (state, command) => {
    const h = host({ uid: 1000, state });
    expect(repairUserManager(h.deps)).toEqual({ kind: "needs-root", command, socket: "/run/user/1000/systemd/private", active: state === "active" });
    expect(h.calls).toEqual(["systemctl is-active user@1000.service"]);
  });
  it("the restart fails on the old manager's cgroup (219/CGROUP): reset-failed, then started", () => {
    const h = host({ state: "active", fails: "restart", comesBackAfter: 500 });
    expect(repairUserManager(h.deps)).toMatchObject({ kind: "restarted", ready: true });
    expect(h.calls).toEqual(["systemctl is-active user@0.service", "systemctl restart user@0.service", "systemctl reset-failed user@0.service", "systemctl start user@0.service"]);
  });
  it("restart and the start after it both fail: failed, with what was run", () => {
    const h = host({ state: "active", fails: "restart+start" });
    expect(repairUserManager(h.deps)).toEqual({ kind: "failed", command: "systemctl restart user@0.service", unit: "user@0.service" });
  });
  it("the socket never comes back: not ready, after the bounded wait", () => {
    const h = host({ state: "active", comesBackAfter: null });
    expect(repairUserManager(h.deps, { waitMs: 2000 })).toMatchObject({ kind: "restarted", ready: false, waitedMs: 2000 });
  });
});
