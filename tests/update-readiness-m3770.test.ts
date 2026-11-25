// M-3770 slice 1.2 (design #4480 §4): the pre-flight's classes and checks P1, P3, P4, P5, P7, P9 and P10, on fake
// probes (no npm, systemctl or filesystem of the host is touched), and the launch's refusal words.
import { describe, expect, it, vi } from "vitest";
import { mergePreflight, preflightAllows, preflightClass, preflightRefusal, runUpdatePreflight, summarize, type ReadinessDeps } from "../src/update-readiness.js";
import { setLocale, t } from "../src/locale.js";

const PREFIX = "/home/u/.nvm/versions/node/v22.14.0";
const ROOT = `${PREFIX}/lib/node_modules`;
const PKG = `${ROOT}/@songsid/agend`;
const AGEND = `${PREFIX}/bin/agend`;
const BIN_TARGET = `${PKG}/dist/cli.js`;
const USER_UNIT_CGROUP = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/com.agend.fleet.service\n";

type Opts = {
  packageDir?: string; realPkg?: string | Error; npmRoot?: string; pathAgend?: string | null; pathAgendReal?: string;
  cgroup?: string | null; platform?: NodeJS.Platform; uid?: number; linger?: boolean; reload?: string; notify?: boolean;
  unwritable?: string[]; symlink?: boolean; linkTarget?: string; files?: string[]; initCgroup?: string;
  ping?: { status: number | null; stderr: string; timedOut?: boolean }; registry?: boolean;
  view?: string | null; node?: string | null; env?: NodeJS.ProcessEnv; ppid?: number;
  /** `systemctl show`'s answer (default: a loaded, active unit; NeedDaemonReload from `reload`). */
  unit?: { status: number | null; stdout: string; timedOut?: boolean };
  /** `launchctl print`'s answer (default: the job running). */
  launchd?: { status: number | null; stdout: string };
  /** The clock `now()` reads (default: a fixed instant); `pingGate`: `npm ping` waits for it. */
  clock?: { t: number }; pingGate?: Promise<void>;
};

