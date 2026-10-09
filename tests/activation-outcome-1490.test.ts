import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateService } from "../src/service-activation.js";
import { activationWorld } from "./support/activation-world-1490.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function world() { const root = mkdtempSync(join(tmpdir(), "agend-activation1490-")); roots.push(root); return activationWorld(root); }
const manager = (w: ReturnType<typeof world>) => ({ kind: "systemd" as const, user: true, unit: "private", unitPath: w.unitPath });

describe("#1490 restart outcomes and stopped systemd rollback", () => {
  it("a confirmed restart remains successful", () => {
    const w = world(); w.setRestart("restarted");
    expect(activateService(manager(w), w.verified, w.deps)).toEqual({ ok: true, via: "restart" });
    expect(w.calls.filter(x => x === "restart")).toHaveLength(1); expect(w.calls).not.toContain("restore-package");
  });
  it("a pending restart is not activation success and preserves every repair copy", () => {
    const w = world(); w.setRestart("pending");
    expect(activateService(manager(w), w.verified, w.deps)).toMatchObject({ ok: false, pending: true, stopped: false });
    expect(w.version()).toBe("2.2.0"); expect(existsSync(w.preimage.dir)).toBe(true); expect(existsSync(w.olderBackup)).toBe(true);
    expect(w.calls).not.toContain("restore-package"); expect(w.calls).not.toContain("systemctl --user stop private");
  });
  it("a failed verified launch restores the package and loaded unit before restarting the previously running fleet", () => {
    const w = world();
    expect(activateService(manager(w), w.verified, w.deps)).toMatchObject({ ok: false, message: expect.stringContaining("previous service is running") });
    expect(w.version()).toBe("2.1.12"); expect(readFileSync(w.unitPath, "utf8")).toBe(w.oldUnit);
    const stop = w.calls.indexOf("systemctl --user stop private"), restored = w.calls.indexOf("restore-package"), start = w.calls.indexOf("systemctl --user start private");
    expect(stop).toBeGreaterThan(-1); expect(restored).toBeGreaterThan(stop); expect(start).toBeGreaterThan(restored);
    expect(w.state.pid).toBe(222); expect(w.calls.filter(x => x === "restart")).toHaveLength(1);
  });
  it.each(["failed", "pending"] as const)("detached %s never reports successful activation or guesses that replacement is safe", result => {
    const w = world(); w.setRestart(result);
    expect(activateService({ kind: "detached" }, w.verified, w.deps)).toMatchObject({ ok: false });
    expect(w.version()).toBe("2.2.0"); expect(w.calls).not.toContain("restore-package");
  });
  it("the stopped proof rejects an active replacement and retains its package", () => {
    const w = world();
    w.setHook((command, args) => { if (command === "busctl" && args.at(-1) === "ActiveState" && w.calls.includes("restart")) Object.assign(w.state, { active: "active", sub: "running", pid: 999 }); });
    expect(activateService(manager(w), w.verified, w.deps)).toMatchObject({ ok: false });
    expect(w.version()).toBe("2.2.0"); expect(w.calls).not.toContain("restore-package"); expect(w.calls).not.toContain("systemctl --user stop private");
  });
  it("a later unit writer is preserved instead of rolling back its service", () => {
    const w = world();
    w.setHook((command, args) => { if (command === "busctl" && args.at(-1) === "ActiveState" && w.calls.includes("restart")) writeFileSync(w.unitPath, "[Service]\nExecStart=/operator/new-owner\n"); });
    expect(activateService(manager(w), w.verified, w.deps)).toMatchObject({ ok: false });
    expect(w.version()).toBe("2.2.0"); expect(readFileSync(w.unitPath, "utf8")).toContain("/operator/new-owner"); expect(w.calls).not.toContain("restore-package");
    expect(w.calls).not.toContain("systemctl --user stop private");
  });
  it.each([
    ["pending restart job", { job: 1 }], ["control process", { control: 100 }], ["remaining main process", { pid: 100 }],
    ["auto-restart", { active: "activating", sub: "auto-restart" }], ["unknown substate", { sub: "unknown" }],
  ])("%s after failure is uncertainty, not a stopped owner", (_name, state) => {
    const w = world(); w.setHook((c, a) => { if (c === "busctl" && a.at(-1) === "ActiveState" && w.calls.includes("restart")) Object.assign(w.state, state); });
    const result = activateService(manager(w), w.verified, w.deps);
    expect(result.ok).toBe(false); expect(w.version()).toBe("2.2.0"); expect(w.calls).not.toContain("restore-package");
    expect(w.calls).not.toContain("systemctl --user stop private");
  });
  it("a failed stop barrier preserves the new package", () => {
    const w = world(); w.setStopStatus(1);
    expect(activateService(manager(w), w.verified, w.deps).ok).toBe(false);
    expect(w.calls).not.toContain("restore-package"); expect(w.version()).toBe("2.2.0");
  });
  it("a different loaded target during the stop barrier cannot authorize package restoration", () => {
    const w = world(); w.setHook((c, a) => {
      if (c === "systemctl" && a.includes("stop")) w.setLoadedArgv(["/operator/replacement", "fleet", "start"]);
    });
    expect(activateService(manager(w), w.verified, w.deps).ok).toBe(false);
    expect(w.calls).not.toContain("restore-package"); expect(w.version()).toBe("2.2.0");
  });
  it("a previously stopped service is restored and left stopped", () => {
    const w = world(); Object.assign(w.state, { active: "inactive", sub: "dead", pid: 0 });
    expect(activateService(manager(w), w.verified, w.deps)).toMatchObject({ ok: false, stopped: true });
    expect(w.version()).toBe("2.1.12"); expect(w.calls).not.toContain("systemctl --user start private");
  });
  it("a new interpreter environment after the stop barrier refuses recovery", () => {
    const w = world(); w.setHook((c, a) => {
      if (c === "systemctl" && a.includes("stop")) w.setManagerEnv(["AGEND_NODE=/operator/node"]);
    });
    expect(activateService(manager(w), w.verified, w.deps).ok).toBe(false);
    expect(w.calls).not.toContain("restore-package"); expect(w.version()).toBe("2.2.0");
  });
  it("unknown previous ownership cannot authorize recovery", () => {
    const w = world(); w.state.job = 1;
    expect(activateService(manager(w), w.verified, w.deps).ok).toBe(false);
    expect(w.version()).toBe("2.2.0"); expect(w.calls).not.toContain("restore-package");
  });
  it.each([{ killMode: "none" }, { killMode: "process" }, { sendSigkill: false }, { type: "forking" }])("custom stop tracking refuses automatic recovery without rewriting settings (%j)", mode => {
    const w = world(); Object.assign(w.state, mode);
    expect(activateService(manager(w), w.verified, w.deps).ok).toBe(false);
    expect(w.calls).not.toContain("restore-package"); expect(w.calls).not.toContain("systemctl --user stop private");
    expect(w.version()).toBe("2.2.0"); expect(w.state).toMatchObject(mode);
  });
  it("a loaded drop-in that disagrees with the old unit cannot authorize recovery", () => {
    const w = world(); writeFileSync(w.unitPath, "[Service]\nExecStart=/operator/different\n");
    expect(activateService(manager(w), w.verified, w.deps).ok).toBe(false);
    expect(w.version()).toBe("2.2.0"); expect(w.calls).not.toContain("restore-package");
  });
  it("failed checked package restoration does not load or start the old service", () => {
    const w = world(); w.deps.systemdRecovery.restorePackage = () => ({ ok: false, message: "private injected restore failure" });
    const result = activateService(manager(w), w.verified, w.deps);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("restore failure") });
    expect(readFileSync(w.unitPath, "utf8")).toBe(w.newUnit); expect(w.calls).not.toContain("systemctl --user start private");
  });
  it("a real partial package restore refuses unit restoration/start and retains the replaced repair tree", () => {
    const w = world(), bin = join(w.prefix, "bin/agend"); unlinkSync(bin); mkdirSync(bin);
    const result = activateService(manager(w), w.verified, w.deps);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Package restore failed") });
    expect(w.version()).toBe("2.1.12"); expect(existsSync(join(w.preimage.dir, "replaced"))).toBe(true);
    expect(w.calls).not.toContain("write-unit"); expect(w.calls).not.toContain("systemctl --user start private");
    expect(readFileSync(w.unitPath, "utf8")).toBe(w.newUnit);
  });
  it("a newer unit written during package restoration survives the compensation", () => {
    const w = world(); w.deps.systemdRecovery.restorePackage = () => {
      const back = w.restore(); writeFileSync(w.unitPath, "[Service]\nExecStart=/operator/new-owner\n"); return back;
    };
    expect(activateService(manager(w), w.verified, w.deps)).toMatchObject({ ok: false, message: expect.stringContaining("incomplete") });
    expect(w.version()).toBe("2.1.12"); expect(readFileSync(w.unitPath, "utf8")).toContain("/operator/new-owner");
    expect(w.calls).not.toContain("write-unit"); expect(w.calls).not.toContain("systemctl --user start private");
  });
  it("a program availability check cannot publish a new owner before the final start proof", () => {
    const w = world(), executable = w.deps.isExecutable;
    w.deps.isExecutable = path => {
      if (w.calls.includes("restore-package") && path === w.oldNode) w.state.job = 9;
      return executable(path);
    };
    expect(activateService(manager(w), w.verified, w.deps).ok).toBe(false);
    expect(w.calls).not.toContain("systemctl --user start private");
  });
  it.each(["reload", "start", "running proof"])("failed recovery %s is reported as incomplete, never success", phase => {
    const w = world();
    w.setHook((c, a) => {
      if (!w.calls.includes("restore-package")) return;
      if (phase === "reload") w.setReloadStatus(1);
      if (phase === "start") w.setStartStatus(1);
      if (phase === "running proof" && c === "busctl" && a.at(-1) === "ActiveState" && w.calls.includes("systemctl --user start private")) w.state.job = 1;
    });
    expect(activateService(manager(w), w.verified, w.deps)).toMatchObject({ ok: false, message: expect.stringContaining("incomplete") });
    expect(w.version()).toBe("2.1.12");
  });
  it("system-manager recovery uses only its selected system scope", () => {
    const w = world();
    expect(activateService({ ...manager(w), user: false }, w.verified, w.deps)).toMatchObject({ ok: false, message: expect.stringContaining("previous service is running") });
    expect(w.calls).toContain("systemctl stop private"); expect(w.calls).toContain("systemctl start private");
    expect(w.calls.some(c => c.includes("--user"))).toBe(false);
  });
  it("an already-installed retry without a preimage does not invent recovery authority", () => {
    const w = world(); const { systemdRecovery: _recovery, restorePackage: _restore, ...deps } = w.deps;
    expect(activateService(manager(w), w.verified, deps)).toMatchObject({ ok: false });
    expect(w.version()).toBe("2.2.0"); expect(w.calls).not.toContain("restore-package");
  });
});
