/**
 * #2015 part 2 (the user's choice (b)): while host memory is elevated or critical, the processes holding the most
 * memory in the fleet's service and whose they are (an instance, the fleet, tmux) go to the pressure log, /health and
 * the dashboard — never to chat (#1712 stands). A fake /proc and cgroup tree; nothing reads the real host's processes,
 * the live tmux server is never asked, and nothing allocates memory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom } from "./helpers/mini-dom.js";
import { topMemoryHogs, MEMORY_HOGS_SCAN_MAX } from "../src/memory-hogs.js";
import { FleetManager } from "../src/fleet-manager.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { setLocale } from "../src/locale.js";

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
}));

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); setLocale("en"); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "hogs-2015-")); dirs.push(d); return d; };

/** A fake /proc: pid → [name, rss kB, ppid]; the fleet's cgroup line; the cgroup's procs. */
function proc(procs: Record<number, [string, number | null, number]>, opts: { cgroup?: string | null; inCgroup?: number[] } = {}) {
  const root = tmp(), cgRoot = tmp();
  for (const [pid, [name, rss, ppid]] of Object.entries(procs)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, "status"), `Name:\t${name}\nPPid:\t${ppid}\n${rss === null ? "" : `VmRSS:\t ${rss} kB\n`}`);
  }
  const cg = opts.cgroup === undefined ? "/user.slice/user-1000.slice/user@1000.service/app.slice/com.agend.fleet.service" : opts.cgroup;
  if (cg !== null) writeFileSync(join(root, "100", "cgroup"), `0::${cg}\n`);
  if (cg && opts.inCgroup) { mkdirSync(join(cgRoot, cg), { recursive: true }); writeFileSync(join(cgRoot, cg, "cgroup.procs"), opts.inCgroup.join("\n") + "\n"); }
  return { procRoot: root, cgroupRoot: cgRoot };
}

// 100 the fleet, 200 tmux server, 300/400 pane shells (dev-a, web), 301 dev-a's CLI, 302 its python, 401 web's CLI.
const TREE: Record<number, [string, number | null, number]> = {
  100: ["node", 180_000, 1], 200: ["tmux: server", 9_000, 100], 300: ["bash", 4_000, 200], 301: ["claude", 450_000, 300],
  302: ["python3", 19_000_000, 301], 400: ["bash", 4_000, 200], 401: ["claude", 600_000, 400], 500: ["kworker", null, 2],
};
const PANES = [{ pid: 300, window: "dev-a" }, { pid: 400, window: "web" }];
const base = { fleetPid: 100, tmuxServerPid: 200, panes: PANES, isInstance: (w: string) => w === "dev-a" || w === "web" };

