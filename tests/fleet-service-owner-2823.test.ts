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
  let alive = true;
  const run = vi.fn(() => ({ status: 0, stdout: "MainPID=0\nControlGroup=\nActiveState=inactive\nSubState=dead\nWorkingDirectory=" + home }));
  const deps = {
    uid: 1000, platform: "linux", env: { HOME: "/scratch", XDG_RUNTIME_DIR: "/run/user/1000" }, locale: "en",
    lstat: vi.fn((p: string) => {
      if (!files.has(p) && p !== "/scratch/.config/systemd/user/com.agend.fleet.service") throw Object.assign(Error("missing"), { code: "ENOENT" });
      return { isFile: () => true };
    }),
    read: (p: string) => { if (!files.has(p)) throw Error("missing " + p); return files.get(p)!; },
    real: (p: string) => p === proc + "/cwd" ? "/scratch" : p,
    link: vi.fn((p: string) => { if (p !== proc + "/exe") throw Error("not a link " + p); return "/usr/bin/node"; }),
    stat: vi.fn(() => ({ uid: 1000 })), alive: vi.fn(() => alive), run,
    signal: vi.fn()
  };
  return { home, files, proc, deps, run, setAlive: (v: boolean) => { alive = v; } };
}
describe("same-home fleet service ownership", () => {
  it("refuses update before install for the confirmed outside owner in both locales", () => {
    const r = rig();
    expect(owner.inspect(r.home, service, r.deps)).toMatchObject({ kind: "outside", pid: 1234 });
    expect(owner.updateRefusal(r.home, r.deps)).toContain("Run kill 1234 to request a normal stop, confirm that process has exited, then run agend start and retry agend update");
    expect(owner.updateRefusal(r.home, { ...r.deps, locale: "zh-TW" })).toContain("套件與服務設定均未變更");
    expect(r.deps.signal).not.toHaveBeenCalled();
  });
  it("a fleet whose private runtime was replaced by the update (exe link \" (deleted)\") is still the unit's own fleet", () => {
    const r = rig();
    r.run.mockReturnValue({ status: 0, stdout: `MainPID=1234\nControlGroup=/unit\nActiveState=active\nSubState=running\nWorkingDirectory=${r.home}` });
    r.files.set(r.proc + "/cgroup", "0::/unit\n");
    r.deps.link.mockReturnValue("/lib/node_modules/@songsid/.agend-fSEyCO84/node_modules/@songsid/agend-node-linux-x64/bin/node (deleted)");
    expect(owner.inspect(r.home, service, r.deps)).toMatchObject({ kind: "managed", pid: 1234, mainPid: 1234 });
    expect(owner.restartRefusal(r.home, service, r.deps)).toBeNull();
    r.deps.link.mockReturnValue("/usr/bin/python3 (deleted)");
    expect(owner.inspect(r.home, service, r.deps)).toMatchObject({ kind: "unknown" });
  });
  it("legacy role-less fleet locks keep their documented fleet meaning", () => {
    const r = rig(); r.files.set(r.home + "/fleet.lock", JSON.stringify({ pid: 1234, nonce: "legacy" }));
    expect(owner.inspect(r.home, service, r.deps)).toMatchObject({ kind: "outside" });
  });
  it("normal matching MainPID is accepted; a different MainPID holds even in the same cgroup", () => {
    const r = rig();
    r.run.mockReturnValue({ status: 0, stdout: `MainPID=1234\nControlGroup=/unit\nActiveState=active\nSubState=running\nWorkingDirectory=${r.home}` });
    r.files.set(r.proc + "/cgroup", "0::/unit\n");
    expect(owner.updateRefusal(r.home, r.deps)).toBeNull();
    r.run.mockReturnValue({ status: 0, stdout: `MainPID=1233\nControlGroup=/unit\nActiveState=active\nSubState=running\nWorkingDirectory=${r.home}` });
    r.files.set(r.proc + "/cgroup", "0::/unit/child\n");
    expect(owner.inspect(r.home, service, r.deps)).toMatchObject({ kind: "unknown" });
  });
  it.each(["foreign-home", "non-agend", "foreign-uid", "unreadable", "manager", "unit-home", "active-other", "malformed-lock"])("%s refuses without signalling", mode => {
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
    expect(owner.restartRefusal(r.home, service, r.deps)).toContain("Nothing was signalled or started.");
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
describe("read-only refusal", () => {
  it.each(["en", "zh-TW"])("restart names the verified owner and manual steps (%s)", locale => {
    const r = rig();
    const line = owner.restartRefusal(r.home, service, { ...r.deps, locale });
    expect(line).toBe(locale === "en"
      ? "Restart not started: fleet PID 1234 is running outside com.agend.fleet.service. Run kill 1234 to request a normal stop, confirm that process has exited, then run agend start. Nothing was signalled or started."
      : "尚未開始重新啟動：Fleet（PID 1234）正在 com.agend.fleet.service 之外執行。請執行 kill 1234 要求正常停止，確認該程序已結束，再執行 agend start。未傳送任何訊號，也未啟動任何程序。");
    expect(r.deps.signal).not.toHaveBeenCalled();
    expect(r.run.mock.calls).toHaveLength(1);
    expect(owner.handoff).toBeUndefined();
  });
  it("unknown ownership never recommends killing the unproven recorded PID", () => {
    const r = rig(); r.files.set(r.proc + "/cmdline", "/bin/sleep\0");
    for (const locale of ["en", "zh-TW"]) {
      const options = { ...r.deps, locale };
      for (const line of [owner.updateRefusal(r.home, options), owner.restartRefusal(r.home, service, options)]) {
        expect(line).toContain("kill PID");
        expect(line).not.toContain("kill 1234");
      }
    }
    expect(r.deps.signal).not.toHaveBeenCalled();
  });
  it.each(["birth", "command"])("a blocking manager query changes %s: ownership stays unknown", field => {
    const r = rig(); const answer = r.run();
    r.run.mockImplementation(() => {
      if (field === "birth") r.files.set(r.proc + "/stat", r.files.get(r.proc + "/stat")!.replace(/999$/, "1000"));
      else r.files.set(r.proc + "/cmdline", "/bin/sleep\0");
      return answer;
    });
    expect(owner.restartRefusal(r.home, service, r.deps)).toContain("ownership could not be verified");
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
  expect(cli.indexOf("fleetServiceOwner.restartRefusal")).toBeGreaterThan(0);
  expect(install.indexOf("fleetServiceOwner.updateRefusal")).toBeGreaterThan(0);
  expect(cli.indexOf("fleetServiceOwner.updateRefusal")).toBeLessThan(cli.indexOf("preflight.preflightUpdate"));
  expect(cli.indexOf("fleetServiceOwner.restartRefusal")).toBeLessThan(cli.indexOf("const result = ensureSystemdUnitHardening"));
  expect(cli).not.toContain("fleetServiceOwner.handoff");
  expect(install.indexOf("fleetServiceOwner.updateRefusal")).toBeLessThan(install.indexOf('var admitted = admit('));
  expect(install.indexOf("var ownerRecheck")).toBeLessThan(install.indexOf("var fixed = repair("));
  expect(install).not.toContain("the previous service was never stopped");
});

describe("hybrid and v1 cgroup hosts (WSL): the fleet under its user unit is still managed", () => {
  const unit = "/user.slice/user-0.slice/user@0.service/app.slice/com.agend.fleet.service";
  const hostWith = (cgroupText: string) => {
    const r = rig();
    r.run.mockReturnValue({ status: 0, stdout: `MainPID=1234\nControlGroup=${unit}\nActiveState=active\nSubState=running\nWorkingDirectory=${r.home}` });
    r.files.set(r.proc + "/cgroup", cgroupText);
    return r;
  };
  const managedWith = (cgroupText: string) => { const r = hostWith(cgroupText); return owner.inspect(r.home, service, r.deps); };
  // A hybrid host's /proc/<pid>/cgroup, as systemd 249 lays it out (v1 controllers, name=systemd, the unified 0:: row).
  const hybrid = ["12:freezer:/", "11:devices:" + unit, "10:memory:" + unit, "9:pids:" + unit, "5:cpu,cpuacct:" + unit,
    "1:name=systemd:" + unit, "0::" + unit, ""].join("\n");
  it("hybrid (both 0:: and name=systemd): managed — the field host's refusal (update_unknown) is gone", () => {
    expect(managedWith(hybrid)).toMatchObject({ kind: "managed", pid: 1234, mainPid: 1234 });
    const r = hostWith(hybrid);
    expect(owner.updateRefusal(r.home, r.deps)).toBeNull();
    expect(owner.restartRefusal(r.home, service, r.deps)).toBeNull();
  });
  it("pure v1: the name=systemd row (alone, or beside an unused 0::/)", () => {
    expect(managedWith(["4:pids:" + unit, "1:name=systemd:" + unit, ""].join("\n"))).toMatchObject({ kind: "managed" });
    expect(managedWith(["1:name=systemd:" + unit, "0::/", ""].join("\n"))).toMatchObject({ kind: "managed" });
  });
  it("the 0:: row wins on a hybrid host: outside the unit there, not managed (never outside-proven either)", () => {
    expect(managedWith(["1:name=systemd:" + unit, "0::/user.slice/session-c4.scope", ""].join("\n")).kind).toBe("unknown");
  });
  it("two rows of one kind, or no systemd row at all: unknown, as before", () => {
    expect(managedWith(["0::" + unit, "0::" + unit, ""].join("\n")).kind).toBe("unknown");
    expect(managedWith(["1:name=systemd:" + unit, "2:name=systemd:" + unit, ""].join("\n")).kind).toBe("unknown");
    expect(managedWith(["4:pids:" + unit, ""].join("\n")).kind).toBe("unknown");
  });
});
