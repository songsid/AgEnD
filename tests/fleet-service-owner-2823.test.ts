import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
const owner = createRequire(import.meta.url)("../launcher/fleet-service-owner.cjs");
const service = { unit: "com.agend.fleet.service", user: true };
function rig() {
  const home = "/scratch/agend", proc = "/proc/1234";
  const files = new Map<string, string>([
    [home + "/fleet.lock", JSON.stringify({ pid: 1234, role: "fleet", nonce: "nonce" })],
    [proc + "/stat", "1234 (node) S " + [...Array(18).fill("0"), "999"].join(" ")],
    [proc + "/cmdline", "/usr/bin/node\0/pkg/dist/cli.js\0fleet\0start\0--direct\0"],
    ["/pkg/package.json", '{"name":"@songsid/agend"}'],
    [proc + "/environ", "HOME=/scratch\0AGEND_HOME=" + home + "\0"],
    [proc + "/cgroup", "0::/user.slice/session.scope\n"]
  ]);
  let now = 0, alive = true;
  const run = vi.fn(() => ({ status: 0, stdout: "MainPID=0\nControlGroup=\nActiveState=inactive\nSubState=dead\nWorkingDirectory=" + home }));
  const deps = {
    uid: 1000, platform: "linux", env: { HOME: "/scratch", XDG_RUNTIME_DIR: "/run/user/1000" }, locale: "en",
    lstat: vi.fn((p: string) => {
      if (!files.has(p) && p !== "/scratch/.config/systemd/user/com.agend.fleet.service") throw Object.assign(Error("missing"), { code: "ENOENT" });
      return { isFile: () => true };
    }),
    read: (p: string) => { if (!files.has(p)) throw Error("missing " + p); return files.get(p)!; },
    real: (p: string) => p === proc + "/exe" ? "/usr/bin/node" : p === proc + "/cwd" ? "/scratch" : p,
    stat: vi.fn(() => ({ uid: 1000 })), alive: vi.fn(() => alive), run,
    signal: vi.fn((_pid: number) => { alive = false; }), now: () => now,
    sleep: vi.fn(async (ms: number) => { now += ms; }), log: vi.fn()
  };
  return { home, files, proc, deps, run, setAlive: (v: boolean) => { alive = v; }, elapsed: () => now };
}
describe("same-home fleet service ownership", () => {
  it("refuses update before install for the confirmed outside owner in both locales", () => {
    const r = rig();
    expect(owner.inspect(r.home, service, r.deps)).toMatchObject({ kind: "outside", pid: 1234 });
    expect(owner.updateRefusal(r.home, r.deps)).toContain("Run agend restart");
    expect(owner.updateRefusal(r.home, { ...r.deps, locale: "zh-TW" })).toContain("套件與服務設定均未變更");
    expect(r.deps.signal).not.toHaveBeenCalled();
  });
  it("legacy role-less fleet locks keep their documented fleet meaning", () => {
    const r = rig(); r.files.set(r.home + "/fleet.lock", JSON.stringify({ pid: 1234, nonce: "legacy" }));
    expect(owner.inspect(r.home, service, r.deps)).toMatchObject({ kind: "outside" });
  });
  it("normal matching MainPID is accepted; a same-unit wrapper child is never treated as an outside fleet", () => {
    const r = rig();
    r.run.mockReturnValue({ status: 0, stdout: `MainPID=1234\nControlGroup=/unit\nActiveState=active\nSubState=running\nWorkingDirectory=${r.home}` });
    r.files.set(r.proc + "/cgroup", "0::/unit\n");
    expect(owner.updateRefusal(r.home, r.deps)).toBeNull();
    r.run.mockReturnValue({ status: 0, stdout: `MainPID=1233\nControlGroup=/unit\nActiveState=active\nSubState=running\nWorkingDirectory=${r.home}` });
    r.files.set(r.proc + "/cgroup", "0::/unit/child\n");
    expect(owner.inspect(r.home, service, r.deps)).toMatchObject({ kind: "managed" });
  });
  it.each(["foreign-home", "non-agend", "foreign-uid", "unreadable", "manager", "unit-home", "active-other", "malformed-lock"])("%s refuses without signalling", async mode => {
    const r = rig();
    if (mode === "foreign-home") r.files.set(r.proc + "/environ", "AGEND_HOME=/other\0");
    if (mode === "non-agend") r.files.set(r.proc + "/cmdline", "/bin/sleep\0" + "100\0");
    if (mode === "foreign-uid") r.deps.stat.mockReturnValue({ uid: 2000 });
    if (mode === "unreadable") r.files.delete(r.proc + "/environ");
    if (mode === "manager") r.run.mockReturnValue({ status: 1, stdout: "" });
    if (mode === "unit-home") r.run.mockReturnValue({ status: 0, stdout: "MainPID=0\nActiveState=inactive\nSubState=dead\nWorkingDirectory=/other" });
    if (mode === "active-other") r.run.mockReturnValue({ status: 0, stdout: `MainPID=8000\nActiveState=active\nSubState=running\nWorkingDirectory=${r.home}` });
    if (mode === "malformed-lock") r.files.set(r.home + "/fleet.lock", "{}");
    expect(owner.updateRefusal(r.home, r.deps)).toContain("could not be verified");
    await expect(owner.handoff(r.home, service, r.deps)).rejects.toThrow("No replacement was started");
    expect(r.deps.signal).not.toHaveBeenCalled();
  });
  it("missing lock with a live fleet.pid holds; absent/dead fleets and non-systemd platforms keep existing behavior", () => {
    const r = rig(); r.files.delete(r.home + "/fleet.lock");
    expect(owner.updateRefusal(r.home, r.deps)).toBeNull();
    r.files.set(r.home + "/fleet.pid", "1234");
    expect(owner.updateRefusal(r.home, r.deps)).toContain("could not be verified");
    r.setAlive(false); expect(owner.updateRefusal(r.home, r.deps)).toBeNull();
    expect(owner.updateRefusal(r.home, { ...r.deps, platform: "darwin" })).toBeNull();
  });
});
describe("TERM-only service handoff", () => {
  it("drains the proven outside owner; sends TERM to only that PID", async () => {
    const r = rig();
    expect(await owner.handoff(r.home, service, r.deps)).toBe(true);
    expect(r.deps.signal.mock.calls).toEqual([[1234]]);
  });
  it("a hung owner gets the full300s grace and no forced signal or replacement", async () => {
    const r = rig(); r.deps.signal.mockImplementation(() => {});
    await expect(owner.handoff(r.home, service, r.deps)).rejects.toThrow("did not exit within 300 seconds");
    expect(r.elapsed()).toBe(300_000); expect(r.deps.signal.mock.calls).toEqual([[1234]]);
  });
  it.each(["birth", "nonce", "command", "home", "group"])("rechecks %s after output immediately before signalling", async field => {
    const r = rig();
    r.deps.log.mockImplementation(() => {
      if (field === "birth") r.files.set(r.proc + "/stat", r.files.get(r.proc + "/stat")!.replace(/999$/, "1000"));
      if (field === "nonce") r.files.set(r.home + "/fleet.lock", r.files.get(r.home + "/fleet.lock")!.replace("nonce", "changed"));
      if (field === "command") r.files.set(r.proc + "/cmdline", "/bin/sleep\0");
      if (field === "home") r.files.set(r.proc + "/environ", "AGEND_HOME=/other\0");
      if (field === "group") r.files.set(r.proc + "/cgroup", "0::/other.scope\n");
    });
    await expect(owner.handoff(r.home, service, r.deps)).rejects.toThrow("ownership changed");
    expect(r.deps.signal).not.toHaveBeenCalled();
  });
  it("identity changes during the wait hold, never KILL or admit a replacement", async () => {
    const r = rig(); r.deps.signal.mockImplementation(() => {});
    r.deps.sleep.mockImplementation(async () => { r.files.set(r.proc + "/stat", r.files.get(r.proc + "/stat")!.replace(/999$/, "1000")); });
    await expect(owner.handoff(r.home, service, r.deps)).rejects.toThrow("ownership changed");
    expect(r.deps.signal.mock.calls).toEqual([[1234]]);
  });
  it("managed fleet needs no special handoff", async () => {
    const r = rig(); r.run.mockReturnValue({ status: 0, stdout: `MainPID=1234\nControlGroup=/unit\nActiveState=active\nSubState=running\nWorkingDirectory=${r.home}` });
    r.files.set(r.proc + "/cgroup", "0::/unit\n");
    expect(await owner.handoff(r.home, service, r.deps)).toBe(false); expect(r.deps.signal).not.toHaveBeenCalled();
  });
});
describe("review interleavings", () => {
  it.each(["birth", "command"])("a blocking manager query changes %s: no TERM to replacement", async field => {
    const r = rig(); let calls = 0;
    const answer = r.run(); r.run.mockImplementation(() => {
      if (++calls === 2) {
        if (field === "birth") r.files.set(r.proc + "/stat", r.files.get(r.proc + "/stat")!.replace(/999$/, "1000"));
        else r.files.set(r.proc + "/cmdline", "/bin/sleep\0");
      }
      return answer;
    });
    await expect(owner.handoff(r.home, service, r.deps)).rejects.toThrow("ownership changed");
    expect(r.deps.signal).not.toHaveBeenCalled();
  });
  it("managed answer still revalidates the lock AFTER the blocking manager query", () => {
    const r = rig(); r.files.set(r.proc + "/cgroup", "0::/unit\n");
    r.run.mockImplementation(() => {
      r.files.set(r.home + "/fleet.lock", r.files.get(r.home + "/fleet.lock")!.replace("nonce", "different"));
      return { status: 0, stdout: `MainPID=1234\nControlGroup=/unit\nActiveState=active\nSubState=running\nWorkingDirectory=${r.home}` };
    });
    expect(owner.updateRefusal(r.home, r.deps)).toContain("could not be verified");
  });
  it("deleting both records while owner lives cannot admit a replacement", async () => {
    const r = rig(); r.deps.signal.mockImplementation(() => { r.files.delete(r.home + "/fleet.lock"); r.files.delete(r.home + "/fleet.pid"); });
    await expect(owner.handoff(r.home, service, r.deps)).rejects.toThrow("did not exit within 300 seconds");
    expect(r.elapsed()).toBe(300_000); expect(r.deps.signal.mock.calls).toEqual([[1234]]);
  });
  it("a changed captured process still holds after both records disappear", async () => {
    const r = rig(); r.deps.signal.mockImplementation(() => { r.files.delete(r.home + "/fleet.lock"); r.files.delete(r.home + "/fleet.pid"); });
    r.deps.sleep.mockImplementation(async () => { r.files.set(r.proc + "/stat", r.files.get(r.proc + "/stat")!.replace(/999$/, "1000")); });
    await expect(owner.handoff(r.home, service, r.deps)).rejects.toThrow("ownership changed");
    expect(r.deps.signal.mock.calls).toEqual([[1234]]);
  });
  it("records disappear first; replacement waits until the captured process really exits", async () => {
    const r = rig(); r.deps.signal.mockImplementation(() => { r.files.delete(r.home + "/fleet.lock"); });
    r.deps.sleep.mockImplementation(async () => { r.setAlive(false); });
    expect(await owner.handoff(r.home, service, r.deps)).toBe(true);
    expect(r.deps.sleep).toHaveBeenCalledTimes(1);
  });
  it.each(["fleet.lock", "fleet.pid"])("ELOOP on %s is unknown, never absent", file => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2823-loop-"));
    try { symlinkSync(file, join(dir, file)); expect(owner.inspect(dir, service).kind).toBe("unknown"); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["fleet.lock", "fleet.pid"])("EACCES on %s is unknown, never absent", file => {
    const r = rig(); r.files.delete(r.home + "/fleet.lock"); const original = r.deps.lstat.getMockImplementation()!;
    r.deps.lstat.mockImplementation(p => { if (p === r.home + "/" + file) throw Object.assign(Error("denied"), { code: "EACCES" }); return original(p); });
    expect(owner.updateRefusal(r.home, r.deps)).toContain("could not be verified");
  });
});
it("CLI and target installer enforce the shared proof before install and before restart", () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const install = readFileSync(new URL("../launcher/agend-install.cjs", import.meta.url), "utf8");
  expect(cli.indexOf("fleetServiceOwner.updateRefusal")).toBeGreaterThan(0);
  expect(cli.indexOf("fleetServiceOwner.handoff")).toBeGreaterThan(0);
  expect(install.indexOf("fleetServiceOwner.updateRefusal")).toBeGreaterThan(0);
  expect(cli.indexOf("fleetServiceOwner.updateRefusal")).toBeLessThan(cli.indexOf("preflight.preflightUpdate"));
  expect(cli.indexOf("fleetServiceOwner.handoff")).toBeLessThan(cli.indexOf("const restartOutcome = systemdRestartOutcome"));
  expect(install.indexOf("fleetServiceOwner.updateRefusal")).toBeLessThan(install.indexOf('var admitted = admit('));
  expect(install.indexOf("var ownerRecheck")).toBeLessThan(install.indexOf("var fixed = repair("));
  expect(install).not.toContain("the previous service was never stopped");
});