function rig(o: Opts = {}) {
  const runs: string[] = [];
  const pingEnv: Array<NodeJS.ProcessEnv | undefined> = [];
  const files = new Set(o.files ?? []);
  if (o.linger !== false) files.add("/var/lib/systemd/linger/u");
  const real = (p: string): string => {
    if (p === (o.packageDir ?? PKG)) { if (o.realPkg instanceof Error) throw o.realPkg; return o.realPkg ?? PKG; }
    if (p === PKG) return o.symlink ? (o.linkTarget ?? "/home/u/src/agend") : PKG;
    if (p === `${PKG}/dist/cli.js` || p === AGEND) return BIN_TARGET;
    if (p === o.pathAgend) return o.pathAgendReal ?? BIN_TARGET;
    return p;
  };
  const executable = new Set([`${PREFIX}/bin/npm`, ...(o.pathAgend ? [o.pathAgend] : [])]);
  const d: ReadinessDeps = {
    dispatch: {
      packageDir: o.packageDir ?? PKG,
      execPath: `${PREFIX}/bin/node`,
      pathEnv: `${PREFIX}/bin:/usr/bin`,
      homeDir: "/home/u",
      listDir: async () => [],
      isExecutable: async p => executable.has(p),
      realpath: async p => real(p),
      readFile: async p => { if (p === `${PKG}/package.json`) return JSON.stringify({ name: "@songsid/agend", version: "2.4.0", bin: { agend: "dist/cli.js" } }); throw new Error("ENOENT"); },
      run: async (cmd, args) => {
        runs.push([cmd, ...args].join(" "));
        if (cmd === "npm" && args[0] === "root") return { status: 0, stdout: `${o.npmRoot ?? ROOT}\n` };
        if (cmd === "npm" && args[0] === "prefix") return { status: 0, stdout: `${PREFIX}\n` };
        return { status: 1, stdout: "" };
      },
    },
    platform: o.platform ?? "linux",
    env: o.env ?? { PATH: [o.pathAgend ? o.pathAgend.replace(/\/agend$/, "") : null, `${PREFIX}/bin`, "/usr/bin"].filter(Boolean).join(":"), NOTIFY_SOCKET: o.notify === false ? undefined : "/run/user/1000/systemd/notify" },
    uid: o.uid ?? 1000,
    user: "u",
    ppid: o.ppid ?? 4242,
    ownCgroup: async () => (o.cgroup === undefined ? USER_UNIT_CGROUP : o.cgroup),
    exists: async p => files.has(p),
    writable: async p => !(o.unwritable ?? []).includes(p),
    isSymlink: async p => p === PKG && !!o.symlink,
    realpath: async p => real(p),
    readText: async p => (p === "/proc/1/cgroup" ? (o.initCgroup ?? "0::/init.scope\n") : null),
    run: async (cmd, args, _timeout, env) => {
      runs.push([cmd, ...args].join(" "));
      if (cmd === "systemctl") return { ...(o.unit ?? { status: 0, stdout: `LoadState=loaded\nActiveState=active\nNeedDaemonReload=${o.reload ?? "no"}\n` }), stderr: "" };
      if (cmd === "launchctl") return { ...(o.launchd ?? { status: 0, stdout: "gui/501/com.agend.fleet = {\n\tstate = running\n\tpid = 812\n}\n" }), stderr: "" };
      if (cmd === "npm" && args[0] === "config") return o.registry === false ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: "; \"user\" config from /home/u/.npmrc\n", stderr: "" };
      if (cmd === "npm" && args[0] === "ping") { pingEnv.push(env); if (o.pingGate) await o.pingGate; return { ...(o.ping ?? { status: 0, stderr: "" }), stdout: "" }; }
      if (cmd === "npm" && args[0] === "view") return o.view === null ? { status: 1, stdout: "", stderr: "E404" } : { status: 0, stdout: o.view ?? JSON.stringify({ version: "2.5.0", engines: { node: ">=22.14.0" }, optionalDependencies: {} }), stderr: "" };
      if (cmd === "sh") return o.node === null ? { status: 127, stdout: "", stderr: "" } : { status: 0, stdout: `${o.node ?? "22.14.0"} /usr/bin/node\n`, stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    },
    host: () => ({ platform: "linux", arch: "x64", id: "linux-x64", glibc: "2.35", darwinRelease: null }),
    now: () => o.clock?.t ?? 1_700_000_000_000,
  };
  return { d, runs, pingEnv };
}

/** One check's row without its time (the merge tests below are about the times). */
const byId = (p: { checks: Array<{ id: string; checkedAt?: number }> }, id: string) => {
  const row = p.checks.find(c => c.id === id);
  if (!row) return undefined;
  const { checkedAt: _at, ...rest } = row;
  return rest;
};

