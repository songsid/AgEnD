/**
 * #2331: a Type=notify unit whose READY systemd refuses (NotifyAccess=main/exec/none — the fleet notifies through a
 * short-lived systemd-notify helper, never as the main process) was silent while TimeoutStartSec was 0 and is killed
 * every 15 minutes since #1122. The fix:
 *   1. the hardening puts NotifyAccess=all into a Type=notify unit file (legacy main/exec/none upgraded, absent added);
 *   2. after a reload, what systemd LOADED decides: a drop-in that still refuses READY gets AgEnD's own later drop-in,
 *      and is asked again;
 *   3. leftovers that change how the fleet starts are named (drop-ins, a user unit beside the system unit, old labels);
 *   4. `agend doctor` shows the loaded unit, its files and the leftovers.
 *
 * Isolation: temp unit files and homes; `systemctl show` and the reload are fakes (no systemd is touched).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureLoadedNotifyAccess, ensureSystemdUnitHardening, notifyRepairLines, NOTIFY_DROPIN, readLoadedNotify,
  serviceLeftovers, serviceTypeIsNotify, writeNotifyDropIn, type ServiceInfo,
} from "../src/service-installer.js";
import { collectDoctorReport } from "../src/doctor.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-2331-")); dirs.push(d); return d; };

/** A unit file in a temp user-unit directory. */
function unit(text: string): string {
  const dir = join(tmp(), ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "com.agend.fleet.service");
  writeFileSync(path, text);
  return path;
}
const service = (body: string) => `[Unit]\nDescription=AgEnD\n\n[Service]\n${body}\n\n[Install]\nWantedBy=default.target\n`;
const lines = (path: string, key: string) => readFileSync(path, "utf8").split("\n").filter((l) => l.startsWith(`${key}=`));

describe("1. the hardening: NotifyAccess=all for a Type=notify unit", () => {
  it("0.0.24-beta's unit (NotifyAccess=main, no TimeoutStartSec): NotifyAccess upgraded, alongside the 15min start", () => {
    const path = unit(service("Type=notify\nNotifyAccess=main\nWatchdogSec=60\nExecStart=/x/agend fleet start"));
    const r = ensureSystemdUnitHardening(path, { dropInPaths: [] });
    expect(r.kind === "ok" && [r.directives.NotifyAccess, r.directives.TimeoutStartSec]).toEqual(["upgraded", "added"]);
    expect(lines(path, "NotifyAccess")).toEqual(["NotifyAccess=all"]);
  });

  it("a hand-written system unit with Type=notify and no NotifyAccess (systemd's default: main): added", () => {
    const path = unit(service("Type=notify\nTimeoutStartSec=0\nExecStart=/usr/bin/agend fleet start"));
    const r = ensureSystemdUnitHardening(path, { dropInPaths: [] });
    expect(r.kind === "ok" && r.directives.NotifyAccess).toBe("added");
    expect(lines(path, "NotifyAccess")).toEqual(["NotifyAccess=all"]);
  });

  it("exec and none are upgraded; all is left (present); a Type=simple unit gets no NotifyAccess at all", () => {
    for (const v of ["exec", "none"]) {
      const path = unit(service(`Type=notify\nNotifyAccess=${v}\nExecStart=/x fleet start`));
      const r = ensureSystemdUnitHardening(path, { dropInPaths: [] });
      expect(r.kind === "ok" && r.directives.NotifyAccess, v).toBe("upgraded");
    }
    const ok = unit(service("Type=notify\nNotifyAccess=all\nExecStart=/x fleet start"));
    const r = ensureSystemdUnitHardening(ok, { dropInPaths: [] });
    expect(r.kind === "ok" && r.directives.NotifyAccess).toBe("present");
    const simple = unit(service("Type=simple\nExecStart=/x fleet start"));
    const s = ensureSystemdUnitHardening(simple, { dropInPaths: [] });
    expect(s.kind === "ok" && "NotifyAccess" in s.directives).toBe(false);
    expect(lines(simple, "NotifyAccess")).toEqual([]);
  });

  it("Type=notify is the [Service] section's last Type, not a word anywhere", () => {
    expect(serviceTypeIsNotify(service("Type=notify\nType=simple"))).toBe(false);
    expect(serviceTypeIsNotify(service("Type=simple\nType=notify"))).toBe(true);
    expect(serviceTypeIsNotify("[Unit]\nType=notify\n[Service]\nExecStart=/x")).toBe(false);
  });
});