describe("topMemoryHogs: the largest processes of the service and their owners", () => {
  it("from the cgroup: largest first, a tool child attributed to its instance through its CLI and pane", async () => {
    const fs = proc(TREE, { inCgroup: [100, 200, 300, 301, 302, 400, 401] });
    expect(await topMemoryHogs({ ...base, ...fs }, 3)).toEqual([
      { pid: 302, name: "python3", rssBytes: 19_000_000 * 1024, owner: "instance", instance: "dev-a" },
      { pid: 401, name: "claude", rssBytes: 600_000 * 1024, owner: "instance", instance: "web" },
      { pid: 301, name: "claude", rssBytes: 450_000 * 1024, owner: "instance", instance: "dev-a" },
    ]);
  });
  it("the fleet and tmux are named as such; a pane that is no instance, and a process outside every pane, are 'other'", async () => {
    const fs = proc({ ...TREE, 600: ["bash", 4_000, 200], 601: ["vim", 700_000, 600], 700: ["stray", 800_000, 1] }, { inCgroup: [100, 200, 600, 601, 700] });
    const hogs = await topMemoryHogs({ ...base, ...fs, panes: [...PANES, { pid: 600, window: "scratch" }] }, 5);
    expect(hogs.map(h => [h.pid, h.owner, h.instance ?? null])).toEqual([[700, "other", null], [601, "other", null], [100, "fleet", null], [200, "tmux", null], [600, "other", null]]);
  });
  it("#2036 review: a tmux server outside the fleet's cgroup (it outlived a restart into another scope): its panes still count", async () => {
    // The fleet's cgroup holds only the fleet; tmux (orphaned to 1) and every pane, CLI and script are outside it.
    const fs = proc({ ...TREE, 200: ["tmux: server", 9_000, 1] }, { inCgroup: [100] });
    expect((await topMemoryHogs({ ...base, ...fs }, 3)).map(h => [h.pid, h.owner, h.instance ?? null])).toEqual([
      [302, "instance", "dev-a"], [401, "instance", "web"], [301, "instance", "dev-a"],
    ]);
    // tmux inside the cgroup: the cgroup alone (no /proc walk needed), as before.
    const inside = proc(TREE, { inCgroup: [100, 200, 300, 301, 302] });
    expect((await topMemoryHogs({ ...base, ...inside }, 5)).map(h => h.pid)).toEqual([302, 301, 100, 200, 300]);
  });
  it("without a cgroup v2 view: the fleet's and tmux's descendants; a kernel thread (no VmRSS) is skipped", async () => {
    const fs = proc({ ...TREE, 900: ["elsewhere", 9_000_000, 1] }, { cgroup: null });
    const hogs = await topMemoryHogs({ ...base, ...fs }, 10);
    expect(hogs.map(h => h.pid)).toEqual([302, 401, 301, 100, 200, 300, 400]);   // 900 is not the fleet's; 500 has no RSS
  });
  it("a process gone between the list and its read is skipped; limit 0 is nothing; the scan is bounded", async () => {
    const fs = proc(TREE, { inCgroup: [100, 200, 302, 99999] });   // tmux in the cgroup: the cgroup alone is read
    expect((await topMemoryHogs({ ...base, ...fs }, 5)).map(h => h.pid)).toEqual([302, 100, 200]);
    expect(await topMemoryHogs({ ...base, ...fs }, 0)).toEqual([]);
    expect(MEMORY_HOGS_SCAN_MAX).toBeGreaterThanOrEqual(1024);
  });
});