describe("M-3770 pre-flight (#4480 §4.1): the classes", () => {
  it("a global install under its user unit, lingering on, writable, the registry up, the target's Node met: self", async () => {
    const { d } = rig();
    const p = await runUpdatePreflight({ target: "2.5.0" }, d);
    expect(p.checks.map(c => [c.id, c.ok])).toEqual([["P1", true], ["P3", true], ["P4", true], ["P5", true], ["P7", true], ["P9", true], ["P10", true]]);
    expect(p.checks.every(c => c.checkedAt === 1_700_000_000_000)).toBe(true);
    expect(p).toMatchObject({ class: "self", pressHere: true, checkedAt: 1_700_000_000_000, target: "2.5.0", install: AGEND });
  });

  it("the worst failing check sets the class; a press needs pressHere, anything unattended needs self", () => {
    const adminOnly = summarize([{ id: "P1", ok: true }, { id: "P3", ok: false, code: "not-service" }], 1);
    expect(adminOnly).toMatchObject({ class: "admin-only", pressHere: true });
    expect([preflightAllows(adminOnly, "press"), preflightAllows(adminOnly, "unattended")]).toEqual([true, false]);
    const noWrite = summarize([{ id: "P4", ok: false, code: "no-write" }], 1);
    expect(noWrite).toMatchObject({ class: "admin-only", pressHere: false });     // §4 P4: no button on the web or in chat
    expect(preflightClass([{ id: "P3", ok: false }, { id: "P9", ok: false }])).toBe("stop");
    // Prism #4483 (2): a partial or empty result is never self — P1, P3, P4 and P9 must be present and pass.
    expect(summarize([], 1).class).toBe("admin-only");
    expect(summarize([{ id: "P1", ok: true }, { id: "P4", ok: true }, { id: "P9", ok: true }], 1).class).toBe("admin-only");
    expect(summarize([{ id: "P1", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P9", ok: true }], 1).class).toBe("self");
  });
});

describe("M-3770 P1: this is the install that runs", () => {
  it("a source checkout is stop (it is not refused today: it updated PATH's global install)", async () => {
    const p = await runUpdatePreflight({}, rig({ packageDir: "/home/u/src/agend", realPkg: "/home/u/src/agend" }).d);
    expect(byId(p, "P1")).toEqual({ id: "P1", ok: false, code: "checkout" });
    expect(p.class).toBe("stop");
    expect(byId(p, "P4")).toBeUndefined();                                         // no proven install: nothing to judge
  });

  it("an unreadable location is stop with its own code; a copy npm does not manage is other-copy", async () => {
    const unreadable = await runUpdatePreflight({}, rig({ realPkg: Object.assign(new Error("EACCES"), { code: "EACCES" }) }).d);
    expect(byId(unreadable, "P1")).toEqual({ id: "P1", ok: false, code: "unreadable" });
    const other = await runUpdatePreflight({}, rig({ npmRoot: "/usr/local/lib/node_modules" }).d);
    expect(byId(other, "P1")).toMatchObject({ ok: false, code: "other-copy", detail: { path: PKG } });
    expect(other.class).toBe("stop");
  });

  it("PATH's agend that is another file is path-shadow — checked before the install now, not after", async () => {
    const p = await runUpdatePreflight({}, rig({ pathAgend: "/usr/local/bin/agend", pathAgendReal: "/usr/local/lib/node_modules/@songsid/agend/dist/cli.js" }).d);
    expect(byId(p, "P1")).toEqual({ id: "P1", ok: false, code: "path-shadow", detail: { path: "/usr/local/bin/agend" } });
    const same = await runUpdatePreflight({}, rig({ pathAgend: "/home/u/bin/agend", pathAgendReal: BIN_TARGET }).d);
    expect(byId(same, "P1")).toEqual({ id: "P1", ok: true });                       // a link to the same file is fine
  });
});

describe("M-3770 P3: the service brings it back", () => {
  it("a detached fleet is admin-only (not-service)", async () => {
    const p = await runUpdatePreflight({}, rig({ cgroup: "0::/user.slice/user-1000.slice/session-3.scope\n", notify: false }).d);
    expect(byId(p, "P3")).toEqual({ id: "P3", ok: false, code: "not-service" });
    expect(p).toMatchObject({ class: "admin-only", pressHere: true });
  });

  it("a user unit without lingering is linger-off, naming the user", async () => {
    const p = await runUpdatePreflight({}, rig({ linger: false }).d);
    expect(byId(p, "P3")).toEqual({ id: "P3", ok: false, code: "linger-off", detail: { user: "u" } });
  });

  it("a system unit needs a root updater; a pending daemon-reload is its own code", async () => {
    const sys = await runUpdatePreflight({}, rig({ cgroup: "0::/system.slice/agend.service\n" }).d);
    expect(byId(sys, "P3")).toEqual({ id: "P3", ok: false, code: "system-unit-not-root" });
    const root = await runUpdatePreflight({}, rig({ cgroup: "0::/system.slice/agend.service\n", uid: 0 }).d);
    expect(byId(root, "P3")).toEqual({ id: "P3", ok: true });
    const { d, runs } = rig({ reload: "yes" });
    expect(byId(await runUpdatePreflight({}, d), "P3")).toEqual({ id: "P3", ok: false, code: "unit-reload-pending" });
    expect(runs).toContain("systemctl --user show com.agend.fleet.service -p LoadState -p ActiveState -p NeedDaemonReload");
  });

  it("macOS: its launchd job, named and running, passes; a hand-run does not", async () => {
    const mac = rig({ platform: "darwin", env: { PATH: `${PREFIX}/bin`, XPC_SERVICE_NAME: "com.agend.fleet" } });
    expect(byId(await runUpdatePreflight({}, mac.d), "P3")).toMatchObject({ id: "P3", ok: true });
    expect(mac.runs).toContain("launchctl print gui/1000/com.agend.fleet");
    const hand = rig({ platform: "darwin", env: { PATH: `${PREFIX}/bin` } });
    expect(byId(await runUpdatePreflight({}, hand.d), "P3")).toMatchObject({ ok: false, code: "not-service" });
  });

  // Prism #4483 (2): a service that can't be proven is never a passing P3, and never self or unattended.
  it.each([
    ["systemctl fails", { unit: { status: 1, stdout: "" } }],
    ["systemctl times out", { unit: { status: null, stdout: "", timedOut: true } }],
    ["systemctl answers nothing", { unit: { status: 0, stdout: "" } }],
    ["the unit isn't loaded", { unit: { status: 0, stdout: "LoadState=not-found\nActiveState=inactive\nNeedDaemonReload=no\n" } }],
    ["the unit is masked (though still running)", { unit: { status: 0, stdout: "LoadState=masked\nActiveState=active\nNeedDaemonReload=no\n" } }],
    ["the unit isn't active", { unit: { status: 0, stdout: "LoadState=loaded\nActiveState=failed\nNeedDaemonReload=no\n" } }],
    ["no unit name in the cgroup (a service, but not which)", { cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice\n" }],
    ["macOS: a parent of 1 without a launchd job (an orphaned hand-start)", { platform: "darwin" as const, ppid: 1, env: { PATH: `${PREFIX}/bin` } }],
    ["macOS: the job named but not running", { platform: "darwin" as const, env: { PATH: `${PREFIX}/bin`, XPC_SERVICE_NAME: "com.agend.fleet" }, launchd: { status: 0, stdout: "state = not running\n" } }],
    ["macOS: launchctl fails", { platform: "darwin" as const, env: { PATH: `${PREFIX}/bin`, XPC_SERVICE_NAME: "com.agend.fleet" }, launchd: { status: 113, stdout: "" } }],
  ] as Array<[string, Opts]>)("unproven service → service-unknown, admin-only, no unattended start: %s", async (_name, o) => {
    const p = await runUpdatePreflight({ localOnly: true }, rig({ notify: true, ...o }).d);
    const p3 = byId(p, "P3") as { code?: string } | undefined;
    // A cgroup without a unit isn't a service by startedByServiceManager at all; everything else is service-unknown.
    expect(["service-unknown", "not-service"]).toContain(p3?.code);
    expect(p.class).toBe("admin-only");
    expect([preflightAllows(p, "press"), preflightAllows(p, "unattended")]).toEqual([true, false]);
  });

  it("a known-good service is self (the controls for the cases above)", async () => {
    const linux = await runUpdatePreflight({ localOnly: true }, rig().d);
    expect([linux.class, byId(linux, "P3")?.ok]).toEqual(["self", true]);
    const mac = await runUpdatePreflight({ localOnly: true }, rig({ platform: "darwin", env: { PATH: `${PREFIX}/bin`, XPC_SERVICE_NAME: "com.agend.fleet" } }).d);
    expect([mac.class, byId(mac, "P3")?.ok]).toEqual(["self", true]);
  });
});

describe("M-3770 P4 and P5: writing the install, and a linked or vendored copy", () => {
  it("an unwritable prefix is admin-only with no press here (sudo in a shell), naming the directory", async () => {
    const p = await runUpdatePreflight({}, rig({ unwritable: [`${PREFIX}/bin`] }).d);
    expect(byId(p, "P4")).toEqual({ id: "P4", ok: false, code: "no-write", detail: { path: `${PREFIX}/bin` } });
    expect(p).toMatchObject({ class: "admin-only", pressHere: false });
  });

  it("a vendored copy inside another project is named as such (and P1 stops it: npm doesn't manage it)", async () => {
    const vendored = "/home/u/proj/node_modules/@songsid/agend";
    const p = await runUpdatePreflight({}, rig({ packageDir: vendored, realPkg: vendored, files: ["/home/u/proj/package.json"] }).d);
    expect(byId(p, "P5")).toEqual({ id: "P5", ok: false, code: "vendored", detail: { path: "/home/u/proj" } });
    expect(byId(p, "P1")).toMatchObject({ ok: false, code: "other-copy" });
    expect(p.class).toBe("stop");
  });

  it("the global entry linked to a development folder is linked (admin-only), a registry install is not", async () => {
    // Node runs a linked package from its real path: the running folder is the development folder the entry links to.
    const linkedRig = rig({ packageDir: "/home/u/src/agend", realPkg: "/home/u/src/agend", symlink: true, linkTarget: "/home/u/src/agend" });
    const p = await runUpdatePreflight({}, linkedRig.d);
    expect(byId(p, "P1")).toEqual({ id: "P1", ok: true });
    expect(byId(p, "P5")).toEqual({ id: "P5", ok: false, code: "linked", detail: { path: "/home/u/src/agend" } });
    expect(p).toMatchObject({ class: "admin-only", pressHere: true });
    // Prism #4483 (1): a linked install is held to PATH's agend too: another install's agend first on PATH is path-shadow.
    const shadowed = rig({ packageDir: "/home/u/src/agend", realPkg: "/home/u/src/agend", symlink: true, linkTarget: "/home/u/src/agend",
      pathAgend: "/usr/local/bin/agend", pathAgendReal: "/usr/local/lib/node_modules/@songsid/agend/dist/cli.js" });
    const ps = await runUpdatePreflight({}, shadowed.d);
    expect(byId(ps, "P1")).toMatchObject({ ok: false, code: "path-shadow", detail: { path: "/usr/local/bin/agend" } });
    expect([ps.class, preflightAllows(ps, "press")]).toEqual(["stop", false]);
    // A checkout that the global entry does NOT link to stays a checkout (stop).
    const other = rig({ packageDir: "/home/u/src/agend", realPkg: "/home/u/src/agend", symlink: true, linkTarget: "/home/u/src/other" });
    expect(byId(await runUpdatePreflight({}, other.d), "P1")).toEqual({ id: "P1", ok: false, code: "checkout" });
    expect(byId(await runUpdatePreflight({}, rig().d), "P5")).toEqual({ id: "P5", ok: true });
  });
});

describe("M-3770 P7, P9, P10", () => {
  it("P7: only a network failure of npm ping is npm-unreachable (stop); a registry without ping says nothing", async () => {
    const down = await runUpdatePreflight({}, rig({ ping: { status: 1, stderr: "npm error code ENOTFOUND\n" } }).d);
    expect(byId(down, "P7")).toEqual({ id: "P7", ok: false, code: "npm-unreachable" });
    expect(down.class).toBe("stop");
    const noPing = await runUpdatePreflight({}, rig({ ping: { status: 1, stderr: "npm error code E404\n" } }).d);
    expect(byId(noPing, "P7")).toEqual({ id: "P7", ok: true });
    const noConfig = await runUpdatePreflight({}, rig({ registry: false }).d);
    expect(byId(noConfig, "P7")).toBeUndefined();                                 // not checked: absent, never ✓
    // Rig S8 (a dead registry host): npm's own retries would outlast any bound — the update's npm bounds go on the ping,
    // and a ping that never answers is unreachable, not a pass. An npm that could not run says nothing.
    const hung = rig({ ping: { status: null, stderr: "", timedOut: true } });
    expect(byId(await runUpdatePreflight({}, hung.d), "P7")).toEqual({ id: "P7", ok: false, code: "npm-unreachable" });
    expect(hung.pingEnv[0]).toMatchObject({ npm_config_fetch_retries: "1", npm_config_fetch_timeout: "30000" });
    expect(byId(await runUpdatePreflight({}, rig({ ping: { status: null, stderr: "" } }).d), "P7")).toBeUndefined();
  });

  it("P9: a container or Windows is stop", async () => {
    expect(byId(await runUpdatePreflight({}, rig({ files: ["/.dockerenv"] }).d), "P9")).toEqual({ id: "P9", ok: false, code: "container" });
    expect(byId(await runUpdatePreflight({}, rig({ initCgroup: "0::/kubepods/besteffort/pod1/abc\n" }).d), "P9")).toMatchObject({ code: "container" });
    const win = await runUpdatePreflight({}, rig({ platform: "win32" }).d);
    expect(byId(win, "P9")).toEqual({ id: "P9", ok: false, code: "windows-runtime" });
    expect(byId(win, "P3")).toBeUndefined();
    expect(win.class).toBe("stop");
  });

  it("P10: a target whose Node this machine can't meet is node-too-old with the two versions; unreadable or no target is absent", async () => {
    const old = await runUpdatePreflight({ target: "2.5.0" }, rig({ node: "20.11.0" }).d);
    expect(byId(old, "P10")).toEqual({ id: "P10", ok: false, code: "node-too-old", detail: { node: "20.11.0", needs: ">=22.14.0" } });
    expect(old.class).toBe("stop");
    expect(byId(await runUpdatePreflight({ target: "2.5.0" }, rig({ view: null }).d), "P10")).toBeUndefined();
    expect(byId(await runUpdatePreflight({}, rig().d), "P10")).toBeUndefined();
    expect(byId(await runUpdatePreflight({ target: "latest" }, rig().d), "P10")).toBeUndefined();
  });

  it("localOnly (a launch's re-proof) asks no network: no npm ping, no npm view", async () => {
    const { d, runs } = rig();
    const p = await runUpdatePreflight({ target: "2.5.0", localOnly: true }, d);
    expect(p.checks.map(c => c.id)).toEqual(["P1", "P3", "P4", "P5", "P9"]);
    expect(runs.filter(r => /^npm (ping|view|config)/.test(r))).toEqual([]);
  });
});

describe("M-3770: the launch's refusal, in words", () => {
  const tr = (key: string, ...args: string[]) => t(key, ...args);
  it("a press is refused by stop or by P4, naming why; unattended is refused by admin-only too", () => {
    setLocale("en");
    try {
      expect(preflightRefusal(summarize([{ id: "P1", ok: false, code: "checkout" }], 1), "press", tr)).toMatch(/^This machine can't be updated from here: this AgEnD runs from a source checkout.*Nothing was changed\.$/);
      expect(preflightRefusal(summarize([{ id: "P4", ok: false, code: "no-write", detail: { path: "/usr/local" } }], 1), "press", tr)).toContain("(/usr/local isn't writable): run `sudo agend update`");
      const service = summarize([{ id: "P3", ok: false, code: "linger-off", detail: { user: "u" } }], 1);
      expect(preflightRefusal(service, "press", tr)).toBeNull();
      expect(preflightRefusal(service, "unattended", tr)).toBe("Updates on this machine need an admin's own press, so it wasn't started automatically: lingering is off for u, so the service may stop mid-update; turn it on with `loginctl enable-linger u`.");
      expect(preflightRefusal(summarize([{ id: "P10", ok: false, code: "node-too-old", detail: { node: "20.11.0", needs: ">=22.14.0" } }], 1), "press", tr)).toContain("the new version needs Node >=22.14.0; this machine has 20.11.0.");
    } finally { setLocale("en"); }
  });

  it("zh-TW words every code (no key falls back to its name)", () => {
    setLocale("zh-TW");
    try {
      const codes = ["checkout", "other-copy", "path-shadow", "unreadable", "not-service", "linger-off", "system-unit-not-root", "unit-reload-pending", "no-write", "linked", "vendored", "npm-unreachable", "container", "windows-runtime", "node-too-old"];
      for (const code of codes) expect(t(`update.preflight.code.${code}`, "x", "y")).not.toContain("update.preflight");
      expect(preflightRefusal(summarize([{ id: "P9", ok: false, code: "container" }], 1), "press", tr)).toBe("這台電腦無法從這裡更新：AgEnD 在容器裡執行；請更新映像檔。 沒有做任何變更。");
    } finally { setLocale("en"); }
  });
});

// Prism #4483 (3): a cached result keeps each row's own age and scope; nothing old is relabelled as fresh.
describe("M-3770: merging a cached pre-flight with a fresher one", () => {
  const full = (at: number, target: string | null, install = AGEND, extra: Array<Record<string, unknown>> = []) => summarize([
    { id: "P1", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P9", ok: true },
    { id: "P7", ok: true }, ...(target ? [{ id: "P10", ok: false, code: "node-too-old", detail: { node: "20.11.0", needs: ">=22.14.0" } }] : []), ...extra,
  ] as never, at, { target, install });
  const local = (at: number, install: string | null = AGEND) => summarize([{ id: "P1", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P9", ok: true }], at, { install });

  it("a launch's local re-proof keeps the cached P7/P10 with their own time; the whole is as old as its oldest row", () => {
    const m = mergePreflight(full(100, "2.5.0"), local(500), "2.5.0");
    expect(m.checks.map(c => [c.id, c.checkedAt])).toEqual([["P1", 500], ["P3", 500], ["P4", 500], ["P7", 100], ["P9", 500], ["P10", 100]]);
    expect(m).toMatchObject({ checkedAt: 100, class: "stop", target: "2.5.0" });
  });

  it("a P10 for another version than the one offered now is dropped, not relabelled; so is P7/P10 of another install", () => {
    const moved = mergePreflight(full(100, "2.5.0"), local(500), "2.6.0");
    expect(moved.checks.map(c => c.id)).not.toContain("P10");
    expect(moved).toMatchObject({ target: null, checkedAt: 100 });                 // P7 still applies (same install)
    const other = mergePreflight(full(100, "2.5.0"), local(500, "/usr/local/bin/agend"), "2.5.0");
    expect(other.checks.map(c => c.id)).toEqual(["P1", "P3", "P4", "P9"]);
    expect(other).toMatchObject({ checkedAt: 500, class: "self" });
  });

  it("a newer cached P10 for another version never wins over the fresh one for the version offered now", () => {
    const fresh = summarize([{ id: "P1", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P9", ok: true }, { id: "P10", ok: true }], 100, { target: "2.6.0", install: AGEND });
    const m = mergePreflight(full(900, "2.5.0"), fresh, "2.6.0");
    expect(m.checks.find(c => c.id === "P10")).toMatchObject({ ok: true, checkedAt: 100 });
    expect(m.target).toBe("2.6.0");
  });

  it("a fresh run's own P10 for a version no longer offered is dropped too", () => {
    const stale = mergePreflight(null, full(100, "2.5.0"), "2.6.0");
    expect(stale.checks.map(c => c.id)).not.toContain("P10");
    expect(stale.target).toBeNull();
    expect(mergePreflight(null, full(100, "2.5.0"), "2.5.0").checks.map(c => c.id)).toContain("P10");
  });

  it("an older run finishing late never overwrites fresher rows (per check, the newer wins)", () => {
    const gate = mergePreflight(full(100, "2.5.0"), local(500), "2.5.0");           // a launch's re-proof at 500
    const lateRefresh = full(300, "2.5.0", AGEND);                                     // a refresh that started earlier
    const m = mergePreflight(gate, lateRefresh, "2.5.0");
    expect(m.checks.find(c => c.id === "P1")?.checkedAt).toBe(500);
    expect(m.checks.find(c => c.id === "P7")?.checkedAt).toBe(300);
  });
});

// Prism #4483 R2: the producer stamps each row when its check finished, not when the whole run ends.
describe("M-3770: a refresh overlapping a launch's re-proof (the real producer, not hand-made rows)", () => {
  it("a refresh that saw P1 pass, then waited on npm ping, never replaces the launch's newer path-shadow refusal", async () => {
    const clock = { t: 100 };
    let release!: () => void;
    const refreshRig = rig({ clock, pingGate: new Promise<void>(r => { release = r; }) });
    const refreshing = runUpdatePreflight({ target: "2.5.0" }, refreshRig.d);        // P1 passes at 100, then waits on the ping
    await vi.waitFor(() => expect(refreshRig.runs.some(r => r.startsWith("npm ping"))).toBe(true));
    clock.t = 110;
    const gate = await runUpdatePreflight({ localOnly: true }, rig({ clock, pathAgend: "/usr/local/bin/agend", pathAgendReal: "/usr/local/lib/node_modules/@songsid/agend/dist/cli.js" }).d);
    let cached = mergePreflight(null, gate, "2.5.0");
    expect(cached.class).toBe("stop");
    clock.t = 200; release();
    const refreshed = await refreshing;
    expect(refreshed.checks.find(c => c.id === "P1")).toMatchObject({ ok: true, checkedAt: 100 });   // when it was seen
    expect(refreshed.checks.find(c => c.id === "P7")).toMatchObject({ ok: true, checkedAt: 200 });
    cached = mergePreflight(cached, refreshed, "2.5.0");
    expect(cached.checks.find(c => c.id === "P1")).toMatchObject({ ok: false, code: "path-shadow", checkedAt: 110 });
    expect(cached.class).toBe("stop");
  });
});