/** systemd as a map of loaded properties, with a reload that applies `next` (what the files now say). */
function systemd(loaded: Record<string, string>, next?: Record<string, string>) {
  let state = { ...loaded };
  const reloads: number[] = [];
  return {
    show: (p: string) => (p in state ? state[p]! : null),
    reload: () => { reloads.push(1); if (next) state = { ...state, ...next }; return true; },
    reloads,
  };
}

describe("2. what systemd LOADED: a drop-in that refuses READY gets AgEnD's own later one", () => {
  it("loaded NotifyAccess=all, or not Type=notify: nothing to do, nothing written", () => {
    const writes: string[] = [];
    for (const loaded of [{ Type: "notify", NotifyAccess: "all" }, { Type: "simple", NotifyAccess: "main" }]) {
      const s = systemd(loaded);
      expect(ensureLoadedNotifyAccess("/u/com.agend.fleet.service", s.show, s.reload, (p) => { writes.push(p); return p; })).toEqual({ kind: "fine" });
      expect(s.reloads).toEqual([]);
    }
    expect(writes).toEqual([]);
    expect(ensureLoadedNotifyAccess("/u/x.service", () => null, () => true)).toEqual({ kind: "unknown" });
  });

  it("a drop-in sets main: AgEnD's drop-in is written, systemd reloaded and asked again — repaired", () => {
    const path = unit(service("Type=notify\nNotifyAccess=all\nExecStart=/x fleet start"));
    const s = systemd({ Type: "notify", NotifyAccess: "main", DropInPaths: `${path}.d/override.conf` }, { NotifyAccess: "all" });
    const r = ensureLoadedNotifyAccess(path, s.show, s.reload);
    expect(r).toEqual({ kind: "repaired", path: join(`${path}.d`, NOTIFY_DROPIN), from: "main", dropIns: [`${path}.d/override.conf`] });
    expect(s.reloads).toHaveLength(1);
    expect(readFileSync(join(`${path}.d`, NOTIFY_DROPIN), "utf8")).toMatch(/^# Written by AgEnD \(#2331\)[\s\S]*\n\[Service\]\nNotifyAccess=all\n$/);
    expect(notifyRepairLines(r, "com.agend.fleet", "systemctl --user daemon-reload")[0]).toContain("NotifyAccess=all — systemd had NotifyAccess=main loaded (from");
  });

  it("still refused after AgEnD's drop-in (a later one wins), no unit file, or the drop-in cannot be written: said, with what to do", () => {
    const s = systemd({ Type: "notify", NotifyAccess: "main", DropInPaths: "/u/x.service.d/zzzz.conf" });
    const later = ensureLoadedNotifyAccess("/u/x.service", s.show, s.reload, (p) => `${p}.d/${NOTIFY_DROPIN}`);
    expect(later).toEqual({ kind: "refused", notifyAccess: "main", dropIns: ["/u/x.service.d/zzzz.conf"], detail: "it is still set after AgEnD's own drop-in (a later one wins)" });
    const line = notifyRepairLines(later, "com.agend.fleet", "systemctl --user daemon-reload")[0]!;
    expect(line).toContain("systemd loads NotifyAccess=main for com.agend.fleet (drop-ins: /u/x.service.d/zzzz.conf)");
    expect(line).toContain("restarts it every time TimeoutStartSec runs out (15 minutes). It is still set");
    expect(line).toContain("run `systemctl --user daemon-reload`, then `agend restart`");
    expect(ensureLoadedNotifyAccess(null, systemd({ Type: "notify", NotifyAccess: "exec" }).show, () => true))
      .toMatchObject({ kind: "refused", notifyAccess: "exec", detail: "its unit file is not known here" });
    const denied = ensureLoadedNotifyAccess("/u/x.service", systemd({ Type: "notify", NotifyAccess: "main" }).show, () => true,
      () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(denied).toMatchObject({ kind: "refused", detail: `AgEnD could not write /u/x.service.d/${NOTIFY_DROPIN} (EACCES)` });
    expect(notifyRepairLines({ kind: "fine" }, "u", "r")).toEqual([]);
  });

  it("readLoadedNotify: the drop-ins as a list, the rest as systemd shows them", () => {
    const s = systemd({ Type: "notify", NotifyAccess: "all", TimeoutStartUSec: "15min", FragmentPath: "/u/x.service", DropInPaths: "/a.conf /b.conf" });
    expect(readLoadedNotify(s.show)).toEqual({ type: "notify", notifyAccess: "all", timeoutStart: "15min", fragment: "/u/x.service", dropIns: ["/a.conf", "/b.conf"] });
  });

  it("writeNotifyDropIn makes the directory when there is none", () => {
    const path = unit(service("Type=notify"));
    expect(writeNotifyDropIn(path)).toBe(join(`${path}.d`, NOTIFY_DROPIN));
  });
});

describe("3. leftovers, named and never removed", () => {
  it("drop-ins that set what decides the start (not AgEnD's own, not unrelated ones); a user unit beside the system unit; old labels", () => {
    const home = tmp();
    const d = join(home, ".config", "systemd", "user", "com.agend.fleet.service.d");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "override.conf"), "[Service]\nNotifyAccess=main\nTimeoutStartSec=0\nTimeoutStartSec=infinity\n");
    writeFileSync(join(d, "cpu.conf"), "[Service]\nCPUQuota=50%\n");
    writeFileSync(join(d, NOTIFY_DROPIN), "[Service]\nNotifyAccess=all\n");
    writeFileSync(join(d, "exec.conf"), "[Service]\nExecStart=\nExecStart=/old/agend fleet start\n");
    const dropIns = ["override.conf", "cpu.conf", NOTIFY_DROPIN, "exec.conf", "gone.conf"].map((n) => join(d, n));
    expect(serviceLeftovers({ home, dropIns, systemUnit: null })).toEqual([
      { path: join(d, "override.conf"), detail: "a drop-in sets NotifyAccess=main, TimeoutStartSec=infinity (AgEnD writes none but its own zz-agend-notify.conf); keep it only if you added it on purpose" },
      { path: join(d, "exec.conf"), detail: "a drop-in sets ExecStart=/old/agend fleet start (AgEnD writes none but its own zz-agend-notify.conf); keep it only if you added it on purpose" },
    ]);
    writeFileSync(join(home, ".config", "systemd", "user", "com.agend.fleet.service"), service("Type=notify"));
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, ".config", "systemd", "user", "com.ccd.fleet.service"), service("Type=simple"));
    writeFileSync(join(home, "Library", "LaunchAgents", "com.claude-channel-daemon.plist"), "<plist/>");
    const all = serviceLeftovers({ home, dropIns: [], systemUnit: "agend" });
    expect(all.map((l) => l.path.replace(home, "~"))).toEqual(["~/.config/systemd/user/com.agend.fleet.service", "~/.config/systemd/user/com.ccd.fleet.service", "~/Library/LaunchAgents/com.claude-channel-daemon.plist"]);
    expect(all[0]!.detail).toContain("a user unit beside the system unit agend, which runs the fleet");
    // The user unit is the service itself when there is no system unit: not a leftover.
    expect(serviceLeftovers({ home, dropIns: [], systemUnit: null }).map((l) => l.path.replace(home, "~"))).toEqual(["~/.config/systemd/user/com.ccd.fleet.service", "~/Library/LaunchAgents/com.claude-channel-daemon.plist"]);
  });
});