describe("the fleet keeps the largest processes for the log, /health and the dashboard — never chat", () => {
  function fleet(opts: { tmuxSession?: boolean } = {}) {
    const fm = new FleetManager(tmp()) as any;
    fm.fleetConfig = { defaults: {}, instances: { "dev-a": {}, web: {} } };
    const chat = vi.fn(() => true);
    fm.notifyFleetError = chat;
    let level = "normal";
    fm.memoryPressure = { advisoryOnly: () => false, snapshot: () => ({ level }) };
    const frames: any[] = [];
    fm.emitSseEvent = (event: string, data: any) => { if (event === "status") frames.push(data); };
    fm.tmuxSessionEnsured = opts.tmuxSession ?? true;
    const serverPid = vi.spyOn(TmuxManager, "getServerPid").mockResolvedValue(200);
    vi.spyOn(TmuxManager, "listPanePids").mockResolvedValue(PANES);
    const fs = proc(TREE, { inCgroup: [100, 200, 300, 301, 302, 400, 401] });
    const scans = vi.fn((deps: any, limit: number) => topMemoryHogs({ ...deps, ...fs, fleetPid: 100 }, limit));
    fm.memoryHogScan = scans;
    const warn = vi.spyOn(fm.logger, "warn");
    let clock = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const sample = async (l: string) => {
      level = l;
      fm.reportMemoryPressure({ level: l });
      await vi.waitFor(() => expect(fm.memoryTopScan.inFlight).toBe(false));
      await new Promise(r => setImmediate(r));
    };
    const tops = () => warn.mock.calls.filter(c => c[1] === "Host memory pressure — largest processes in the fleet");
    return { fm, chat, frames, scans, warn, tops, serverPid, sample, advance: (min: number) => { clock += min * 60_000; } };
  }
  const TOP3 = [
    { pid: 302, name: "python3", rssBytes: 19_000_000 * 1024, owner: "instance", instance: "dev-a" },
    { pid: 401, name: "claude", rssBytes: 600_000 * 1024, owner: "instance", instance: "web" },
    { pid: 301, name: "claude", rssBytes: 450_000 * 1024, owner: "instance", instance: "dev-a" },
  ];

  it("elevated: logged with the pressure, in /health's hostMemory and the status frame; chat gets nothing", async () => {
    const f = fleet();
    await f.sample("elevated");
    expect(f.tops()).toHaveLength(1);
    expect(f.tops()[0][0]).toMatchObject({ hostMemory: { level: "elevated" }, topProcesses: TOP3 });
    expect(f.fm.getFleetHealth().hostMemory).toMatchObject({ level: "elevated", topProcesses: TOP3 });
    expect(typeof f.fm.getFleetHealth().hostMemory.topProcessesAt).toBe("string");
    expect(f.frames.at(-1)).toMatchObject({ host_memory: "elevated", host_memory_top: TOP3 });
    // The pressure line itself carries the latest list once there is one (the next one due: 10 minutes later).
    f.advance(11); await f.sample("critical");
    const pressure = f.warn.mock.calls.filter(c => c[1] === "Host memory critical — deferring new CLI spawns");
    expect(pressure.at(-1)![0]).toMatchObject({ topProcesses: TOP3 });
    expect(f.chat).not.toHaveBeenCalled();
  });

  it("#2036 review: /health carries the list only at elevated or critical (not a stale one at unknown)", async () => {
    const f = fleet();
    await f.sample("elevated");
    f.fm.memoryPressure = { advisoryOnly: () => false, snapshot: () => ({ level: "unknown" }) };
    expect(f.fm.getFleetHealth().hostMemory.topProcesses).toBeUndefined();
    f.fm.memoryPressure = { advisoryOnly: () => false, snapshot: () => ({ level: "critical" }) };
    expect(f.fm.getFleetHealth().hostMemory.topProcesses).toEqual(TOP3);
  });

  it("normal clears it everywhere (log, /health, dashboard)", async () => {
    const f = fleet();
    await f.sample("elevated");
    await f.sample("normal");
    expect(f.fm.memoryTop).toBeNull();
    expect(f.fm.getFleetHealth().hostMemory.topProcesses).toBeUndefined();
    expect(f.frames.at(-1).host_memory_top).toBeUndefined();
    expect(f.chat).not.toHaveBeenCalled();
  });

  it("damped: a scan at most once a minute, the list logged at most every 10 minutes", async () => {
    const f = fleet();
    await f.sample("elevated"); await f.sample("elevated"); f.advance(0.5); await f.sample("critical");
    expect(f.scans).toHaveBeenCalledTimes(1);
    f.advance(1); await f.sample("critical");
    expect(f.scans).toHaveBeenCalledTimes(2);
    expect(f.tops()).toHaveLength(1);                           // rescanned, not logged again yet
    f.advance(10); await f.sample("critical");
    expect(f.tops()).toHaveLength(2);
    await f.sample("normal"); f.advance(1); await f.sample("elevated");
    expect(f.tops()).toHaveLength(3);                           // a new episode logs its first list
  });

  it("a fleet that never started its tmux session does not ask tmux (tests never touch the live server)", async () => {
    const f = fleet({ tmuxSession: false });
    await f.sample("elevated");
    expect(f.serverPid).not.toHaveBeenCalled();
    expect(f.scans.mock.calls[0][0]).toMatchObject({ tmuxServerPid: null, panes: [] });
  });

  it("pressure that ended while the scan ran keeps nothing; a failing or empty scan keeps nothing and posts nothing", async () => {
    const f = fleet();
    f.fm.memoryHogScan = vi.fn(async () => { f.fm.memoryPressure = { advisoryOnly: () => false, snapshot: () => ({ level: "normal" }) }; return TOP3; });
    await f.sample("elevated");
    expect(f.fm.memoryTop).toBeNull();
    const g = fleet();
    g.fm.memoryHogScan = vi.fn(async () => { throw new Error("proc gone"); });
    await g.sample("critical");
    g.advance(2); g.fm.memoryHogScan = vi.fn(async () => []); await g.sample("critical");
    expect(g.fm.memoryTop).toBeNull();
    expect(g.chat).not.toHaveBeenCalled();
  });
});