describe("4. agend doctor: the unit as loaded, its files, the leftovers", () => {
  const result = (status: number, stdout = "") => ({ status, stdout, stderr: "", pid: 1, signal: null, output: [], error: undefined }) as any;
  async function doctor(show: string, home: string, systemUnit: string | null = null) {
    const dataDir = tmp();
    writeFileSync(join(dataDir, "fleet.yaml"), "instances: {}\n");
    const svc: ServiceInfo = { installed: true, path: join(home, ".config/systemd/user/com.agend.fleet.service"), manager: "systemd --user", enabled: true, active: true } as ServiceInfo;
    const calls: string[][] = [];
    const report = await collectDoctorReport(dataDir, svc, {
      env: { HOME: home, TERM: "xterm", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, platform: "linux",
      networkFamily: () => ({ autoSelectFamily: true, attemptTimeoutMs: 2_500 }),
      fetchFleetHealth: async () => ({}), processAlive: () => false, connectSocket: async () => false, systemUnitPath: () => systemUnit,
      run: (file, args) => { calls.push([file, ...args]); return file === "systemctl" && args.includes("show") ? result(0, show) : result(1); },
    });
    return { report, calls };
  }

  it("NotifyAccess=main from a drop-in: an error naming the cause; the files listed; the drop-in a leftover", async () => {
    const home = tmp();
    const d = join(home, ".config/systemd/user/com.agend.fleet.service.d");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "override.conf"), "[Service]\nNotifyAccess=main\n");
    const { report, calls } = await doctor(`Type=notify\nNotifyAccess=main\nTimeoutStartUSec=15min\nFragmentPath=${home}/.config/systemd/user/com.agend.fleet.service\nDropInPaths=${d}/override.conf\n`, home);
    expect(calls).toContainEqual(["systemctl", "--user", "show", "-p", "Type,NotifyAccess,TimeoutStartUSec,FragmentPath,DropInPaths", "com.agend.fleet"]);
    const by = (label: string) => report.checks.filter((c) => c.section === "Service" && c.label === label);
    expect(by("Loaded unit")).toEqual([expect.objectContaining({ status: "error", detail: expect.stringMatching(/^Type=notify NotifyAccess=main TimeoutStartSec=15min — systemd refuses the fleet's ready signal/) })]);
    expect(by("Unit files")[0]!.detail).toBe(`${home}/.config/systemd/user/com.agend.fleet.service, ${d}/override.conf`);
    expect(by("Leftover")).toEqual([expect.objectContaining({ status: "warn", detail: expect.stringContaining(`${d}/override.conf: a drop-in sets NotifyAccess=main (AgEnD writes none but its own zz-agend-notify.conf)`) })]);
  });

  it("a host whose fleet runs under the system unit: that unit is asked about (the system manager), not the user unit", async () => {
    const home = tmp();
    const { report, calls } = await doctor("Type=notify\nNotifyAccess=all\nTimeoutStartUSec=15min\nFragmentPath=/etc/systemd/system/agend.service\nDropInPaths=\n", home, "/etc/systemd/system/agend.service");
    expect(calls).toContainEqual(["systemctl", "show", "-p", "Type,NotifyAccess,TimeoutStartUSec,FragmentPath,DropInPaths", "agend"]);
    expect(calls.some((c) => c.includes("--user") && c.includes("show"))).toBe(false);
    expect(report.checks.filter((c) => c.label === "Unit files")[0]!.detail).toBe("/etc/systemd/system/agend.service");
  });

  it("a healthy unit: ok, no leftovers; systemctl unreadable: no loaded-unit lines (nothing guessed)", async () => {
    const home = tmp();
    const healthy = await doctor("Type=notify\nNotifyAccess=all\nTimeoutStartUSec=15min\nFragmentPath=/f\nDropInPaths=\n", home);
    expect(healthy.report.checks.filter((c) => c.label === "Loaded unit")).toEqual([expect.objectContaining({ status: "ok", detail: "Type=notify NotifyAccess=all TimeoutStartSec=15min" })]);
    expect(healthy.report.checks.filter((c) => c.label === "Leftover")).toEqual([]);
    const unknown = await doctor("", home);
    expect(unknown.report.checks.filter((c) => c.label === "Loaded unit" || c.label === "Unit files")).toEqual([]);
  });
});