describe("the dashboard: the Fleet header's pressure chip names the largest processes", () => {
  it("the status frame's list is kept well-formed (at most 3; anything else dropped)", async () => {
    const { hostMemoryTop } = await import("/assets/app-store.js" as string);
    expect(hostMemoryTop([...TOP_WIRE, TOP_WIRE[0], TOP_WIRE[0]])).toHaveLength(3);
    expect(hostMemoryTop([{ name: "x", pid: "1", rssBytes: 1, owner: "fleet" }, { name: "x", pid: 1, rssBytes: -1, owner: "fleet" },
      { name: "x", pid: 1, rssBytes: 1, owner: "root" }, null, 7])).toEqual([]);
    expect(hostMemoryTop([{ name: "a".repeat(99), pid: 1, rssBytes: 1, owner: "fleet", instance: "ignored" }])).toEqual([{ name: "a".repeat(64), pid: 1, rssBytes: 1, owner: "fleet" }]);
    expect(hostMemoryTop("nope")).toEqual([]);
  });
  it("the text: name, size, and whose", async () => {
    const dom = installDom({});
    try {
      // @ts-expect-error — a JS module of the app, with no types
      const { memoryHogText } = await import("../src/ui/panel-fleet.js");
      (await import("/assets/app-i18n.js" as string)).setLang("en");
      expect(TOP_WIRE.map(memoryHogText)).toEqual(["python3 18.1 GB (dev-a)", "node 176 MB (the fleet)", "tmux: server 9 MB (tmux)"]);
    } finally { dom.restore(); }
  });
});
const TOP_WIRE = [
  { pid: 302, name: "python3", rssBytes: 19_000_000 * 1024, owner: "instance", instance: "dev-a" },
  { pid: 100, name: "node", rssBytes: 180_000 * 1024, owner: "fleet" },
  { pid: 200, name: "tmux: server", rssBytes: 9_000 * 1024, owner: "tmux" },
];

describe("TmuxManager.listPanePids (a private tmux server, never the live one)", () => {
  it("every pane of the session: its shell's pid and its window's name; a missing session is []", async () => {
    const { execFileSync } = await import("node:child_process");
    const SOCK = `agend-test-2015-${process.pid}`;
    TmuxManager.setSocketName(SOCK);
    try {
      execFileSync("tmux", ["-L", SOCK, "new-session", "-d", "-s", "s2015", "-n", "dev-a", "sleep 60"]);
      execFileSync("tmux", ["-L", SOCK, "new-window", "-d", "-t", "s2015", "-n", "web", "sleep 60"]);
      const want = execFileSync("tmux", ["-L", SOCK, "list-panes", "-s", "-t", "s2015", "-F", "#{pane_pid} #{window_name}"], { encoding: "utf8" })
        .trim().split("\n").map(l => { const [pid, window] = l.split(" "); return { pid: Number(pid), window }; });
      expect(await TmuxManager.listPanePids("s2015")).toEqual(want);
      expect(want.map(p => p.window).sort()).toEqual(["dev-a", "web"]);
      expect(await TmuxManager.listPanePids("no-such-session")).toEqual([]);
    } finally {
      try { execFileSync("tmux", ["-L", SOCK, "kill-server"], { stdio: "ignore" }); } catch { /* already gone */ }
      TmuxManager.setSocketName(null);
    }
  });
});

describe("the Fleet page's chip, rendered", () => {
  it("elevated with a list: the chip's text, then 'Largest: …' as text; none without pressure", async () => {
    const { page, settle, h } = await import("./helpers/app-harness.js");
    const base = installDom({ storage: { agend_tour_done: "1" } });
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => "[]" });
    // @ts-expect-error — a JS module of the app, with no types
    const fleetPanel = await import("../src/ui/panel-fleet.js");
    const store: any = await import("/assets/app-store.js" as string);
    base.restore();
    const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/tasks", storage: { agend_tour_done: "1", agend_lang: "en" } });
    try {
      (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => "[]" });
      (await import("/assets/app-i18n.js" as string)).setLang("en");
      store.applyStatus({ instances: [], uptime: 1, host_memory: "elevated", host_memory_top: [...TOP_WIRE, { name: "<b>x</b>", pid: 9, rssBytes: 1, owner: "other" }] });
      await pg.mount(h(fleetPanel.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: "fleet:tasks|1|en" }));
      await settle(4);
      const chip = pg.root.querySelector(".panel-head .host-mem");
      expect(chip.querySelector(".host-mem-top").textContent).toBe("Largest: python3 18.1 GB (dev-a) · node 176 MB (the fleet) · tmux: server 9 MB (tmux)");
      expect(chip.textContent.startsWith("Host memory pressure: elevated — new agents start one at a time, at least 5 s apart")).toBe(true);
      store.applyStatus({ instances: [], uptime: 1, host_memory: null, host_memory_top: TOP_WIRE });
      await settle(4);
      expect(pg.root.querySelector(".panel-head .host-mem")).toBeNull();
    } finally { await pg.unmount(); pg.restore(); }
  });
});
